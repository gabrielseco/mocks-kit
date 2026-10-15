// The fixture app's handlers, typed with the engine's generic types narrowed
// to its own operations and store, the way an app would.
import {
  MockHttpError,
  type Handler as EngineHandler,
  type Handlers as EngineHandlers,
} from '../../../src/engine';
import type { operations } from './schema';
import type { Store } from './store';

export type OperationId = keyof operations;
export type Handler<Op extends OperationId> = EngineHandler<operations, Op, Store>;
/** listGadgets is left to the real backend: it answers 501. */
export type Handlers = EngineHandlers<operations, Store, Exclude<OperationId, 'listGadgets'>>;

export const LOGIN_CODE = '123456';

const byName = (store: Store) =>
  [...store.widgets].sort((a, b) => a.name.localeCompare(b.name));

export const handlers: Handlers = {
  login: ({ body, store }) =>
    body.code === LOGIN_CODE
      ? { status: 200, body: store.user }
      : { status: 401, body: { error: 'Invalid code' } },

  logout: () => ({ status: 204 }),

  getHealth: () => ({ status: 200, body: { status: 'ok' } }),

  listWidgets: ({ query, store }) => {
    const widgets = byName(store);
    return {
      status: 200,
      body: query.limit ? widgets.slice(0, Number(query.limit)) : widgets,
    };
  },

  getWidget: ({ path, store }) => {
    const widget = store.widgets.find((w) => w.slug === path.slug);
    return widget ? { status: 200, body: widget } : { status: 404 };
  },

  getFeaturedWidget: ({ store }) => ({
    status: 200,
    body: [...store.widgets].sort((a, b) => b.price - a.price)[0],
  }),

  createWidget: ({ body, store }) => {
    if (typeof body.price !== 'number') {
      throw new MockHttpError(400, 'price must be a number');
    }
    if (!body.name) return { status: 422, body: { error: 'name is required' } };
    const widget = {
      slug: body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name: body.name,
      price: body.price,
      created_on: '2026-01-15',
      note: null,
    };
    store.widgets.push(widget);
    return { status: 201, body: widget };
  },

  deleteWidget: ({ path, store }) => {
    const index = store.widgets.findIndex((w) => w.slug === path.slug);
    if (index === -1) return { status: 404 };
    store.widgets.splice(index, 1);
    return { status: 204 };
  },
};
