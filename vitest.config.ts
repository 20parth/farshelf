import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        test: {
          name: 'server',
          include: ['tests/server/**/*.test.ts'],
          environment: 'node',
          testTimeout: 20000,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'web',
          include: ['tests/web/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['tests/web/setup.ts'],
        },
      },
    ],
  },
});
