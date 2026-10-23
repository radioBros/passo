import { defineConfig } from 'vitest/config';
import { config as loadEnv } from 'dotenv';

// Point the suite at the local `passo` docker stack. Integration tests run
// against real Postgres, RabbitMQ and Redis — a passing test therefore
// exercised the same RLS policies and broker topology as production.
loadEnv({ path: '.env.test' });

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration suites share a database; running files in parallel produces
    // cross-suite interference on shared tables.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/cli/**', 'src/**/*.d.ts'],
      // Set just under the achieved level, so a regression fails CI rather
      // than quietly eroding coverage. Raise these when coverage rises; never
      // lower them to make a red build green.
      //
      // Re-baselined 2026-10-01 for a MEASUREMENT change, not a regression:
      // vitest 2 -> 5 (forced by critical advisories) remaps v8 coverage by
      // AST, which roughly halved the statement count (5203 -> 2697) and counts
      // more functions. The same tests on the same code read 87.8% stmts under
      // the old method and 81.2% / 84.8% lines / 78.0% fns / 74.0% branches now.
      thresholds: { lines: 84, functions: 77, branches: 73, statements: 80 },
    },
  },
});
