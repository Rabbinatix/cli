import { describe, expect, it } from 'vitest';
import { cleanPath, handlersAt, textHandlers } from '../src/routes-text.js';

const routes = (file: string, src: string) => textHandlers(file, src).map((h) => `${h.method} ${h.path} ${h.name}`);
const lineOf = (src: string, needle: string) => src.split('\n').findIndex((l) => l.includes(needle)) + 1;

describe('ASP.NET', () => {
  const ctl = `using Microsoft.AspNetCore.Mvc;

[ApiController]
[Route("api/v1/[controller]")]
public class OrdersController : ControllerBase
{
    [HttpGet("{id:int}")]
    public IActionResult Get(int id)
    {
        if (id < 0) { return BadRequest(); }
        return Ok(new { id });
    }

    [HttpPost]
    [Authorize]
    public async Task<IActionResult> Create(
        [FromBody] NewOrder order)
    {
        return Created("", order);
    }

    [HttpDelete("/admin/orders/{id}")]
    public IActionResult Remove(int id) => NoContent();

    private int Helper() { return 1; }
}
`;
  it('controller routes: the class prefix, [controller], constraints dropped, an absolute route kept', () => {
    expect(routes('OrdersController.cs', ctl)).toEqual([
      'GET /api/v1/Orders/{id} OrdersController.Get',
      'POST /api/v1/Orders OrdersController.Create',
      'DELETE /admin/orders/{id} OrdersController.Remove',
    ]);
  });
  it('a line belongs to the method it is in; a private helper is no route', () => {
    const hs = textHandlers('OrdersController.cs', ctl);
    expect(handlersAt(hs, lineOf(ctl, 'BadRequest')).map((h) => h.name)).toEqual(['OrdersController.Get']);
    expect(handlersAt(hs, lineOf(ctl, 'Created(')).map((h) => h.name)).toEqual(['OrdersController.Create']);
    expect(handlersAt(hs, lineOf(ctl, 'NoContent')).map((h) => h.name)).toEqual(['OrdersController.Remove']);
    expect(handlersAt(hs, lineOf(ctl, 'Helper'))).toEqual([]);
  });
  it('minimal APIs, with MapGroup prefixes', () => {
    const src = `var app = builder.Build();
var api = app.MapGroup("/api/v1");
var orders = api.MapGroup("orders");
orders.MapGet("/{id}", (int id) =>
{
    return Results.Ok(id);
});
app.MapPost("/login", Login);
`;
    expect(routes('Program.cs', src).map((r) => r.split(' ').slice(0, 2).join(' '))).toEqual(['GET /api/v1/orders/{id}', 'POST /login']);
    expect(handlersAt(textHandlers('Program.cs', src), lineOf(src, 'Results.Ok')).map((h) => h.path)).toEqual(['/api/v1/orders/{id}']);
  });
});

describe('Spring and JAX-RS', () => {
  it('Spring: class @RequestMapping, @GetMapping, @RequestMapping(method = …), value = …', () => {
    const src = `@RestController
@RequestMapping("/api/v1/users")
public class UserController {

    @GetMapping("/{userId}")
    public User get(@PathVariable String userId) {
        return service.get(userId);
    }

    @RequestMapping(
        value = "/{userId}",
        method = { RequestMethod.PUT, RequestMethod.PATCH })
    public User put(@PathVariable String userId, @RequestBody User u) {
        return service.save(u);
    }

    @PostMapping
    public User create(@RequestBody User u) { return service.save(u); }
}
`;
    expect(routes('UserController.java', src)).toEqual([
      'GET /api/v1/users/{userId} UserController.get',
      'PUT /api/v1/users/{userId} UserController.put',
      'PATCH /api/v1/users/{userId} UserController.put',
      'POST /api/v1/users UserController.create',
    ]);
    expect(handlersAt(textHandlers('UserController.java', src), lineOf(src, 'service.get')).map((h) => `${h.method} ${h.path}`)).toEqual(['GET /api/v1/users/{userId}']);
  });
  it('Kotlin', () => {
    const src = `@RestController
@RequestMapping("/orders")
class OrderController(private val svc: OrderService) {
    @GetMapping("/{id}")
    fun get(@PathVariable id: Long): Order {
        return svc.get(id)
    }
}
`;
    expect(routes('OrderController.kt', src)).toEqual(['GET /orders/{id} OrderController.get']);
  });
  it('JAX-RS: @Path on the class and the method, @GET', () => {
    const src = `@Path("/carts")
public class CartResource {
    @GET
    @Path("{id}")
    public Cart get(@PathParam("id") String id) {
        return carts.find(id);
    }
}
`;
    expect(routes('CartResource.java', src)).toEqual(['GET /carts/{id} CartResource.get']);
  });
});

