import { isBuiltin } from 'node:module';
import { resolve } from 'node:path';
import { normalizePath } from 'vite';
import type { Plugin } from 'vite';

/** Keep runtime-only modules out of the browser graph, including indirect imports. */
export function browserBoundary(): Plugin {
	let serverDirectories: string[] = [];

	function isServerPath(id: string): boolean {
		const path = normalizePath(id.split('?')[0]);
		return serverDirectories.some(directory => path === directory || path.startsWith(`${directory}/`));
	}

	return {
		name: 'rxjs-flow-browser-boundary',
		enforce: 'pre',
		applyToEnvironment(environment) {
			return environment.name === 'client';
		},
		configResolved(config) {
			serverDirectories = ['src/server', 'src/worker'].map(directory => normalizePath(resolve(config.root, directory)));
		},
		async resolveId(source, importer, options) {
			if (isPlatformImport(source) || isServerPath(source)) {
				this.error(`Browser boundary: server-only runtime import ${JSON.stringify(source)} is not allowed.`);
			}
			const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
			if (resolved && (isServerPath(resolved.id) || isPlatformImport(resolved.id))) {
				this.error(`Browser boundary: server-only runtime import ${JSON.stringify(source)} is not allowed.`);
			}
			return resolved;
		},
	};
}

function isPlatformImport(source: string): boolean {
	return source.startsWith('node:') || isBuiltin(source)
		|| source === 'hono' || source.startsWith('hono/')
		|| source === 'wrangler' || source.startsWith('wrangler/')
		|| source.startsWith('@cloudflare/') || source.startsWith('cloudflare:')
		|| /\/node_modules\/(?:hono|wrangler|@cloudflare)(?:\/|$)/.test(normalizePath(source));
}
