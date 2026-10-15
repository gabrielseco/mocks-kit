// The backend recorded what it really returns for these requests
// (contracts/examples.json). Replaying each one against the mock, seeded from
// the same data, is what keeps the mock's filters, ordering and totals from
// drifting away from the backend's.
import { beforeEach, describe, expect, it } from 'vitest';
import { examples } from '@/lib/mock/recorded';
import {
  handleMockRequest,
  resetMockStore,
  SEED_CLOCK,
} from '@/lib/mock/server';

describe('mock backend replays the recorded backend responses', () => {
  beforeEach(() => {
    process.env.MOCK_TODAY = SEED_CLOCK;
    resetMockStore(SEED_CLOCK);
  });

  it.each(examples.map((e) => [`${e.operationId}/${e.name}`, e] as const))(
    '%s',
    async (_label, example) => {
      const url = new URL(example.request.path, 'http://mock.test');
      url.search = new URLSearchParams(example.request.query).toString();

      const response = await handleMockRequest(
        new Request(url, {
          method: example.request.method,
          headers:
            example.name === 'signedOut'
              ? {}
              : { cookie: 'session_token=mock-session' },
        })
      );

      const text = await response.text();
      expect({
        status: response.status,
        body: text === '' ? null : JSON.parse(text),
      }).toEqual(example.response);
    }
  );

  it('has a recording behind every replay-only handler', async () => {
    const { replayed } = await import('@/lib/mock/handlers');
    const { recordedOperations } = await import('@/lib/mock/canned');

    for (const operation of Object.keys(replayed)) {
      expect(recordedOperations, operation).toContain(operation);
    }
  });
});
