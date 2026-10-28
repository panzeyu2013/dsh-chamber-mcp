import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    environment: 'node',
    // Keep every spec file in its own child process (env/global isolation) and
    // let independent files run concurrently; the heavy server/manager groups
    // are split into separate files so they actually occupy separate workers.
    pool: 'forks',
    fileParallelism: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: '.coverage',
      thresholds: {
        statements: 93,
        branches: 85,
        functions: 86,
        lines: 93,
      },
    },
  },
})
