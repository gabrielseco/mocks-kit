// Run by tests/engine/replay.test.ts in a nested vitest, never by the main
// suite: these replays are meant to fail, and the outer test checks they do.
import { createMockEngine } from '../../../src/engine';
import { replayExamples } from '../../../src/engine/replay';
import { handlers } from '../widgets/handlers';
import { config, recordings } from '../widgets/server';

// Still inside the contract, but ordered by price where the backend orders by
// name: exactly the drift replay exists to catch.
const drifting = createMockEngine({
  ...config,
  storeKey: '__widgetsDriftStore',
  handlers: {
    ...handlers,
    listWidgets: ({ store }: { store: ReturnType<typeof config.createStore> }) => ({
      status: 200,
      body: [...store.widgets].sort((a, b) => a.price - b.price),
    }),
  },
});

replayExamples({
  engine: drifting,
  recordings,
  only: Object.keys(handlers),
  title: 'drifting',
});

// Without the filter, the operation the app leaves to the backend answers 501
// where the backend recorded a 200.
replayExamples({
  engine: createMockEngine({ ...config, storeKey: '__widgetsDriftStore' }),
  recordings,
  title: 'unfiltered',
});
