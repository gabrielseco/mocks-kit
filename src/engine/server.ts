// The mock backend: turns a request for a contract path into the response the
// contract describes, with no network and no backend. The app supplies the
// contract, the store and the handlers; this file knows nothing about either.
import { buildRoutes, matchRoute, pathParams, type Route } from './routes';
import {
  MockHttpError,
  type AnyHandler,
  type CreateStore,
  type OpenApiDocument,
} from './types';
import { createValidator, type Validate } from './validate';

export interface SessionConfig {
  /** Cookie that carries the session. Default `session_token`. */
  cookie?: string;
  /** The one value the mock accepts as signed in. Default `mock-session`. */
  value?: string;
  /** Operation whose 200 sets the cookie. None: the mock never sets it. */
  login?: string;
  /** Operation that clears the cookie. None: the mock never clears it. */
  logout?: string;
  /** Lifetime of the cookie set on login, in seconds. Default 30 days. */
  maxAge?: number;
}

export interface MockEngineConfig<Store> {
  /** The OpenAPI document; its paths are the routes, its schemas the contract. */
  spec: OpenApiDocument;
  createStore: CreateStore<Store>;
  /** operationId -> handler. An operation without one answers 501. */
  handlers: Readonly<Partial<Record<string, AnyHandler>>>;
  /** The globalThis slot the store lives in, so hot reloads keep its data. */
  storeKey: string;
  session?: SessionConfig;
  /** POST here rebuilds the store. Default `/api/__mock/reset`. */
  resetPath?: string;
  /** Today as YYYY-MM-DD. Default: `MOCK_TODAY`, else the real date. */
  today?: () => string;
  /** Appended to the 501 messages, e.g. where the handlers live. */
  hint?: string;
}

export interface MockEngine<Store> {
  handleMockRequest(request: Request): Promise<Response>;
  /** The live store, created on first use. */
  mockStore(): Store;
  /** Replaces the store with a fresh one anchored on `clock` (default today). */
  resetMockStore(clock?: string): Store;
  /** The contract's validator, for tests that check a body by hand. */
  validate: Validate;
  /** `name=value` of a signed-in session, for requests that need one. */
  sessionCookie: string;
}

export const DEFAULT_RESET_PATH = '/api/__mock/reset';
const DEFAULT_SESSION_COOKIE = 'session_token';
const DEFAULT_SESSION_VALUE = 'mock-session';
const THIRTY_DAYS = 60 * 60 * 24 * 30;

/** Today as YYYY-MM-DD; `MOCK_TODAY` pins it (tests use the recorded clock). */
export function mockToday(): string {
  return process.env.MOCK_TODAY ?? new Date().toISOString().slice(0, 10);
}

function json(status: number, body: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new MockHttpError(400, 'request body is not valid JSON');
  }
}

export function createMockEngine<Store>(
  config: MockEngineConfig<Store>
): MockEngine<Store> {
  const routes = buildRoutes(config.spec);
  const validate = createValidator(config.spec);
  const today = config.today ?? mockToday;
  const resetPath = config.resetPath ?? DEFAULT_RESET_PATH;
  const session = {
    cookie: config.session?.cookie ?? DEFAULT_SESSION_COOKIE,
    value: config.session?.value ?? DEFAULT_SESSION_VALUE,
    login: config.session?.login,
    logout: config.session?.logout,
    maxAge: config.session?.maxAge ?? THIRTY_DAYS,
  };
  const sessionCookie = `${session.cookie}=${session.value}`;
  const hint = config.hint ? ` ${config.hint}` : '';

  // One store per server process, kept on globalThis so dev hot reloads of the
  // app's module don't wipe what the developer just created.
  const slot = globalThis as unknown as Record<string, Store | undefined>;

  function mockStore(): Store {
    slot[config.storeKey] ??= config.createStore(today());
    return slot[config.storeKey]!;
  }

  function resetMockStore(clock: string = today()): Store {
    slot[config.storeKey] = config.createStore(clock);
    return slot[config.storeKey]!;
  }

  function hasSession(request: Request): boolean {
    const cookies = request.headers.get('cookie') ?? '';
    return cookies.split(';').some((part) => part.trim() === sessionCookie);
  }

  const cookie = (value: string, maxAge: number) =>
    `${session.cookie}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

  // A mock response the contract does not allow is a bug in the mock. Surface
  // it as a 500 with the reason instead of handing the UI a shape the backend
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

  async function handleMockRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === resetPath && request.method === 'POST') {
      resetMockStore();
      return new Response(null, { status: 204 });
    }

    const route = matchRoute(routes, request.method, url.pathname);
    if (!route) {
      return json(501, {
        error:
          `Mock mode has no ${request.method} ${url.pathname}. Only the operations in ` +
          `the OpenAPI contract are mocked; the rest need the real backend.${hint}`,
        mock: true,
      });
    }

    if (route.authed && !hasSession(request)) {
      return json(401, { error: 'Unauthorized' });
    }

    const handler = config.handlers[route.operationId];
    if (!handler) {
      return json(501, {
        error:
          `Mock mode does not mock ${request.method} ${url.pathname} ` +
          `(${route.operationId}); use the real backend.${hint}`,
        mock: true,
      });
    }

    try {
      const result = handler({
        path: pathParams(route, url.pathname),
        query: Object.fromEntries(url.searchParams),
        // Handlers for operations with a body always get an object to read.
        body: (await readBody(request)) ?? {},
        store: mockStore(),
      } as never);

      const problems = contractProblems(route, result.status, result.body);
      if (problems.length > 0) {
        return json(500, {
          error: `The mock ${route.operationId} response breaks the contract: ${problems.join('; ')}`,
          mock: true,
        });
      }

      const headers = new Headers();
      if (route.operationId === session.login && result.status === 200) {
        headers.set('set-cookie', cookie(session.value, session.maxAge));
      }
      if (route.operationId === session.logout) {
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

  return { handleMockRequest, mockStore, resetMockStore, validate, sessionCookie };
}
