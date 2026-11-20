import { afterEach, describe, expect, it } from 'vitest';
import { analyze, isTestFile } from '../src/analyze.js';
import { parseDiff } from '../src/diff.js';
import { diffText, mergeBase, showAt } from '../src/git.js';
import { repo, TSCONFIG } from './repo.js';

type Repo = ReturnType<typeof repo>;
let r: Repo | undefined;
afterEach(() => r?.done());

const run = (x: Repo) => {
  const from = mergeBase(x.dir, 'main');
  return analyze({ root: x.dir, files: parseDiff(diffText(x.dir, from)), readBase: (f) => showAt(x.dir, from, f) });
};

const LOGIN = `import { normalize } from './util/strings';
import { audit } from './audit';

// FDD:LOGIC-AUTH-LOGIN-001 r9 Sign in
export function login(email: string, password: string) {
  // FDD:NODE-AUTH-LOGIN-003 Inputs valid?
  if (!email || !password) return { status: 400 };
  // FDD:NODE-AUTH-LOGIN-007 Find the user
  const user = { email: normalize(email) };
  audit('login', user.email);
  return { status: 200, user };
}
`;
const STRINGS = `export function normalize(s: string) {
  return trim(s).toLowerCase();
}
export function trim(s: string) {
  return s.trim();
}
export function unused(s: string) {
  return s + '!';
}
`;
const AUDIT = `export function audit(what: string, who: string) {
  return \`\${what}:\${who}\`;
}
`;
const base = () => ({ 'tsconfig.json': TSCONFIG, 'src/login.ts': LOGIN, 'src/util/strings.ts': STRINGS, 'src/audit.ts': AUDIT });

