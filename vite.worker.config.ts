import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';
import { browserBoundary } from './scripts/browser-boundary';

export default defineConfig(({ command, isPreview }) => ({
  plugins: [
    cloudflare({
      configPath: './wrangler.jsonc', remoteBindings: false,
      persistState: { path: process.env.RXJS_FLOW_LOCAL_STATE ?? '.wrangler/state' },
      config: config => ({ vars: {
        ...config.vars,
        TODO_ACCESS_POLICY: command === 'serve' && !isPreview ? 'local-loopback' : 'disabled',
      } }),
      // Local verification needs no debugger or network-interface discovery.
      inspectorPort: false,
    }),
    browserBoundary(),
  ],
  oxc: { jsx: { runtime: 'classic', pragma: 'h', pragmaFrag: 'null' } },
  environments: {
    client: { build: { manifest: true, rolldownOptions: {
      // Keep the executable host's ESM lifecycle handle available in built apps.
      input: ['index.html', 'm05d-live.html', 'src/client/browser.ts'],
      preserveEntrySignatures: 'exports-only',
    } } },
  },
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  preview: { host: '127.0.0.1', port: 4174, strictPort: true },
}));
