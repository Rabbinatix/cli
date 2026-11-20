// Web frameworks whose API routes `rabbinatix impact` and `rabbinatix status` read from the code
// (rabbinatix-cli/src/analyze.ts for the TypeScript ones, routes-text.ts for the rest). Other frameworks: the anchors,
// which the AI assistant writes (assistant-and-cli-plan.md § 4). `named`: the route names its handler function, so a
// change inside that function, in any file, is its route (languages-plan.md § Final scope).
import type { LanguageId } from './languages';

export type FrameworkId =
  | 'express' | 'nestjs' | 'fastify' | 'hono' | 'koa' | 'nextjs'
  | 'aspnet' | 'spring' | 'jaxrs' | 'ktor'
  | 'fastapi' | 'flask' | 'django'
  | 'nethttp' | 'gin' | 'echo' | 'chi' | 'fiber'
  | 'rails' | 'sinatra' | 'laravel' | 'symfony'
  | 'axum' | 'actix' | 'rocket' | 'vapor' | 'shelf' | 'dartfrog';

export interface FrameworkDef {
  id: FrameworkId;
  label: string;
  languages: LanguageId[];
  /** how the CLI reads it: the TypeScript compiler, or the text */
  reader: 'typescript' | 'text';
  /** routes name their handler function (found in any file of the repo); otherwise the handler is the route's own body */
  named?: boolean;
}

export const FRAMEWORKS: readonly FrameworkDef[] = [
  { id: 'express', label: 'Express', languages: ['typescript', 'javascript'], reader: 'typescript' },
  { id: 'nestjs', label: 'NestJS', languages: ['typescript'], reader: 'typescript' },
  { id: 'fastify', label: 'Fastify', languages: ['typescript', 'javascript'], reader: 'typescript' },
  { id: 'hono', label: 'Hono', languages: ['typescript', 'javascript'], reader: 'typescript' },
  { id: 'koa', label: 'Koa (koa-router)', languages: ['typescript', 'javascript'], reader: 'typescript' },
  { id: 'nextjs', label: 'Next.js (route handlers, pages/api)', languages: ['typescript', 'javascript'], reader: 'typescript' },
  { id: 'aspnet', label: 'ASP.NET Core (controllers, minimal APIs)', languages: ['csharp'], reader: 'text' },
  { id: 'spring', label: 'Spring', languages: ['java', 'kotlin'], reader: 'text' },
  { id: 'jaxrs', label: 'JAX-RS (Jakarta REST)', languages: ['java', 'kotlin'], reader: 'text' },
  { id: 'ktor', label: 'Ktor', languages: ['kotlin'], reader: 'text' },
  { id: 'fastapi', label: 'FastAPI', languages: ['python'], reader: 'text' },
  { id: 'flask', label: 'Flask', languages: ['python'], reader: 'text' },
  { id: 'django', label: 'Django (urls.py, Django REST framework routers)', languages: ['python'], reader: 'text', named: true },
  { id: 'nethttp', label: 'Go net/http (and gorilla/mux)', languages: ['go'], reader: 'text', named: true },
  { id: 'gin', label: 'Gin', languages: ['go'], reader: 'text', named: true },
  { id: 'echo', label: 'Echo', languages: ['go'], reader: 'text', named: true },
  { id: 'chi', label: 'chi', languages: ['go'], reader: 'text', named: true },
  { id: 'fiber', label: 'Fiber', languages: ['go'], reader: 'text', named: true },
  { id: 'rails', label: 'Ruby on Rails (config/routes.rb)', languages: ['ruby'], reader: 'text', named: true },
  { id: 'sinatra', label: 'Sinatra', languages: ['ruby'], reader: 'text' },
  { id: 'laravel', label: 'Laravel', languages: ['php'], reader: 'text', named: true },
  { id: 'symfony', label: 'Symfony (#[Route])', languages: ['php'], reader: 'text' },
  { id: 'axum', label: 'axum', languages: ['rust'], reader: 'text', named: true },
  { id: 'actix', label: 'actix-web', languages: ['rust'], reader: 'text', named: true },
  { id: 'rocket', label: 'Rocket', languages: ['rust'], reader: 'text' },
  { id: 'vapor', label: 'Vapor', languages: ['swift'], reader: 'text', named: true },
  { id: 'shelf', label: 'shelf_router', languages: ['dart'], reader: 'text', named: true },
  { id: 'dartfrog', label: 'Dart Frog', languages: ['dart'], reader: 'text' },
];

export const frameworksOf = (lang: LanguageId) => FRAMEWORKS.filter((f) => f.languages.includes(lang));

/** HTTP clients whose calls `rabbinatix impact` reads (rabbinatix-cli/src/calls-text.ts): a changed call, or a changed
 *  line in the function making it, is the API the system calls (its consumer endpoint) and that API's contract */
export interface ClientDef { label: string; languages: LanguageId[] }

export const CLIENTS: readonly ClientDef[] = [
  { label: 'fetch, axios, ky, Angular HttpClient', languages: ['typescript', 'javascript'] },
  { label: 'Retrofit, Feign, OkHttp, java.net.http, WebClient, RestTemplate', languages: ['java', 'kotlin'] },
  { label: 'Ktor client', languages: ['kotlin'] },
  { label: 'URLSession, Alamofire', languages: ['swift'] },
  { label: 'Dio, package:http', languages: ['dart'] },
  { label: 'requests, httpx, aiohttp', languages: ['python'] },
  { label: 'net/http', languages: ['go'] },
  { label: 'HttpClient, Refit', languages: ['csharp'] },
  { label: 'Guzzle, Laravel Http', languages: ['php'] },
  { label: 'Faraday, HTTParty, Net::HTTP', languages: ['ruby'] },
  { label: 'reqwest', languages: ['rust'] },
];

export const clientsOf = (lang: LanguageId) => CLIENTS.filter((c) => c.languages.includes(lang));
