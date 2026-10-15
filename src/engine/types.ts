// The shapes an app hands the engine, and the generic handler types an app
// narrows with its own `operations` (the type openapi-typescript generates from
// the contract) and its own store.

/** The parts of an OpenAPI 3 document the engine reads. */
export interface OpenApiDocument {
  paths: Record<string, object>;
  components?: { schemas?: Record<string, object> };
}

/** One response the real backend recorded for a request. */
export interface RecordedExample {
  operationId: string;
  name: string;
  request: { method: string; path: string; query: Record<string, string> };
  response: { status: number; body: unknown };
}

/** The backend's recordings file: the date it treats as today, and the examples. */
export interface Recordings {
  clock: string;
  examples: readonly RecordedExample[];
}

/** Builds a fresh store whose dates are anchored on `clock` (YYYY-MM-DD). */
export type CreateStore<Store> = (clock: string) => Store;

type Responses<Ops, Op extends keyof Ops> = Ops[Op] extends {
  responses: infer R;
}
  ? R
  : never;

/** A status the operation declares, with the body the contract gives it. */
export type MockResult<Ops, Op extends keyof Ops> = {
  [Status in keyof Responses<Ops, Op>]: Responses<Ops, Op>[Status] extends {
    content: { 'application/json': infer Body };
  }
    ? { status: Status; body: Body }
    : { status: Status; body?: undefined };
}[keyof Responses<Ops, Op>];

// Query and path values arrive as strings, whatever type the contract gives them.
type Strings<T> = { [K in keyof NonNullable<T>]?: string };

type ParametersIn<Ops, Op extends keyof Ops, Where extends string> =
  Ops[Op] extends { parameters: { [W in Where]?: infer P } } ? P : undefined;

// The JSON body the contract declares, whether or not it marks it required:
// a handler for an operation with a body always gets an object to read.
type DeclaredBody<Ops, Op extends keyof Ops> = Ops[Op] extends {
  requestBody?: infer RequestBody;
}
  ? NonNullable<RequestBody>
  : never;

type BodyOf<Ops, Op extends keyof Ops> = [DeclaredBody<Ops, Op>] extends [never]
  ? undefined
  : DeclaredBody<Ops, Op> extends {
        content: { 'application/json': infer Body };
      }
    ? Body
    : undefined;

export interface MockRequest<Ops, Op extends keyof Ops, Store> {
  path: Strings<ParametersIn<Ops, Op, 'path'>>;
  query: Strings<ParametersIn<Ops, Op, 'query'>>;
  body: BodyOf<Ops, Op>;
  store: Store;
}

export type Handler<Ops, Op extends keyof Ops, Store> = (
  request: MockRequest<Ops, Op, Store>
) => MockResult<Ops, Op>;

/**
 * The handler map, keyed by the operations the app mocks. Narrow `Mocked` to
 * leave operations out; those answer 501.
 */
export type Handlers<Ops, Store, Mocked extends keyof Ops = keyof Ops> = {
  [Op in Mocked]: Handler<Ops, Op, Store>;
};

/** What the engine needs of any handler, whatever operation it serves. */
export type AnyHandler = (request: never) => { status: number; body?: unknown };

/**
 * A response outside the contract: where the real backend raises (a 400 or
 * 500) instead of returning something the contract describes.
 */
export class MockHttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}
