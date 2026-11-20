import { describe, expect, it } from 'vitest';
import { callsIn, pathOfTemplate, templateOf } from '../src/calls-text.js';

const calls = (file: string, src: string) => callsIn(file, src).map((c) => `${c.method} ${c.path} ${c.start}${c.end !== c.start ? `-${c.end}` : ''}`);
const path = (arg: string) => pathOfTemplate(templateOf(arg));

describe('calls: a URL as a path', () => {
  it('base addresses in variables and written out, interpolation in every language, the query left out', () => {
    expect(path('`${environment.apiUrl}/orders/${id}?expand=lines`')).toBe('/orders/{}');
    expect(path("'https://api.example.com/v1/orders'")).toBe('/v1/orders');
    expect(path('BASE + "/orders/" + id + "/lines"')).toBe('/orders/{}/lines');
    expect(path('f"{BASE}/orders/{order_id}"')).toBe('/orders/{}');
    expect(path('$"orders/{id}"')).toBe('/orders/{}');
    expect(path('"\\(baseURL)/users/\\(id)"')).toBe('/users/{}');
    expect(path("'$baseUrl/users/$id'")).toBe('/users/{}');
    expect(path('"#{BASE}/carts/#{id}"')).toBe('/carts/{}');
    expect(path('fmt.Sprintf("%s/orders/%d", base, id)')).toBe('/orders/{}');
    expect(path('format!("{}/orders/{}", base, id)')).toBe('/orders/{}');
    expect(path('"users/{id}"')).toBe('/users/{}');
    expect(path("$base . '/orders'")).toBe('/orders');
    expect(path("Uri.https('api.example.com', '/v2/items')")).toBe('/v2/items');
    // nothing to read: a URL in a variable, only a host, a file
    expect(path('url')).toBeUndefined();
    expect(path('`${base}`')).toBeUndefined();
    expect(path("'https://api.example.com'")).toBeUndefined();
    expect(path("'/assets/logo.png'")).toBeUndefined();
  });
});

describe('calls: TypeScript and JavaScript', () => {
  it('fetch with its method, axios, Angular HttpClient, axios config; route registrations are not calls', () => {
    const src = `export async function load(id: string) {
  const res = await fetch(\`\${API}/orders/\${id}\`, {
    method: 'DELETE',
  });
  await fetch('/api/health');
  const { data } = await axios.post('/api/orders', body);
  return this.http.get<Order[]>(\`\${this.base}/orders\`);
}
axios({ method: 'patch', url: '/api/orders/' + id });
app.get('/orders', (req, res) => res.json([]));
api.get('/users/:id', getUser);
// fetch('/api/commented-out')
const m = new Map(); m.get('key');`;
    expect(calls('src/orders.ts', src)).toEqual(['DELETE /orders/{} 2-4', 'GET /api/health 5', 'POST /api/orders 6', 'GET /orders 7', 'PATCH /api/orders/{} 9']);
  });
});

describe('calls: Android and the JVM', () => {
  it('Retrofit interfaces, @HTTP, OkHttp builders, java.net.http, WebClient, RestTemplate', () => {
    const retrofit = `interface OrdersApi {
    @GET("orders/{id}")
    suspend fun order(@Path("id") id: String): Order

    @Headers("Accept: application/json")
    @POST("orders")
    fun create(@Body o: NewOrder): Call<Order>

    @HTTP(method = "DELETE", path = "orders/{id}", hasBody = true)
    fun remove(@Path("id") id: String): Call<Unit>
}`;
    expect(calls('app/src/main/java/acme/OrdersApi.kt', retrofit)).toEqual(['GET /orders/{} 2', 'POST /orders 6', 'DELETE /orders/{} 9']);
    const ok = `val req = Request.Builder().url("$BASE/carts/$id")
    .header("Authorization", token)
    .put(body)
    .build()
val r2 = HttpRequest.newBuilder(URI.create(base + "/carts"))
    .POST(HttpRequest.BodyPublishers.ofString(json)).build()
webClient.get().uri("/users/{id}", id).retrieve()
restTemplate.postForEntity(base + "/payments", p, Payment.class)
restTemplate.exchange(base + "/payments/" + id, HttpMethod.PATCH, entity, Payment.class)`;
    expect(calls('Client.kt', ok)).toEqual(['PUT /carts/{} 1', 'POST /carts 5', 'GET /users/{} 7', 'POST /payments 8', 'PATCH /payments/{} 9']);
  });

  it('Feign clients are calls, and not routes this system answers', async () => {
    const { textHandlers } = await import('../src/routes-text.js');
    const feign = `@FeignClient(name = "stock", url = "\${stock.url}")
public interface StockClient {
    @GetMapping("/stock/{sku}")
    Stock stock(@PathVariable String sku);
}`;
    expect(calls('StockClient.java', feign)).toEqual(['GET /stock/{} 3']);
    expect(textHandlers('StockClient.java', feign)).toEqual([]);
  });
});

