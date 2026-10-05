import { defineConfig } from 'vitest/config';

/**
 * These tests shell out to real `git` (clone/commit/push/rebase in temp
 * repos). Under a loaded CI/agent machine a single clone+push cycle
 * routinely exceeds vitest's 5s default — the timeout is environmental,
 * not a hang.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