describe('where a TypeScript change lands', () => {
  it('a line inside an anchored function: that logic, the step it is under, sure', () => {
    r = repo(base());
    r.write('src/login.ts', LOGIN.replace("{ email: normalize(email) }", "{ email: normalize(email), at: Date.now() }"));
    const f = run(r);
    expect(f.reached).toEqual([expect.objectContaining({ ref: 'LOGIC-AUTH-LOGIN-001', revision: 9, steps: ['NODE-AUTH-LOGIN-007'], how: 'sure' })]);
    expect(f.unmapped).toEqual([]);
  });

  it('a helper two calls away: followed back to the anchored function, likely, with the path', () => {
    r = repo(base());
    r.write('src/util/strings.ts', STRINGS.replace('return s.trim();', 'return s.trim().normalize();'));
    const f = run(r);
    expect(f.reached).toHaveLength(1);
    expect(f.reached[0]).toMatchObject({ ref: 'LOGIC-AUTH-LOGIN-001', how: 'likely', steps: [] });
    expect(f.reached[0].via.map((h) => h.name)).toEqual(['trim', 'normalize', 'login']);
    expect(f.reached[0].via[0].file).toBe('src/util/strings.ts');
  });

  it('code nobody calls is not on the map, with its lines', () => {
    r = repo(base());
    r.write('src/util/strings.ts', STRINGS.replace("return s + '!';", "return s + '?';"));
    const f = run(r);
    expect(f.reached).toEqual([]);
    expect(f.unmapped).toEqual([{ file: 'src/util/strings.ts', lines: '8' }]);
  });

  it('a test that calls the changed code is a test to run, not a way onto the map', () => {
    r = repo({ ...base(), 'src/util/strings.spec.ts': `import { unused } from './strings';\nexport const t = () => unused('a');\n` });
    r.write('src/util/strings.ts', STRINGS.replace("return s + '!';", "return s + '?';"));
    const f = run(r);
    expect(f.tests).toEqual(['src/util/strings.spec.ts']);
    expect(f.reached).toEqual([]);
  });

  it('comments and blank lines only: nothing runs differently', () => {
    r = repo(base());
    r.write('src/audit.ts', `// who did what\n${AUDIT}\n`);
    const f = run(r);
    expect(f.commentsOnly).toEqual(['src/audit.ts']);
    expect(f.reached).toEqual([]);
    expect(f.unmapped).toEqual([]);
  });

  it('an Express route: a handler written in place, and one passed by name', () => {
    r = repo({
      ...base(),
      'src/server.ts': `declare const app: any;\nimport { getOrder } from './orders';\napp.get('/api/orders/:id', getOrder);\napp.post('/api/orders', (req: any, res: any) => {\n  res.json({ ok: true });\n});\n`,
      'src/orders.ts': `export function getOrder(req: any, res: any) {\n  res.json({ id: req.params.id });\n}\n`,
    });
    r.write('src/server.ts', `declare const app: any;\nimport { getOrder } from './orders';\napp.get('/api/orders/:id', getOrder);\napp.post('/api/orders', (req: any, res: any) => {\n  res.status(201).json({ ok: true });\n});\n`);
    r.write('src/orders.ts', `export function getOrder(req: any, res: any) {\n  res.json({ id: req.params.id, v: 2 });\n}\n`);
    const f = run(r);
    expect(f.routes.map((x) => `${x.method} ${x.path}`).sort()).toEqual(['GET /api/orders/:id', 'POST /api/orders']);
  });

  it('a NestJS controller method: the controller prefix and the method decorator', () => {
    const ctl = (body: string) => `const Controller = (p?: string): ClassDecorator => () => undefined;\nconst Get = (p?: string): MethodDecorator => () => undefined;\n@Controller('api/users')\nexport class UsersController {\n  @Get(':id')\n  one() {\n    ${body}\n  }\n}\n`;
    r = repo({ ...base(), 'src/users.controller.ts': ctl('return 1;') });
    r.write('src/users.controller.ts', ctl('return 2;'));
    expect(run(r).routes.map((x) => `${x.method} ${x.path}`)).toEqual(['GET /api/users/:id']);
  });

  it('a generated file says its logic on its first line', () => {
    const gen = `// Generated by Rabbinatix · logic LOGIC-ORDERS-PLACE-002 v1.3.0 (r12) · do not edit by hand\n// FDD:NODE-ORDERS-PLACE-004 Check stock\nexport const place = () => 1;\n`;
    r = repo({ ...base(), 'src/gen/place.ts': gen });
    r.write('src/gen/place.ts', gen.replace('=> 1', '=> 2'));
    expect(run(r).reached).toEqual([expect.objectContaining({ ref: 'LOGIC-ORDERS-PLACE-002', revision: 12, steps: ['NODE-ORDERS-PLACE-004'], how: 'sure' })]);
  });
});

describe('a monorepo', () => {
  it('each package is read with its own tsconfig.json', () => {
    const files = Object.fromEntries(Object.entries(base()).map(([k, v]) => [`services/auth/${k}`, v]));
    r = repo({ ...files, 'web/tsconfig.json': TSCONFIG, 'web/src/app.ts': 'export const app = 1;\n' });
    r.write('services/auth/src/util/strings.ts', STRINGS.replace('return s.trim();', 'return s.trim().normalize();'));
    r.write('web/src/app.ts', 'export const app = 2;\n');
    const f = run(r);
    expect(f.reached.map((x) => x.ref)).toEqual(['LOGIC-AUTH-LOGIN-001']);
    expect(f.unmapped).toEqual([{ file: 'web/src/app.ts', lines: '1' }]);
    expect(f.notes).toEqual([]);
  });
});

