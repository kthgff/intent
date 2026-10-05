import { defineConfig } from 'vitest/config';

/**
 * The conductor suites run against a real PostgresStore (PGlite) and
 * exercise tick loops, leases, and container lifecycles — a single case
 * routinely costs seconds, and under parallel agent/CI load the 5s
 * default produces false timeouts. Timeouts here are environmental,
 * not hangs (the suites finish well inside these bounds on an idle
 * machine).
 */
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