describe('Python', () => {
  it('FastAPI: @app.get, an APIRouter prefix, async def; the body by indentation', () => {
    const src = `from fastapi import APIRouter, FastAPI

app = FastAPI()
router = APIRouter(prefix="/api/v1/orders", tags=["orders"])

@router.get("/{order_id}")
async def get_order(order_id: int):
    order = await repo.get(order_id)
    return order

@app.post("/login")
def login(body: Login):
    return auth(body)

def helper():
    return 1
`;
    expect(routes('main.py', src)).toEqual(['GET /api/v1/orders/{order_id} get_order', 'POST /login login']);
    const hs = textHandlers('main.py', src);
    expect(handlersAt(hs, lineOf(src, 'repo.get')).map((h) => h.name)).toEqual(['get_order']);
    expect(handlersAt(hs, lineOf(src, 'return 1'))).toEqual([]);
  });
  it('Flask: @app.route with methods, a Blueprint url_prefix, <int:id>', () => {
    const src = `bp = Blueprint("users", __name__, url_prefix="/users")

@bp.route("/<int:user_id>", methods=["GET", "PUT"])
def user(user_id):
    return jsonify(find(user_id))
`;
    expect(routes('views.py', src)).toEqual(['GET /users/{user_id} user', 'PUT /users/{user_id} user']);
  });
});

describe('paths', () => {
  it('parameters in every framework’s form become {name}', () => {
    expect(cleanPath('/a/{id:int}/{slug?}/{*rest}/<int:x>/<y>')).toBe('/a/{id}/{slug}/{rest}/{x}/{y}');
    expect(cleanPath('/orders/:id/lines/:line_id')).toBe('/orders/{id}/lines/{line_id}');
    expect(cleanPath('/items:batch')).toBe('/items:batch');
  });
});

// ---------- more frameworks (languages-plan.md § Final scope) ----------
import { functionAt, functionsIn, refMatches, textIncludes } from '../src/routes-text.js';

const refs = (file: string, src: string) => textHandlers(file, src).map((h) => `${h.method} ${h.path} → ${h.ref ? `${h.ref.owner ? `${h.ref.owner}.` : ''}${h.ref.name}` : `(in place ${h.start}-${h.end})`}`);

