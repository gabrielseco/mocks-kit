import { defineConfig } from 'vitest/config';

// vendor/ keeps the apps' own mock tests as reference; they import app paths
// that do not exist here, so only the engine's tests run.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
