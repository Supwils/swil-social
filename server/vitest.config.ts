import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/server.ts', // bootstrap, hard to unit-test in isolation
        'src/types/**',
      ],
      // Baseline (2026-04-27): 53% lines / 62% branches / 55% functions.
      // Thresholds set slightly below to absorb minor fluctuations; ratchet
      // up as coverage grows. Bump these intentionally — never lower them
      // to "make CI green" without a written reason.
      thresholds: {
        lines: 50,
        branches: 55,
        functions: 50,
        statements: 50,
      },
    },
  },
});