describe('other files', () => {
  it('Python: the anchor above the changed line', () => {
    const py = `# FDD:LOGIC-BILL-CHARGE-001 r4 Charge a card\ndef charge(card):\n    # FDD:NODE-BILL-CHARGE-002 Call the bank\n    return bank(card)\n`;
    r = repo({ 'billing/charge.py': py, 'billing/util.py': 'def x():\n    return 1\n' });
    r.write('billing/charge.py', py.replace('bank(card)', 'bank(card, retries=2)'));
    r.write('billing/util.py', 'def x():\n    return 2\n');
    const f = run(r);
    expect(f.reached).toEqual([expect.objectContaining({ ref: 'LOGIC-BILL-CHARGE-001', revision: 4, steps: ['NODE-BILL-CHARGE-002'] })]);
    expect(f.unmapped).toEqual([{ file: 'billing/util.py', lines: '2' }]);
  });

  it('SQL: anchors in -- comments', () => {
    const sql = `-- FDD:LOGIC-ORDERS-REPORT-001 r2 Monthly report\nSELECT id,\n  -- FDD:NODE-ORDERS-REPORT-003 Sum the totals\n  SUM(total) FROM orders GROUP BY id;\n`;
    r = repo({ 'db/report.sql': sql });
    r.write('db/report.sql', sql.replace('SUM(total)', 'SUM(total_cents)'));
    expect(run(r).reached).toEqual([expect.objectContaining({ ref: 'LOGIC-ORDERS-REPORT-001', revision: 2, steps: ['NODE-ORDERS-REPORT-003'] })]);
  });

  it('generated files in every header form: with a version, with unsaved edits, with no version', () => {
    const cs = (head: string, body: string) => `${head}\n// FDD:NODE-ORDERS-PLACE-004 Check stock\npublic static class Place { public static int Run() => ${body}; }\n`;
    const py = (head: string, body: string) => `${head}\n# FDD:NODE-AUTH-LOGIN-007 Find the user\ndef run():\n    return ${body}\n`;
    const forms = {
      'gen/Place.cs': cs('// Generated by Rabbinatix · logic LOGIC-ORDERS-PLACE-002 r12 · codegen 1.4.0 · sha256:abc123 · do not edit', '1'),
      'gen/login.py': py('# Generated by Rabbinatix · logic LOGIC-AUTH-LOGIN-001 v1.0.0 (r3 + unsaved) · codegen 1.4.0 · sha256:abc123 · do not edit', '1'),
    };
    r = repo(forms);
    r.write('gen/Place.cs', forms['gen/Place.cs'].replace('=> 1', '=> 2'));
    r.write('gen/login.py', forms['gen/login.py'].replace('return 1', 'return 2'));
    const f = run(r);
    expect(f.reached.map((x) => [x.ref, x.revision, x.steps]).sort()).toEqual([['LOGIC-AUTH-LOGIN-001', 3, ['NODE-AUTH-LOGIN-007']], ['LOGIC-ORDERS-PLACE-002', 12, ['NODE-ORDERS-PLACE-004']]]);
    expect(f.unmapped).toEqual([]);
  });

  it('Dart, C++ and other languages are code: read for anchors, not treated as configuration', () => {
    const dart = `// FDD:LOGIC-APP-CART-001 r1 Cart\nint total() {\n  return 1;\n}\n`;
    r = repo({ 'app/lib/cart.dart': dart, 'native/x.cpp': 'int x() { return 1; }\n' });
    r.write('app/lib/cart.dart', dart.replace('return 1', 'return 2'));
    r.write('native/x.cpp', 'int x() { return 2; }\n');
    const f = run(r);
    expect(f.reached.map((x) => x.ref)).toEqual(['LOGIC-APP-CART-001']);
    expect(f.unmapped).toEqual([{ file: 'native/x.cpp', lines: '1' }]);
  });

  it('a deleted file: the logic its anchors named', () => {
    r = repo(base());
    r.remove('src/login.ts');
    expect(run(r).reached.map((x) => x.ref)).toEqual(['LOGIC-AUTH-LOGIN-001']);
  });

  it('docs and lock files are left out; other configuration is not on the map', () => {
    r = repo({ 'README.md': 'a', 'package-lock.json': '{}', 'config/app.yaml': 'retries: 1\n' });
    r.write('README.md', 'b');
    r.write('package-lock.json', '{"a":1}');
    r.write('config/app.yaml', 'retries: 2\n');
    const f = run(r);
    expect(f.ignored.sort()).toEqual(['README.md', 'package-lock.json']);
    expect(f.unmapped).toEqual([{ file: 'config/app.yaml', lines: '1' }]);
  });

  it('an OpenAPI file: the operations it adds, removes and changes, through $refs', () => {
    const spec = (userProps: string, extra = '') => `openapi: 3.0.0\ninfo: { title: x, version: '1' }\npaths:\n  /users/{id}:\n    get:\n      responses:\n        '200':\n          content:\n            application/json:\n              schema: { $ref: '#/components/schemas/User' }\n  /health:\n    get:\n      responses: { '200': { description: ok } }\n${extra}components:\n  schemas:\n    User:\n      type: object\n      properties: ${userProps}\n`;
    r = repo({ 'api/openapi.yaml': spec('{ id: { type: string }, total: { type: number } }') });
    r.write('api/openapi.yaml', spec('{ id: { type: string }, total: { type: string } }', `  /orders:\n    post:\n      responses: { '201': { description: made } }\n`).replace(/  \/health:\n    get:\n      responses: \{ '200': \{ description: ok \} \}\n/, ''));
    const f = run(r);
    expect(f.specs.map((s) => `${s.change} ${s.method} ${s.path}`).sort()).toEqual(['added POST /orders', 'changed GET /users/{id}', 'removed GET /health']);
  });
});

