// contracts/examples.json: responses the real backend recorded from its
// controllers over a fixed, invented dataset. Never edited here.
import recorded from '@/contracts/examples.json';

export interface RecordedExample {
  operationId: string;
  name: string;
  request: { method: string; path: string; query: Record<string, string> };
  response: { status: number; body: unknown };
}

export const examples = recorded.examples as unknown as RecordedExample[];

/** The date the recorded data treats as today. */
export const SEED_CLOCK: string = recorded.clock;
