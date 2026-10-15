import type { operations } from "@/lib/api/schema";
import type { Store } from "./store";

export type OperationId = keyof operations;

/**
 * The operations mock mode implements: every /api/crm one, plus the auth flow and the
 * payslips, money account, net worth and target endpoints the crm pages call. Anything else
 * in the contract answers 501. `Handlers` is keyed by this union, so a handler cannot be
 * removed without a type error, and tests/mock/behaviour.test.ts checks that no /api/crm
 * operation the backend adds is left out of it.
 */
export type Mocked =
  | "requestLoginCode"
  | "verifyLoginCode"
  | "getCurrentUser"
  | "logout"
  | "listTimeOff"
  | "createTimeOff"
  | "updateTimeOff"
  | "deleteTimeOff"
  | "listTrips"
  | "createTrip"
  | "updateTrip"
  | "deleteTrip"
  | "listTripLocations"
  | "createTripLocation"
  | "updateTripLocation"
  | "deleteTripLocation"
  | "listHomePeriods"
  | "createHomePeriod"
  | "updateHomePeriod"
  | "deleteHomePeriod"
  | "getResidencySummary"
  | "listConcerts"
  | "listConcertVenues"
  | "createConcert"
  | "updateConcert"
  | "deleteConcert"
  | "listCarKm"
  | "getCarKmSummary"
  | "logCarKm"
  | "updateCarKm"
  | "deleteCarKm"
  | "listInvisalign"
  | "logInvisalignTray"
  | "listPayslips"
  | "getPayslipProjection"
  | "listMoneyAccounts"
  | "createMoneyAccount"
  | "updateMoneyAccount"
  | "deleteMoneyAccount"
  | "recordMoneyAccountSnapshot"
  | "getNetWorth"
  | "getNetWorthHistory"
  | "listTargets"
  | "updateTarget";

type Responses<Op extends OperationId> = operations[Op]["responses"];

/** A status the operation declares, with the body the contract gives it. */
export type MockResult<Op extends OperationId> = {
  [Status in keyof Responses<Op>]: Responses<Op>[Status] extends {
    content: { "application/json": infer Body };
  }
    ? { status: Status; body: Body }
    : { status: Status; body?: undefined };
}[keyof Responses<Op>];

type Parameters<Op extends OperationId> = operations[Op]["parameters"];

// Query and path values arrive as strings, whatever type the contract gives them.
type Strings<T> = { [K in keyof NonNullable<T>]?: string };

// The JSON body the contract declares, whether or not it marks it required: a handler for an
// operation with a body always gets an object to read.
type DeclaredBody<Op extends OperationId> = operations[Op] extends {
  requestBody?: infer RequestBody;
}
  ? NonNullable<RequestBody>
  : never;

type BodyOf<Op extends OperationId> = [DeclaredBody<Op>] extends [never]
  ? undefined
  : DeclaredBody<Op> extends { content: { "application/json": infer Body } }
    ? Body
    : undefined;

export interface MockRequest<Op extends OperationId> {
  path: Strings<Parameters<Op>["path"]>;
  query: Strings<Parameters<Op>["query"]>;
  body: BodyOf<Op>;
  store: Store;
}

export type Handler<Op extends OperationId> = (request: MockRequest<Op>) => MockResult<Op>;

export type Handlers = { [Op in Mocked]: Handler<Op> };

/** A response outside the contract: where the real backend raises instead of returning one. */
export class MockHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
