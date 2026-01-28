import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    target: 'es2020',
  },
  test: {
    // Use globals (describe, it, expect) without importing
    globals: true,

    // Test environment
    environment: 'node',

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json'],
      exclude: [
        'node_modules/**',
        'dist/**',
        'tests/**',
        '**/*.test.ts',
        '**/*.spec.ts',
        'vitest.config.ts',
        '**/*.d.ts',
        'examples/**',
      ],
      include: ['src/**/*.ts'],
      // Require 80% coverage
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },

    // Test file patterns
    include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts'],
    exclude: ['node_modules', 'dist'],

    // Timeouts
    testTimeout: 10000,
    hookTimeout: 10000,

    // Behavior
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
  },
});
