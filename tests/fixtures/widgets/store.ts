// The fixture app's in-memory data, anchored on the clock it is built for.
import type { Widget } from './schema';

export interface Store {
  user: { email: string };
  widgets: Widget[];
}

const DAY = 86_400_000;
const daysBefore = (clock: string, days: number) =>
  new Date(Date.parse(clock) - days * DAY).toISOString().slice(0, 10);

export function createStore(clock: string): Store {
  return {
    user: { email: 'ada@example.test' },
    widgets: [
      { slug: 'cog', name: 'Cog', price: 9, created_on: daysBefore(clock, 5), note: null },
      { slug: 'anvil', name: 'Anvil', price: 120.5, created_on: clock, note: null },
      { slug: 'bolt', name: 'Bolt', price: 2.25, created_on: daysBefore(clock, 1), note: 'zinc' },
    ],
  };
}
