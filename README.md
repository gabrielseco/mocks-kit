# mocks-kit

A domain-free mock backend engine. An app plugs in its OpenAPI contract, its
recordings, its store and its handlers, and gets the mock server and the replay
test for free. The engine lives in `src/engine/`.

## What the app passes in

| Input                | Meaning                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec`               | The OpenAPI document. Its paths become routes (literal paths beat `{param}` ones), its schemas are the contract every response is checked against. |
| `createStore(clock)` | Builds a fresh store anchored on `clock` (YYYY-MM-DD).                                                                                             |
| `handlers`           | `operationId -> handler`. An operation without one answers 501.                                                                                    |
| `storeKey`           | The `globalThis` slot for the store, so dev hot reloads keep the data.                                                                             |
| `session?`           | `{ cookie, value, login, logout }`. Defaults `session_token` / `mock-session`; no `login`/`logout` means the mock never sets or clears the cookie. |
| `resetPath?`         | `POST` here rebuilds the store, answers 204. Default `/api/__mock/reset`.                                                                          |
| `today?`             | Default: `MOCK_TODAY`, else the real date.                                                                                                         |
| `hint?`              | Appended to the 501 messages (e.g. "see lib/mock/handlers.ts").                                                                                    |

Type handlers with the generic types, narrowed to the app's own
openapi-typescript `operations` and store:

```ts
import type { Handler as H, Handlers as Hs } from 'mocks-kit/src/engine';
export type Handler<Op extends keyof operations> = H<operations, Op, Store>;
export type Handlers = Hs<operations, Store, Mocked>; // Mocked: the ops the app mocks
```

## `lib/mock/server.ts` and `app/api/[...path]/route.ts`

```ts
// lib/mock/server.ts
import { createMockEngine } from 'mocks-kit/src/engine';
import spec from '@/contracts/openapi.json';
import { handlers } from './handlers';
import { createStore } from './store';

export const mock = createMockEngine({
  spec,
  createStore,
  handlers,
  storeKey: '__myAppMockStore',
  session: { login: 'verifyLoginCode', logout: 'logout' },
});

// app/api/[...path]/route.ts
const handle = async (request: Request) =>
  process.env.API_MODE === 'mock'
    ? (await import('@/lib/mock/server')).mock.handleMockRequest(request)
    : proxyToBackend(request);
export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
```

A handler returns `{ status, body }`; a body or status the contract does not
declare becomes a 500 naming the operation and the reason. Throw
`MockHttpError(status, message)` for errors outside the contract. Invalid JSON
in a request answers 400; an authed operation without the cookie answers 401.

## Replay test

```ts
// tests/mock/replay.test.ts
import { replayExamples } from 'mocks-kit/src/engine/replay';
import type { Recordings } from 'mocks-kit/src/engine';
import recorded from '@/contracts/examples.json';
import { handlers } from '@/lib/mock/handlers';
import { mock } from '@/lib/mock/server';

replayExamples({
  engine: mock,
  recordings: recorded as Recordings, // { clock, examples }
  only: Object.keys(handlers), // optional: others are skipped
});
```

One test per example, run with `MOCK_TODAY` and the store reset to the recorded
clock; examples named `signedOut` go without the cookie (`signedOut` option).

## What stays in the app

Handlers, the store and its seed, per-resource files (`budgets.ts`, ...),
canned data, `recorded.ts`, the `operations` types and the `Mocked`/`Unmocked`
list, and behaviour tests specific to the backend.