describe('API routes in .NET, Java and Python', () => {
  const CTL = (body: string) => `[ApiController]\n[Route("api/v1/orders")]\npublic class OrdersController : ControllerBase\n{\n    [HttpPost]\n    public IActionResult Create(NewOrder o)\n    {\n        ${body}\n    }\n\n    private static int Round(int x) { return x; }\n}\n`;

  it('a changed ASP.NET action is its API; a changed private helper in the same file is not on the map', () => {
    r = repo({ 'Orders/OrdersController.cs': CTL('return Ok(o);') });
    r.write('Orders/OrdersController.cs', CTL('return Created("", o);').replace('{ return x; }', '{ return x + 1; }'));
    const f = run(r);
    expect(f.routes.map((x) => `${x.method} ${x.path} ${x.via[0].name}`)).toEqual(['POST /api/v1/orders OrdersController.Create']);
    expect(f.unmapped).toEqual([{ file: 'Orders/OrdersController.cs', lines: '11' }]);
  });

  it('a logic comment wins over the route: the change is placed in the logic', () => {
    const body = (v: string) => `// FDD:LOGIC-ORDER-CREATE-001 r1 Place an order\n        return Ok(${v});`;
    r = repo({ 'Orders/OrdersController.cs': CTL(body('o')) });
    r.write('Orders/OrdersController.cs', CTL(body('o.Id')));
    const f = run(r);
    expect(f.reached.map((x) => x.ref)).toEqual(['LOGIC-ORDER-CREATE-001']);
    expect(f.routes).toEqual([]);
  });

  it('FastAPI: a changed handler body is its route', () => {
    const app = (v: string) => `router = APIRouter(prefix="/api/v1/users")\n\n@router.get("/{user_id}")\nasync def get_user(user_id: str):\n    return ${v}\n`;
    r = repo({ 'svc/users.py': app('repo.get(user_id)') });
    r.write('svc/users.py', app('repo.get(user_id.lower())'));
    expect(run(r).routes.map((x) => `${x.method} ${x.path}`)).toEqual(['GET /api/v1/users/{user_id}']);
  });

  it('a removed Spring controller: each API it answered', () => {
    r = repo({ 'src/main/java/acme/CartController.java': `@RestController\n@RequestMapping("/carts")\npublic class CartController {\n    @GetMapping("/{id}")\n    public Cart get(@PathVariable String id) { return carts.get(id); }\n    @DeleteMapping("/{id}")\n    public void drop(@PathVariable String id) { carts.drop(id); }\n}\n` });
    r.remove('src/main/java/acme/CartController.java');
    const f = run(r);
    expect(f.routes.map((x) => `${x.method} ${x.path}`)).toEqual(['GET /carts/{id}', 'DELETE /carts/{id}']);
    expect(f.unmapped).toEqual([]);
  });

  it('tests in every language are tests, not code off the map', () => {
    for (const t of ['tests/OrdersControllerTests.cs', 'Orders.Tests/OrderTests.cs', 'src/test/java/acme/UserControllerTest.java', 'src/test/kotlin/OrderIT.java', 'tests/test_orders.py', 'app/orders_test.py', 'pkg/order_test.go', 'spec/order_spec.rb', 'src/x.spec.ts'])
      expect(isTestFile(t), t).toBe(true);
    for (const c of ['src/Latest.cs', 'src/main/java/acme/Contest.java', 'app/orders.py', 'src/attestation.ts'])
      expect(isTestFile(c), c).toBe(false);
  });
});

