import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    // Tests share one Postgres and truncate between cases — run files serially.
    fileParallelism: false,
    include: ['test/**/*.test.ts'],
  },
});
