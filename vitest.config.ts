import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: { jsx: { runtime: 'classic', pragma: 'h', pragmaFrag: 'null' } },
  test: {
    projects: [
      { extends: true, test: {
        name: 'dom', environment: 'jsdom', globals: true,
        include: ['src/client/**/*.test.ts', 'src/claude-md.test.ts'],
      } },
      { extends: true, test: {
        name: 'node', environment: 'node', globals: true,
        include: ['src/server/**/*.test.ts', 'src/shared/**/*.test.ts', 'scripts/**/*.test.ts'],
      } },
    ],
  },
});
