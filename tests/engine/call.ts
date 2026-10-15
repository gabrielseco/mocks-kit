// Sends one request to a mock engine, the way the app's route handler would.
import type { MockEngine } from '../../src/engine';

export interface CallOptions {
  body?: unknown;
  /** Raw request body, sent as is (for invalid JSON). */
  raw?: string;
  /** Send the signed-in session cookie. Default true. */
  signedIn?: boolean;
  cookie?: string;
}

export async function call<Store>(
  engine: MockEngine<Store>,
  method: string,
  path: string,
  { body, raw, signedIn = true, cookie }: CallOptions = {},
) {
  const headers: Record<string, string> = {};
  const sent = cookie ?? (signedIn ? engine.sessionCookie : undefined);
  if (sent) headers.cookie = sent;

  const response = await engine.handleMockRequest(
    new Request(new URL(path, 'http://mock.test'), {
      method,
      headers,
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text === '' ? null : JSON.parse(text),
  };
}
