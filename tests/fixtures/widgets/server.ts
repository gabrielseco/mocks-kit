// The fixture app's mock server: its contract, store and handlers plugged
// into the engine, as an app's lib/mock/server.ts would.
import { createMockEngine, type MockEngineConfig } from '../../../src/engine';
import spec from './openapi.json';
import recorded from './examples.json';
import { handlers } from './handlers';
import { createStore, type Store } from './store';
import type { Recordings } from '../../../src/engine';

// JSON imports infer a union per example; the recordings file is the backend's, never edited here.
export const recordings = recorded as unknown as Recordings;

export const STORE_KEY = '__widgetsMockStore';

export const config: MockEngineConfig<Store> = {
  spec,
  createStore,
  handlers,
  storeKey: STORE_KEY,
  session: { login: 'login', logout: 'logout' },
};

export const engine = createMockEngine(config);
export const { handleMockRequest, mockStore, resetMockStore } = engine;