describe('API routes whose handler is a function named elsewhere (languages-plan.md § Final scope)', () => {
  const via = (f: ReturnType<typeof run>) => f.routes.map((x) => `${x.method} ${x.path} ← ${x.via.map((v) => `${v.file}:${v.line} ${v.name}`).join(' ← ')}`);

  it('Go (gin): a changed line in a handler in handlers.go is the route registered in routes.go', () => {
    const h = (v: string) => `package api\n\nfunc (h *Handlers) GetOrder(c *gin.Context) {\n\tc.JSON(200, ${v})\n}\n\nfunc unused() {\n\tprintln("x")\n}\n`;
    r = repo({ 'api/routes.go': 'package api\n\nfunc Routes(r *gin.Engine, h *Handlers) {\n\tv1 := r.Group("/api/v1")\n\tv1.GET("/orders/:id", h.GetOrder)\n}\n', 'api/handlers.go': h('order') });
    r.write('api/handlers.go', h('order.Public()').replace('println("x")', 'println("y")'));
    const f = run(r);
    expect(via(f)).toEqual(['GET /api/v1/orders/{id} ← api/handlers.go:4 Handlers.GetOrder ← api/routes.go:5 GET /api/v1/orders/{id}']);
    expect(f.unmapped).toEqual([{ file: 'api/handlers.go', lines: '8' }]);
  });

  it('Rails: a controller action is each route routes.rb sends to it', () => {
    const ctl = (v: string) => `class OrdersController < ApplicationController\n  def show\n    render json: ${v}\n  end\nend\n`;
    r = repo({ 'config/routes.rb': 'Rails.application.routes.draw do\n  resources :orders, only: [:show, :update]\nend\n', 'app/controllers/orders_controller.rb': ctl('Order.find(params[:id])') });
    r.write('app/controllers/orders_controller.rb', ctl('Order.find(params[:id]).as_json'));
    expect(run(r).routes.map((x) => `${x.method} ${x.path}`)).toEqual(['GET /orders/{id}']);
  });

  it('Laravel: a controller method named by routes/api.php', () => {
    const ctl = (v: string) => `<?php\nclass OrderController extends Controller\n{\n    public function store(Request $r)\n    {\n        return ${v};\n    }\n}\n`;
    r = repo({ 'routes/api.php': "<?php\nRoute::post('/orders', [OrderController::class, 'store']);\n", 'app/Http/Controllers/OrderController.php': ctl('1') });
    r.write('app/Http/Controllers/OrderController.php', ctl('2'));
    expect(run(r).routes.map((x) => `${x.method} ${x.path}`)).toEqual(['POST /api/orders']);
  });

  it('Django: a view under an include() prefix; a class-based view answers each method on its path', () => {
    const views = (v: string) => `class ReportView(View):\n    def get(self, request, year):\n        return JsonResponse(${v})\n\ndef order_detail(request, pk):\n    return JsonResponse({})\n`;
    r = repo({
      'project/urls.py': "urlpatterns = [\n    path('api/', include('shop.urls')),\n]\n",
      'shop/urls.py': "urlpatterns = [\n    path('reports/<int:year>/', ReportView.as_view()),\n    path('orders/<int:pk>/', views.order_detail),\n]\n",
      'shop/views.py': views('{}'),
    });
    r.write('shop/views.py', views('{"year": year}'));
    expect(run(r).routes.map((x) => `${x.method} ${x.path}`)).toEqual(['ALL /api/reports/{year}']);
  });

  it('axum: a handler in another module', () => {
    const h = (v: string) => `pub async fn show_order(Path(id): Path<u32>) -> Json<u32> {\n    Json(${v})\n}\n`;
    r = repo({ 'src/main.rs': 'let app = Router::new().route("/orders/:id", get(handlers::show_order));\n', 'src/handlers.rs': h('id') });
    r.write('src/handlers.rs', h('id + 1'));
    expect(run(r).routes.map((x) => `${x.method} ${x.path}`)).toEqual(['GET /orders/{id}']);
  });

  it('Next.js: a route handler file and a pages/api route; Fastify route options', () => {
    const next = (v: string) => `export async function GET(req: Request, { params }: { params: { id: string } }) {\n  return Response.json(${v});\n}\n`;
    const pages = (v: string) => `export default function handler(req: any, res: any) {\n  res.status(200).json(${v});\n}\n`;
    const fast = (v: string) => `export function routes(fastify: any) {\n  fastify.route({ method: ['POST'], url: '/carts', handler: async () => ${v} });\n}\n`;
    r = repo({ 'tsconfig.json': TSCONFIG, 'src/app/(shop)/orders/[id]/route.ts': next('1'), 'src/pages/api/users/[id].ts': pages('1'), 'src/server.ts': fast('1') });
    r.write('src/app/(shop)/orders/[id]/route.ts', next('2'));
    r.write('src/pages/api/users/[id].ts', pages('2'));
    r.write('src/server.ts', fast('2'));
    expect(run(r).routes.map((x) => `${x.method} ${x.path}`).sort()).toEqual(['ALL /api/users/{id}', 'GET /orders/{id}', 'POST /carts']);
  });
});

