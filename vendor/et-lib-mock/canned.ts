// Handlers that replay what the backend recorded (contracts/examples.json)
// instead of computing anything. They make a page render with real backend
// output, but they do not react to filters or to changes: every month shows
// the recorded month. Replace one with a real handler in handlers.ts when a
// page needs to be interactive in mock mode.
import { examples, SEED_CLOCK } from './recorded';
import { shiftMonths } from './store';
import {
  MockHttpError,
  type Handler,
  type MockResult,
  type OperationId,
} from './types';

const monthIndex = (date: string) =>
  Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME = /^(\d{4}-\d{2}-\d{2})(T.*)$/;

// Slides every date in a recorded body by whole months, the same way the
// expense store does, so recorded and computed pages agree on "this month".
function shiftDates(value: unknown, months: number): unknown {
  if (months === 0) return value;
  if (typeof value === 'string') {
    if (ISO_DATE.test(value)) return shiftMonths(value, months);
    const dateTime = value.match(ISO_DATE_TIME);
    return dateTime ? shiftMonths(dateTime[1], months) + dateTime[2] : value;
  }
  if (Array.isArray(value))
    return value.map((item) => shiftDates(item, months));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        shiftDates(item, months),
      ])
    );
  }
  return value;
}

// How well a recording fits a request: the number of its query values the
// request repeats, or -1 if it was made with a value the request doesn't have.
// A request for EUR sorted by name is best served by the EUR recording, not by
// the one made with no currency at all.
function fit(
  recordedQuery: Record<string, string>,
  query: Record<string, string>
) {
  const pairs = Object.entries(recordedQuery);
  return pairs.every(([key, value]) => query[key] === value)
    ? pairs.length
    : -1;
}

/** Operation ids that have at least one recorded successful response. */
export const recordedOperations = new Set(
  examples
    .filter((e) => e.response.status >= 200 && e.response.status < 300)
    .map((e) => e.operationId)
);

/**
 * A handler that answers with the recorded response for `operationId`. With
 * several recordings it picks the one whose query the request matches most
 * closely, and otherwise the first. An operation with path parameters only
 * answers for the recorded paths, and 404s otherwise.
 */
export function canned<Op extends OperationId>(operationId: Op): Handler<Op> {
  const candidates = examples.filter(
    (e) =>
      e.operationId === operationId &&
      e.response.status >= 200 &&
      e.response.status < 300
  );

  return ({ path, query }) => {
    const pathValues = Object.values(path as Record<string, string>);
    const query_ = query as Record<string, string>;
    const forPath = candidates.filter((e) =>
      pathValues.every((value) => e.request.path.split('/').includes(value))
    );

    const example =
      forPath.reduce<(typeof forPath)[number] | undefined>(
        (best, candidate) =>
          fit(candidate.request.query, query_) >
          (best ? fit(best.request.query, query_) : -1)
            ? candidate
            : best,
        undefined
      ) ?? forPath[0];

    if (!example) {
      throw new MockHttpError(
        404,
        `mock mode has no recording of ${operationId} for this path`
      );
    }

    const today =
      process.env.MOCK_TODAY ?? new Date().toISOString().slice(0, 10);
    return {
      status: example.response.status,
      body: shiftDates(
        example.response.body,
        monthIndex(today) - monthIndex(SEED_CLOCK)
      ),
    } as MockResult<Op>;
  };
}
