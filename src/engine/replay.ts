// The backend recorded what it really returns for a set of requests. Replaying
// each one against the mock, seeded from the same data, is what keeps the
// mock's filters, ordering and totals from drifting away from the backend's.
// Imported from test files only: it registers vitest tests.
import { beforeEach, describe, expect, it } from 'vitest';
import type { MockEngine } from './server';
import type { RecordedExample, Recordings } from './types';

export interface ReplayOptions<Store> {
  engine: MockEngine<Store>;
  recordings: Recordings;
  /**
   * Replay only these operations (e.g. `Object.keys(handlers)`); the other
   * examples are registered as skipped. Default: every example.
   */
  only?: Iterable<string> | ((operationId: string) => boolean);
  /** Examples sent without the session cookie. Default: those named `signedOut`. */
  signedOut?: (example: RecordedExample) => boolean;
  /** The describe block's title. */
  title?: string;
}

function selector(only: ReplayOptions<unknown>['only']) {
  if (only === undefined) return () => true;
  if (typeof only === 'function') return only;
  const operations = new Set(only);
  return (operationId: string) => operations.has(operationId);
}

/** Registers one test per recorded example, each expecting the recorded response. */
export function replayExamples<Store>({
  engine,
  recordings,
  only,
  signedOut = (example) => example.name === 'signedOut',
  title = 'mock backend replays the recorded backend responses',
}: ReplayOptions<Store>): void {
  const replayed = selector(only);

  describe(title, () => {
    beforeEach(() => {
      process.env.MOCK_TODAY = recordings.clock;
      engine.resetMockStore(recordings.clock);
    });

    for (const example of recordings.examples) {
      const label = `${example.operationId}/${example.name}`;
      const test = replayed(example.operationId) ? it : it.skip;

      test(label, async () => {
        const url = new URL(example.request.path, 'http://mock.test');
        url.search = new URLSearchParams(example.request.query).toString();

        const response = await engine.handleMockRequest(
          new Request(url, {
            method: example.request.method,
            headers: signedOut(example) ? {} : { cookie: engine.sessionCookie },
          }),
        );

        const text = await response.text();
        expect({
          status: response.status,
          body: text === '' ? null : JSON.parse(text),
        }).toEqual(example.response);
      });
    }
  });
}