describe('API calls the change makes (calls-text.ts)', () => {
  it('a changed fetch, and a changed line in the function that makes a call', () => {
    const src = (v: string, m: string) => `export async function cancel(id: string) {\n  const reason = ${v};\n  return fetch(\`\${API}/orders/\${id}/cancel\`, { method: '${m}', body: reason });\n}\n`;
    r = repo({ 'tsconfig.json': TSCONFIG, 'src/orders.ts': src("'x'", 'POST') });
    r.write('src/orders.ts', src("'y'", 'PUT'));
    const f = run(r);
    expect(f.calls.map((c) => `${c.method} ${c.path} ${c.via[0].line}`)).toEqual(['PUT /orders/{}/cancel 2']);
    expect(f.unmapped).toEqual([]);
  });

  it('Android: a repository calling a Retrofit interface method declared in another file (Kotlin calling Java)', () => {
    const repoKt = (v: string) => `class OrderRepository(private val api: OrdersApi) {\n    suspend fun load(id: String): Order {\n        return api.order(${v})\n    }\n}\n`;
    r = repo({
      'app/src/main/java/acme/OrdersApi.java': 'public interface OrdersApi {\n    @GET("orders/{id}")\n    Call<Order> order(@Path("id") String id);\n}\n',
      'app/src/main/java/acme/OrderRepository.kt': repoKt('id'),
    });
    r.write('app/src/main/java/acme/OrderRepository.kt', repoKt('id.trim()'));
    const f = run(r);
    expect(f.calls.map((c) => `${c.method} ${c.path} ← ${c.via.map((v) => `${v.file.split('/').pop()}:${v.line}`).join(' ← ')}`)).toEqual(['GET /orders/{} ← OrderRepository.kt:3 ← OrdersApi.java:2']);
    expect(f.unmapped).toEqual([]);
  });

  it('Swift: a changed line in the function building a URLRequest', () => {
    const swift = (v: string) => `final class OrdersClient {\n    func cancel(_ id: String) async throws {\n        var request = URLRequest(url: URL(string: "\\(base)/orders/\\(id)/cancel")!)\n        request.httpMethod = "POST"\n        request.timeoutInterval = ${v}\n        _ = try await URLSession.shared.data(for: request)\n    }\n}\n`;
    r = repo({ 'Sources/App/OrdersClient.swift': swift('10') });
    r.write('Sources/App/OrdersClient.swift', swift('30'));
    expect(run(r).calls.map((c) => `${c.method} ${c.path} ${c.via[0].name}`)).toEqual(['POST /orders/{}/cancel OrdersClient.cancel → URLRequest']);
  });
});