describe('Go', () => {
  it('gin and echo groups, handlers named or written in place', () => {
    const src = `package main

func routes(r *gin.Engine, h *Handlers) {
	v1 := r.Group("/api/v1")
	v1.GET("/orders/:id", h.GetOrder)
	v1.POST("/orders", handlers.CreateOrder(svc))
	admin := v1.Group("/admin")
	admin.DELETE("/orders/:id", func(c *gin.Context) {
		c.Status(204)
	})
	cache.Get("key", 5) // not a route
}`;
    expect(refs('routes.go', src)).toEqual([
      'GET /api/v1/orders/{id} → GetOrder',
      'POST /api/v1/orders → CreateOrder',
      'DELETE /api/v1/admin/orders/{id} → (in place 8-10)',
    ]);
  });

  it('net/http patterns with a method, gorilla/mux .Methods, chi Route blocks, fiber', () => {
    expect(refs('main.go', `mux.HandleFunc("GET /orders/{id}", getOrder)\nhttp.HandleFunc("/health", health)\nr.HandleFunc("/items/{id}", s.item).Methods("PUT", "PATCH")`)).toEqual([
      'GET /orders/{id} → getOrder', 'ALL /health → health', 'PUT /items/{id} → item', 'PATCH /items/{id} → item',
    ]);
    const chi = `r.Route("/api", func(r chi.Router) {
	r.Route("/orders", func(r chi.Router) {
		r.Get("/", listOrders)
		r.Post("/{id}/cancel", cancelOrder)
	})
})
r.Get("/ping", ping)`;
    expect(refs('router.go', chi)).toEqual(['GET /api/orders → listOrders', 'POST /api/orders/{id}/cancel → cancelOrder', 'GET /ping → ping']);
    expect(refs('app.go', `api := app.Group("/api")\napi.Get("/users/:id", handlers.GetUser)`)).toEqual(['GET /api/users/{id} → GetUser']);
  });

  it('the functions a changed line can be in, with their receiver type', () => {
    const src = `package h\n\nfunc (h *Handlers) GetOrder(c *gin.Context) {\n\tid := c.Param("id")\n\t_ = id\n}\n\nfunc helper() int {\n\treturn 1\n}\n`;
    const fns = functionsIn('h.go', src);
    expect(fns.map((f) => `${f.owner ?? ''}.${f.name} ${f.start}-${f.end}`)).toEqual(['Handlers.GetOrder 3-6', '.helper 8-10']);
    expect(functionAt(fns, 4)?.name).toBe('GetOrder');
    expect(refMatches({ name: 'GetOrder' }, fns[0])).toBe(true);
  });
});

describe('Ruby', () => {
  it('Rails routes.rb: resources (only, nested), resource, namespace, scope, get … to:, root', () => {
    const src = `Rails.application.routes.draw do
  root "pages#home"
  namespace :api do
    scope "/v1" do
      resources :orders, only: [:index, :show] do
        resources :lines, only: :create
      end
      resource :profile, only: [:show]
      get "reports/:year", to: "reports#show"
      match "search", to: "search#run", via: [:get, :post]
    end
  end
end`;
    expect(refs('config/routes.rb', src)).toEqual([
      'GET / → PagesController.home',
      'GET /api/v1/orders → OrdersController.index',
      'GET /api/v1/orders/{id} → OrdersController.show',
      'POST /api/v1/orders/{order_id}/lines → LinesController.create',
      'GET /api/v1/profile → ProfilesController.show',
      'GET /api/v1/reports/{year} → ReportsController.show',
      'GET /api/v1/search → SearchController.run',
      'POST /api/v1/search → SearchController.run',
    ]);
  });

  it('a Rails controller action and its class; Sinatra blocks', () => {
    const ctl = `module Api\n  class OrdersController < ApplicationController\n    def show\n      render json: Order.find(params[:id])\n    end\n\n    private\n\n    def helper?\n      true\n    end\n  end\nend\n`;
    expect(functionsIn('app/controllers/api/orders_controller.rb', ctl).map((f) => `${f.owner}.${f.name} ${f.start}-${f.end}`)).toEqual(['OrdersController.show 3-5', 'OrdersController.helper? 9-11']);
    expect(refs('app.rb', `get '/orders/:id' do\n  Order.find(params[:id]).to_json\nend\n\npost('/orders') do\n  201\nend`)).toEqual(['GET /orders/{id} → (in place 1-3)', 'POST /orders → (in place 5-7)']);
  });
});

