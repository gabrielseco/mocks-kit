// A mock that answers outside the contract is a bug in the mock: the engine
// turns it into a 500 that names the operation and the reason.
import { describe, expect, it } from 'vitest';
import { createMockEngine, MockHttpError, type AnyHandler } from '../../src/engine';
import { handlers, type Handler } from '../fixtures/widgets/handlers';
import { config } from '../fixtures/widgets/server';
import { call } from './call';

const bolt = { slug: 'bolt', name: 'Bolt', price: 2.25, created_on: '2026-01-14' };

function engineWith(overrides: Record<string, AnyHandler>) {
  return createMockEngine({
    ...config,
    storeKey: '__widgetsContractTestStore',
    handlers: { ...handlers, ...overrides },
  });
}

describe('contract violations', () => {
  it('answers 500 for a field of the wrong type', async () => {
    const engine = engineWith({
      getWidget: () => ({ status: 200, body: { ...bolt, price: '2.25' } }),
    });

    const response = await call(engine, 'GET', '/api/widgets/bolt');

    expect(response).toEqual({
      status: 500,
      headers: expect.anything(),
      body: {
        error:
          'The mock getWidget response breaks the contract: $.price: is string, expected number',
        mock: true,
      },
    });
  });

  it('answers 500 for a status the operation does not declare', async () => {
    const engine = engineWith({ getWidget: () => ({ status: 418, body: bolt }) });

    const response = await call(engine, 'GET', '/api/widgets/bolt');

    expect(response.status).toBe(500);
    expect(response.body.error).toBe(
      'The mock getWidget response breaks the contract: status 418 is not declared for getWidget',
    );
  });

  it('reports every problem: undeclared keys, missing ones, bad formats and patterns', async () => {
    const engine = engineWith({
      listWidgets: () => ({
        status: 200,
        body: [
          { slug: 'Not A Slug', name: 'X', price: 1, created_on: '15/01/2026', colour: 'red' },
        ],
      }),
      getFeaturedWidget: () => ({ status: 200, body: { slug: 'x', name: 'X', price: 1 } }),
    });

    const list = await call(engine, 'GET', '/api/widgets');
    const featured = await call(engine, 'GET', '/api/widgets/featured');

    expect(list.body.error).toContain('listWidgets');
    expect(list.body.error).toContain('$[0].slug: "Not A Slug" does not match ^[a-z0-9-]+$');
    expect(list.body.error).toContain('$[0].created_on: "15/01/2026" is not an ISO 8601 date');
    expect(list.body.error).toContain('$[0].colour: is not declared in the schema');
    expect(featured.body.error).toContain('$.created_on: is missing');
  });

  it('answers 500 for a body where none is declared, and for none where one is', async () => {
    const engine = engineWith({
      deleteWidget: () => ({ status: 204, body: { deleted: true } }),
      getHealth: () => ({ status: 200 }),
    });

    const deleted = await call(engine, 'DELETE', '/api/widgets/bolt');
    const health = await call(engine, 'GET', '/api/health');

    expect(deleted.body.error).toContain('deleteWidget');
    expect(deleted.body.error).toContain('a body was sent where none is declared');
    expect(health.body.error).toContain('no body was sent where one is declared');
  });

  it('accepts null for a nullable field', async () => {
    const engine = engineWith({
      getWidget: () => ({ status: 200, body: { ...bolt, note: null } }),
    });

    expect((await call(engine, 'GET', '/api/widgets/bolt')).status).toBe(200);
  });
});

describe('request errors', () => {
  const engine = engineWith({});

  it('answers 400 for a body that is not JSON', async () => {
    const response = await call(engine, 'POST', '/api/widgets', { raw: '{"name": ' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'request body is not valid JSON', mock: true });
  });

  it('keeps the status of a MockHttpError a handler throws', async () => {
    const response = await call(engine, 'POST', '/api/widgets', {
      body: { name: 'Nut', price: 'free' },
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'price must be a number', mock: true });
  });

  it('keeps any status of a MockHttpError, even one the contract does not declare', async () => {
    const teapot = engineWith({
      getWidget: () => {
        throw new MockHttpError(503, 'backend is warming up');
      },
    });

    const response = await call(teapot, 'GET', '/api/widgets/bolt');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'backend is warming up', mock: true });
  });

  it('lets any other error through', async () => {
    const broken = engineWith({
      getWidget: () => {
        throw new TypeError('handler bug');
      },
    });

    await expect(call(broken, 'GET', '/api/widgets/bolt')).rejects.toThrow('handler bug');
  });

  it('gives a handler an empty object when a body is declared but none is sent', async () => {
    const response = await call(engine, 'POST', '/api/widgets');

    expect(response.status).toBe(400);
  });
});

describe('handler types', () => {
  it('reject a body or status the contract does not declare', () => {
    // @ts-expect-error price must be a number
    const wrongField: Handler<'getWidget'> = () => ({ status: 200, body: { ...bolt, price: '1' } });
    // @ts-expect-error getWidget declares no 418
    const wrongStatus: Handler<'getWidget'> = () => ({ status: 418 });
    // @ts-expect-error a 404 of getWidget has no body
    const bodyOn404: Handler<'getWidget'> = () => ({ status: 404, body: bolt });
    const typed: Handler<'getWidget'> = ({ path }) =>
      path.slug ? { status: 404 } : { status: 200, body: bolt };

    expect([wrongField, wrongStatus, bodyOn404, typed]).toHaveLength(4);
  });
});
