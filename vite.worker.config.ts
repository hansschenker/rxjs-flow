import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';
import { browserBoundary } from './scripts/browser-boundary';

export default defineConfig({
  plugins: [
    cloudflare({
      configPath: './wrangler.jsonc', remoteBindings: false, persistState: false,
      // Local verification needs no debugger or network-interface discovery.
      inspectorPort: false,
    }),
    browserBoundary(),
  ],
  oxc: { jsx: { runtime: 'classic', pragma: 'h', pragmaFrag: 'null' } },
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  preview: { host: '127.0.0.1', port: 4174, strictPort: true },
});
