// Session cookie, store reset and the store's survival across module reloads.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockEngine } from '../../src/engine';
import { LOGIN_CODE } from '../fixtures/widgets/handlers';
import { config, engine, recordings, STORE_KEY } from '../fixtures/widgets/server';
import { call } from './call';

beforeEach(() => {
  engine.resetMockStore(recordings.clock);
});

describe('session cookie', () => {
  it('is set by a 200 from the login operation', async () => {
    const response = await call(engine, 'POST', '/api/auth/login', {
      body: { code: LOGIN_CODE },
      signedIn: false,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBe(
      'session_token=mock-session; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000',
    );
  });

  it('is not set when the login operation answers anything else', async () => {
    const response = await call(engine, 'POST', '/api/auth/login', {
      body: { code: 'wrong' },
      signedIn: false,
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('opens authed routes once sent back', async () => {
    const login = await call(engine, 'POST', '/api/auth/login', {
      body: { code: LOGIN_CODE },
      signedIn: false,
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];

    expect((await call(engine, 'GET', '/api/widgets', { cookie })).status).toBe(200);
  });

  it('is cleared by the logout operation', async () => {
    const response = await call(engine, 'POST', '/api/auth/logout');

    expect(response.status).toBe(204);
    expect(response.headers.get('set-cookie')).toBe(
      'session_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    );
  });

  it('follows the configured name, value and operations', async () => {
    const custom = createMockEngine({
      ...config,
      storeKey: '__widgetsSessionTestStore',
      session: { cookie: 'sid', value: 'let-me-in', login: 'login', logout: 'logout' },
    });

    const login = await call(custom, 'POST', '/api/auth/login', {
      body: { code: LOGIN_CODE },
      signedIn: false,
    });

    expect(custom.sessionCookie).toBe('sid=let-me-in');
    expect(login.headers.get('set-cookie')).toMatch(/^sid=let-me-in; /);
    expect((await call(custom, 'GET', '/api/widgets', { cookie: 'sid=let-me-in' })).status).toBe(
      200,
    );
    expect(
      (await call(custom, 'GET', '/api/widgets', { cookie: 'session_token=mock-session' })).status,
    ).toBe(401);
  });

  it('is never touched by an app with no login or logout operation configured', async () => {
    const plain = createMockEngine({
      ...config,
      storeKey: '__widgetsSessionTestStore',
      session: undefined,
    });

    const login = await call(plain, 'POST', '/api/auth/login', {
      body: { code: LOGIN_CODE },
      signedIn: false,
    });
    const logout = await call(plain, 'POST', '/api/auth/logout');

    expect(login.status).toBe(200);
    expect(login.headers.get('set-cookie')).toBeNull();
    expect(logout.status).toBe(204);
    expect(logout.headers.get('set-cookie')).toBeNull();
  });
});

describe('store reset', () => {
  it('empties what a test created and answers 204', async () => {
    await call(engine, 'POST', '/api/widgets', { body: { name: 'Nut', price: 0.1 } });
    expect((await call(engine, 'GET', '/api/widgets')).body).toHaveLength(4);

    const reset = await call(engine, 'POST', '/api/__mock/reset', { signedIn: false });

    expect(reset).toMatchObject({ status: 204, body: null });
    expect((await call(engine, 'GET', '/api/widgets')).body).toHaveLength(3);
  });

  it('anchors the fresh store on today, which MOCK_TODAY pins', async () => {
    vi.stubEnv('MOCK_TODAY', '2026-03-01');
    try {
      await call(engine, 'POST', '/api/__mock/reset');
      const featured = await call(engine, 'GET', '/api/widgets/featured');

      expect(featured.body.created_on).toBe('2026-03-01');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('takes "today" from the app when given', async () => {
    const pinned = createMockEngine({
      ...config,
      storeKey: '__widgetsSessionTestStore',
      today: () => '2025-12-31',
    });

    await call(pinned, 'POST', '/api/__mock/reset');

    expect((await call(pinned, 'GET', '/api/widgets/featured')).body.created_on).toBe('2025-12-31');
  });

  it('listens on the configured path only', async () => {
    const custom = createMockEngine({
      ...config,
      storeKey: '__widgetsSessionTestStore',
      resetPath: '/__reset',
    });

    expect((await call(custom, 'POST', '/__reset')).status).toBe(204);
    expect((await call(custom, 'POST', '/api/__mock/reset')).status).toBe(501);
    expect((await call(custom, 'GET', '/__reset')).status).toBe(501);
  });
});

describe('store across module reloads', () => {
  it('keeps its data in the globalThis slot named by the app', async () => {
    vi.resetModules();
    const first = await import('../fixtures/widgets/server');
    await call(first.engine, 'POST', '/api/widgets', { body: { name: 'Nut', price: 0.1 } });

    vi.resetModules();
    const reloaded = await import('../fixtures/widgets/server');

    expect(reloaded.engine).not.toBe(first.engine);
    expect(reloaded.mockStore()).toBe(first.mockStore());
    expect(reloaded.mockStore()).toBe((globalThis as Record<string, unknown>)[STORE_KEY]);
    const names = (await call(reloaded.engine, 'GET', '/api/widgets')).body.map(
      (w: { name: string }) => w.name,
    );
    expect(names).toContain('Nut');
  });

  it('keeps separate stores under separate keys', () => {
    const other = createMockEngine({ ...config, storeKey: '__widgetsOtherStore' });

    expect(other.mockStore()).not.toBe(engine.mockStore());
  });
});
