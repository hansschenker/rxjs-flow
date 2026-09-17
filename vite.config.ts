import { defineConfig } from 'vite';
import { browserBoundary } from './scripts/browser-boundary';

export default defineConfig({
  plugins: [browserBoundary()],
  oxc: { jsx: { runtime: 'classic', pragma: 'h', pragmaFrag: 'null' } },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api/, ''),
      },
    },
  },
});
