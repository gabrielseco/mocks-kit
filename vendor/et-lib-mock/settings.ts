// Settings: the two access tokens. The mock's are placeholders that
// authenticate nothing.
import { randomUUID } from 'node:crypto';
import type { Handlers } from './types';

type SettingsOperations =
  | 'getMcpToken'
  | 'regenerateMcpToken'
  | 'getServiceToken'
  | 'regenerateServiceToken';

const placeholder = (kind: string) => `mock-${kind}-token-${randomUUID()}`;

export const settingsHandlers: Pick<Handlers, SettingsOperations> = {
  getMcpToken: ({ store }) => ({
    status: 200,
    body: { mcp_token: store.mcpToken },
  }),

  regenerateMcpToken: ({ store }) => {
    store.mcpToken = placeholder('mcp');
    return { status: 200, body: { mcp_token: store.mcpToken } };
  },

  getServiceToken: ({ store }) => ({
    status: 200,
    body: { service_token: store.serviceToken },
  }),

  regenerateServiceToken: ({ store }) => {
    store.serviceToken = placeholder('service');
    return { status: 200, body: { service_token: store.serviceToken } };
  },
};