describe('calls: iOS, Flutter and the rest', () => {
  it('Swift: URLRequest with httpMethod, Alamofire', () => {
    const src = `var request = URLRequest(url: URL(string: "\\(baseURL)/orders/\\(id)")!)
request.httpMethod = "PATCH"
let (data, _) = try await URLSession.shared.data(for: request)
AF.request("\\(baseURL)/carts", method: .post, parameters: cart)`;
    expect(calls('Sources/Api.swift', src)).toEqual(['PATCH /orders/{} 1', 'POST /carts 4']);
  });

  it('Dart: Dio and package:http', () => {
    expect(calls('lib/api.dart', "final r = await _dio.get('/orders/$id');\nawait http.post(Uri.parse('$base/orders'), body: b);\nawait client.delete(Uri.https('api.x.com', '/orders/1'));")).toEqual([
      'GET /orders/{} 1', 'POST /orders 2', 'DELETE /orders/1 3',
    ]);
  });

  it('Python, Go, C#, PHP, Ruby, Rust', () => {
    expect(calls('svc/client.py', 'r = requests.get(f"{BASE}/orders/{oid}", timeout=5)\nhttpx.post(BASE + "/orders", json=o)\nsession.request("DELETE", f"{BASE}/orders/{oid}")')).toEqual(['GET /orders/{} 1', 'POST /orders 2', 'DELETE /orders/{} 3']);
    expect(calls('client.go', 'resp, err := http.Get(base + "/orders")\nreq, _ := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("%s/orders/%s/cancel", base, id), nil)')).toEqual(['GET /orders 1', 'POST /orders/{}/cancel 2']);
    expect(calls('Client.cs', 'var o = await http.GetFromJsonAsync<Order>($"orders/{id}");\nawait http.PostAsJsonAsync("orders", o);\nvar m = new HttpRequestMessage(HttpMethod.Patch, $"orders/{id}");\n[Get("/users/{id}")]\nTask<User> GetUser(int id);')).toEqual(['GET /orders/{} 1', 'POST /orders 2', 'PATCH /orders/{} 3', 'GET /users/{} 4']);
    expect(calls('src/Client.php', "<?php\n$r = $client->get('/orders/' . $id);\n$r = Http::withToken($t)->post($base . '/orders', $o);\n$client->request('PUT', \"/orders/{$id}\");")).toEqual(['GET /orders/{} 2', 'POST /orders 3', 'PUT /orders/{} 4']);
    expect(calls('lib/client.rb', 'conn.get("/orders/#{id}")\nreq = Net::HTTP::Post.new(URI("#{BASE}/orders"))\nHTTParty.delete("#{BASE}/orders/#{id}")')).toEqual(['GET /orders/{} 1', 'POST /orders 2', 'DELETE /orders/{} 3']);
    expect(calls('src/client.rs', 'let r = client.get(format!("{}/orders/{}", base, id)).send().await?;\nclient.request(Method::PATCH, format!("{base}/orders/{id}"))')).toEqual(['GET /orders/{} 1', 'PATCH /orders/{} 2']);
  });
});
