// The widgets fixture served end to end through the engine.
import { beforeEach, describe, expect, it } from 'vitest';
import { engine, recordings } from '../fixtures/widgets/server';
import { call } from './call';

beforeEach(() => {
  engine.resetMockStore(recordings.clock);
});

describe('mock engine routing', () => {
  it("returns a handler's 200 with its body", async () => {
    const response = await call(engine, 'GET', '/api/widgets?limit=1');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.body).toEqual([
      { slug: 'anvil', name: 'Anvil', price: 120.5, created_on: '2026-01-15', note: null },
    ]);
  });

  it('passes decoded path parameters', async () => {
    const response = await call(engine, 'GET', '/api/widgets/b%6Flt');

    expect(response.status).toBe(200);
    expect(response.body.slug).toBe('bolt');
  });

  it('lets a literal path beat a {slug} path, even when the contract lists it second', async () => {
    const response = await call(engine, 'GET', '/api/widgets/featured');

    expect(response.status).toBe(200);
    expect(response.body.slug).toBe('anvil');
  });

  it('still routes other slugs to the {slug} path', async () => {
    expect((await call(engine, 'GET', '/api/widgets/nope')).status).toBe(404);
    expect((await call(engine, 'DELETE', '/api/widgets/cog')).status).toBe(204);
  });

  it('answers 501 with mock: true for a route the contract does not have', async () => {
    const response = await call(engine, 'GET', '/api/sprockets');

    expect(response.status).toBe(501);
    expect(response.body.mock).toBe(true);
    expect(response.body.error).toContain('GET /api/sprockets');
  });

  it('answers 501 for a method the contract does not have on a known path', async () => {
    const response = await call(engine, 'PUT', '/api/widgets/cog');

    expect(response.status).toBe(501);
    expect(response.body.mock).toBe(true);
  });

  it('answers 501 naming the operation when the app has no handler for it', async () => {
    const response = await call(engine, 'GET', '/api/gadgets');

    expect(response.status).toBe(501);
    expect(response.body).toEqual({
      error: expect.stringContaining('(listGadgets)'),
      mock: true,
    });
  });

  it('answers 401 on an authed route without the session cookie', async () => {
    const response = await call(engine, 'GET', '/api/widgets', { signedIn: false });

    expect(response).toMatchObject({ status: 401, body: { error: 'Unauthorized' } });
  });

  it('answers 401 for a wrong session value, and accepts it among other cookies', async () => {
    const wrong = await call(engine, 'GET', '/api/widgets', {
      cookie: 'session_token=forged',
    });
    const among = await call(engine, 'GET', '/api/widgets', {
      cookie: `theme=dark; ${engine.sessionCookie}; lang=en`,
    });

    expect(wrong.status).toBe(401);
    expect(among.status).toBe(200);
  });

  it('serves an unauthed route without a cookie', async () => {
    const response = await call(engine, 'GET', '/api/health', { signedIn: false });

    expect(response).toMatchObject({ status: 200, body: { status: 'ok' } });
  });
});
