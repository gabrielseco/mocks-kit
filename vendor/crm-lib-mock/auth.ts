// Sign-in. The mock accepts any email with one fixed code and answers as the seeded user.
import type { Handlers } from "./types";

type AuthOperations = "requestLoginCode" | "verifyLoginCode" | "getCurrentUser" | "logout";

/** The code that signs in, with any email. Anything else is rejected. */
export const MOCK_LOGIN_CODE = "123456";

export const authHandlers: Pick<Handlers, AuthOperations> = {
  requestLoginCode: () => ({
    status: 200,
    body: { message: `Mock mode: sign in with the code ${MOCK_LOGIN_CODE}.` },
  }),

  // The session cookie itself is set by the server on a 200 from this operation.
  verifyLoginCode: ({ body, store }) =>
    body.code === MOCK_LOGIN_CODE
      ? { status: 200, body: { user: store.user } }
      : { status: 401, body: { error: "Invalid or expired code" } },

  getCurrentUser: ({ store }) => ({ status: 200, body: store.user }),

  logout: () => ({ status: 204 }),
};