describe('PHP', () => {
  it('Laravel: routes/api.php is under /api, prefix groups, controller arrays and strings, resources', () => {
    const src = `<?php
use App\\Http\\Controllers\\OrderController;

Route::get('/orders/{id}', [OrderController::class, 'show']);
Route::prefix('v1')->group(function () {
    Route::post('/orders', 'OrderController@store');
    Route::apiResource('invoices', InvoiceController::class)->only(['index', 'show']);
    Route::match(['get', 'post'], '/search', [SearchController::class, 'run']);
});
Route::get('/ping', function () {
    return 'pong';
});`;
    expect(refs('routes/api.php', src)).toEqual([
      'GET /api/orders/{id} → OrderController.show',
      'POST /api/v1/orders → OrderController.store',
      'GET /api/v1/invoices → InvoiceController.index',
      'GET /api/v1/invoices/{invoice} → InvoiceController.show',
      'GET /api/v1/search → SearchController.run',
      'POST /api/v1/search → SearchController.run',
      'GET /api/ping → (in place 10-12)',
    ]);
    expect(refs('routes/web.php', "Route::get('/', [HomeController::class, 'index']);")).toEqual(['GET / → HomeController.index']);
  });

  it('Symfony #[Route] on the class and the method; the controller method found by its class', () => {
    const src = `<?php
#[Route('/api/orders')]
class OrderController extends AbstractController
{
    #[Route('/{id}', name: 'order_show', methods: ['GET'])]
    public function show(int $id): Response
    {
        return $this->json(['id' => $id]);
    }

    #[Route('', methods: ['POST', 'PUT'])]
    public function save(): Response { return $this->json([]); }
}`;
    expect(routes('src/Controller/OrderController.php', src)).toEqual([
      'GET /api/orders/{id} OrderController.show',
      'POST /api/orders OrderController.save',
      'PUT /api/orders OrderController.save',
    ]);
    expect(functionsIn('x.php', src).map((f) => `${f.owner}.${f.name}`)).toEqual(['OrderController.show', 'OrderController.save']);
  });
});

describe('Rust', () => {
  it('axum .route with method chains; actix and Rocket attributes; actix web::resource', () => {
    const axum = `let app = Router::new()
    .route("/orders/:id", get(handlers::show_order).delete(remove_order))
    .route("/orders", post(create_order));`;
    expect(refs('src/main.rs', axum)).toEqual(['GET /orders/{id} → show_order', 'DELETE /orders/{id} → remove_order', 'POST /orders → create_order']);
    const actix = `#[get("/orders/{id}")]
async fn show(path: web::Path<u32>) -> impl Responder {
    HttpResponse::Ok().finish()
}

#[route("/search", method = "GET", method = "POST")]
async fn search() -> impl Responder { HttpResponse::Ok() }

#[post("/carts/<id>/items")]
fn add_item(id: u32) -> &'static str {
    "ok"
}

App::new().service(web::resource("/users/{id}").route(web::put().to(update_user)))`;
    expect(refs('src/api.rs', actix)).toEqual([
      'GET /orders/{id} → (in place 1-4)', 'GET /search → (in place 6-7)', 'POST /search → (in place 6-7)', 'POST /carts/{id}/items → (in place 9-12)', 'PUT /users/{id} → update_user',
    ]);
    const fns = functionsIn('src/h.rs', 'impl Store {\n    pub async fn show_order(&self) -> u32 {\n        1\n    }\n}\n\nfn remove_order() {}\n');
    expect(fns.map((f) => `${f.owner ?? ''}.${f.name}`)).toEqual(['Store.show_order', '.remove_order']);
  });
});

describe('Swift (Vapor)', () => {
  it('path components, grouped and group, use: and closures; only in files that import Vapor', () => {
    const src = `import Vapor

func routes(_ app: Application) throws {
    app.get("hello", ":name") { req async throws -> String in
        "Hello"
    }
    let api = app.grouped("api", "v1")
    api.post("orders", use: OrderController().create)
    api.group("orders") { orders in
        orders.get(":id", use: show)
        orders.on(.DELETE, ":id", use: delete)
    }
}`;
    expect(refs('Sources/App/routes.swift', src)).toEqual([
      'GET /hello/{name} → (in place 4-6)', 'POST /api/v1/orders → create', 'GET /api/v1/orders/{id} → show', 'DELETE /api/v1/orders/{id} → delete',
    ]);
    expect(refs('Sources/App/Other.swift', 'let x = dict.get("a") { 1 }')).toEqual([]);
    const ctl = 'struct OrderController {\n    func create(req: Request) async throws -> Order {\n        try req.content.decode(Order.self)\n    }\n}\n';
    expect(functionsIn('OrderController.swift', ctl).map((f) => `${f.owner}.${f.name} ${f.start}-${f.end}`)).toEqual(['OrderController.create 2-4']);
  });
});

