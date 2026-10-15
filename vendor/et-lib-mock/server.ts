// Mock backend entry point: turns a request for /api/... into the response the
// contract describes, with no network and no backend. Loaded only when
// API_MODE=mock (see app/api/[...path]/route.ts).
import spec from '@/contracts/openapi.json';
import { handlers } from './handlers';
import { createStore, SEED_CLOCK, type Store } from './store';
import { MockHttpError, type Handler, type OperationId } from './types';
import { validate } from './validate';

const SESSION_COOKIE = 'session_token';
const SESSION_VALUE = 'mock-session';
const RESET_PATH = '/api/__mock/reset';

interface Route {
  method: string;
  pattern: RegExp;
  params: string[];
  operationId: string;
  authed: boolean;
  responses: Record<string, { content?: Record<string, { schema: object }> }>;
}

interface SpecOperation {
  operationId: string;
  security?: unknown[];
  responses: Route['responses'];
}

function buildRoutes(): Route[] {
  const routes: Route[] = [];

  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(
      item as Record<string, SpecOperation>
    )) {
      if (!operation?.operationId) continue;

      const params = [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      routes.push({
        method: method.toUpperCase(),
        pattern: new RegExp(`^${path.replace(/\{\w+\}/g, '([^/]+)')}$`),
        params,
        operationId: operation.operationId,
        authed: (operation.security ?? []).length > 0,
        responses: operation.responses,
      });
    }
  }

  // /api/expenses/categories has to win over /api/expenses/{slug}.
  return routes.sort((a, b) => a.params.length - b.params.length);
}

const routes = buildRoutes();

// One store per server process, kept on globalThis so dev hot reloads of this
// module don't wipe what the developer just created.
const globalStore = globalThis as { __expenseTrackerMockStore?: Store };

/** Today as YYYY-MM-DD; `MOCK_TODAY` pins it (tests use the recorded clock). */
function today(): string {
  return process.env.MOCK_TODAY ?? new Date().toISOString().slice(0, 10);
}

export function mockStore(): Store {
  globalStore.__expenseTrackerMockStore ??= createStore(today());
  return globalStore.__expenseTrackerMockStore;
}

export function resetMockStore(clock: string = today()): Store {
  globalStore.__expenseTrackerMockStore = createStore(clock);
  return globalStore.__expenseTrackerMockStore;
}

export { SEED_CLOCK };

function json(status: number, body: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function hasSession(request: Request): boolean {
  const cookies = request.headers.get('cookie') ?? '';
  return cookies
    .split(';')
    .some((part) => part.trim() === `${SESSION_COOKIE}=${SESSION_VALUE}`);
}

const cookie = (value: string, maxAge: number) =>
  `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new MockHttpError(400, 'request body is not valid JSON');
  }
}

// A mock response the contract does not allow is a bug in the mock. Surface it
// as a 500 with the reason instead of handing the UI a shape the backend
// would never send.
function contractProblems(
  route: Route,
  status: number,
  body: unknown
): string[] {
  const declared = route.responses[String(status)];
  if (!declared) {
    return [`status ${status} is not declared for ${route.operationId}`];
  }

  const schema = declared.content?.['application/json']?.schema;
  if (!schema) {
    return body === undefined ? [] : ['a body was sent where none is declared'];
  }
  return body === undefined
    ? ['no body was sent where one is declared']
    : validate(body, schema);
}

export async function handleMockRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === RESET_PATH && request.method === 'POST') {
    resetMockStore();
    return new Response(null, { status: 204 });
  }

  const candidates = routes.filter((route) => route.pattern.test(url.pathname));
  const route = candidates.find((r) => r.method === request.method);

  if (!route) {
    return json(501, {
      error:
        `Mock mode has no ${request.method} ${url.pathname}. Only the operations in ` +
        'contracts/openapi.json are mocked; the rest need the real backend ' +
        '(npm run dev) until the backend adds them to the contract.',
      mock: true,
    });
  }

  if (route.authed && !hasSession(request)) {
    return json(401, { error: 'Unauthorized' });
  }

  const handler = (
    handlers as Record<string, Handler<OperationId> | undefined>
  )[route.operationId];
  if (!handler) {
    return json(501, {
      error: `Mock mode has no handler for ${route.operationId} yet (lib/mock/handlers.ts).`,
      mock: true,
    });
  }

  try {
    const values = url.pathname.match(route.pattern)!.slice(1);
    const result = handler({
      path: Object.fromEntries(
        route.params.map((name, i) => [name, decodeURIComponent(values[i])])
      ),
      query: Object.fromEntries(url.searchParams),
      // Handlers for operations with a body always get an object to read.
      body: (await readBody(request)) ?? {},
      store: mockStore(),
    } as never) as { status: number; body?: unknown };

    const problems = contractProblems(route, result.status, result.body);
    if (problems.length > 0) {
      return json(500, {
        error: `The mock ${route.operationId} response breaks the contract: ${problems.join('; ')}`,
        mock: true,
      });
    }

    const headers = new Headers();
    if (route.operationId === 'verifyLoginCode' && result.status === 200) {
      headers.set('set-cookie', cookie(SESSION_VALUE, 60 * 60 * 24 * 30));
    }
    if (route.operationId === 'logout') {
      headers.set('set-cookie', cookie('', 0));
    }

    if (result.body === undefined) {
      return new Response(null, { status: result.status, headers });
    }
    headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers,
    });
  } catch (error) {
    if (error instanceof MockHttpError) {
      return json(error.status, { error: error.message, mock: true });
    }
    throw error;
  }
}
