import type { operations } from '@/lib/api/schema';
import type { Store } from './store';

export type OperationId = keyof operations;

/**
 * Operations in the contract that mock mode does not implement; calling one
 * answers 501. Listing an operation here is the only way to leave it without a
 * handler: one that is in neither this union nor `handlers` is a type error.
 *
 * Today that is every write outside expenses (the mock is read-only there) and
 * the reads the backend has not recorded an example for. Keep it shrinking.
 */
export type Unmocked =
  | 'archiveEquityReport'
  | 'archiveThesis'
  | 'comparePrices'
  | 'createAsset'
  | 'createDividend'
  | 'createMoneyAccount'
  | 'createThesis'
  | 'createTransaction'
  | 'deleteMoneyAccount'
  | 'generatePrompt'
  | 'getAsset'
  | 'getNetWorth'
  | 'getNetWorthHistory'
  | 'getPayslipProjection'
  | 'getPortfolioPerformance'
  | 'recordMoneyAccountSnapshot'
  | 'unarchiveThesis'
  | 'updateAsset'
  | 'updateDividend'
  | 'updateMoneyAccount'
  | 'updateTarget'
  | 'updateThesis'
  | 'updateTransaction';

type Responses<Op extends OperationId> = operations[Op]['responses'];

/** A status the operation declares, with the body the contract gives it. */
export type MockResult<Op extends OperationId> = {
  [Status in keyof Responses<Op>]: Responses<Op>[Status] extends {
    content: { 'application/json': infer Body };
  }
    ? { status: Status; body: Body }
    : { status: Status; body?: undefined };
}[keyof Responses<Op>];

type Parameters<Op extends OperationId> = operations[Op]['parameters'];

// Query and path values arrive as strings, whatever type the contract gives them.
type Strings<T> = { [K in keyof NonNullable<T>]?: string };

// The JSON body the contract declares, whether or not it marks it required:
// a handler for an operation with a body always gets an object to read.
type DeclaredBody<Op extends OperationId> = operations[Op] extends {
  requestBody?: infer RequestBody;
}
  ? NonNullable<RequestBody>
  : never;

type BodyOf<Op extends OperationId> = [DeclaredBody<Op>] extends [never]
  ? undefined
  : DeclaredBody<Op> extends { content: { 'application/json': infer Body } }
    ? Body
    : undefined;

export interface MockRequest<Op extends OperationId> {
  path: Strings<Parameters<Op>['path']>;
  query: Strings<Parameters<Op>['query']>;
  body: BodyOf<Op>;
  store: Store;
}

export type Handler<Op extends OperationId> = (
  request: MockRequest<Op>
) => MockResult<Op>;

export type Handlers = {
  [Op in Exclude<OperationId, Unmocked>]: Handler<Op>;
};

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