describe('Dart', () => {
  it('shelf_router registrations and @Route annotations; Dart Frog route files', () => {
    const src = `final router = Router()
  ..get('/orders/<id>', getOrder)
  ..post('/orders', (Request request) async {
    return Response(201);
  });
app.delete('/orders/<id>', _service.remove);

class Api {
  @Route.get('/users/<id>')
  Future<Response> user(Request request, String id) async {
    return Response.ok(id);
  }
}`;
    expect(refs('bin/server.dart', src)).toEqual([
      'GET /orders/{id} → getOrder', 'POST /orders → (in place 3-5)', 'DELETE /orders/{id} → remove', 'GET /users/{id} → (in place 9-12)',
    ]);
    expect(refs('routes/orders/[id].dart', 'Future<Response> onRequest(RequestContext context, String id) async {\n  return Response();\n}')).toEqual(['ALL /orders/{id} → (in place 1-3)']);
    expect(refs('routes/index.dart', 'Response onRequest(RequestContext c) => Response();')).toEqual(['ALL / → (in place 1-1)']);
    expect(functionsIn('lib/h.dart', 'class Svc {\n  Future<Response> remove(Request r) async {\n    return Response(204);\n  }\n}\n').map((f) => `${f.owner}.${f.name}`)).toEqual(['Svc.remove']);
  });
});

describe('Kotlin (Ktor)', () => {
  it('route blocks and method blocks, only in files that use Ktor', () => {
    const src = `import io.ktor.server.routing.*

fun Application.module() {
    routing {
        route("/api/orders") {
            get("/{id}") {
                call.respond(HttpStatusCode.OK)
            }
            post {
                call.respond(HttpStatusCode.Created)
            }
        }
        get("/health") { call.respondText("ok") }
    }
}`;
    expect(refs('Application.kt', src)).toEqual(['GET /api/orders/{id} → (in place 6-8)', 'POST /api/orders → (in place 9-11)', 'GET /health → (in place 13-13)']);
    expect(refs('Other.kt', 'val x = cache.get { 1 }')).toEqual([]);
  });
});

describe('Python (Django)', () => {
  it('urls.py: path and re_path, function and class views, DRF routers under include(router.urls)', () => {
    const src = `from django.urls import include, path, re_path
from rest_framework.routers import DefaultRouter

router = DefaultRouter()
router.register(r'invoices', InvoiceViewSet)

urlpatterns = [
    path('orders/<int:pk>/', views.order_detail, name='order-detail'),
    re_path(r'^reports/(?P<year>[0-9]{4})/$', ReportView.as_view()),
    path('api/', include(router.urls)),
    path('shop/', include('shop.urls')),
]`;
    expect(refs('orders/urls.py', src).sort()).toEqual([
      'ALL /orders/{pk} → order_detail', 'ALL /reports/{year} → ReportView.*',
      'GET /api/invoices → InvoiceViewSet.list', 'POST /api/invoices → InvoiceViewSet.create',
      'GET /api/invoices/{pk} → InvoiceViewSet.retrieve', 'PUT /api/invoices/{pk} → InvoiceViewSet.update',
      'PATCH /api/invoices/{pk} → InvoiceViewSet.partial_update', 'DELETE /api/invoices/{pk} → InvoiceViewSet.destroy',
    ].sort());
    expect(textIncludes('project/urls.py', src)).toEqual([{ prefix: 'shop/', module: 'shop.urls' }]);
    const views = 'class ReportView(View):\n    def get(self, request, year):\n        return JsonResponse({})\n\ndef order_detail(request, pk):\n    return JsonResponse({})\n';
    const fns = functionsIn('orders/views.py', views);
    expect(fns.map((f) => `${f.owner ?? ''}.${f.name}`)).toEqual(['ReportView.get', '.order_detail']);
    expect(refMatches({ owner: 'ReportView', name: '*' }, fns[0])).toBe(true);
    expect(refMatches({ owner: 'ReportView', name: '*' }, fns[1])).toBe(false);
  });
});
