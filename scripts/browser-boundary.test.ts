import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createBuilder, type InlineConfig } from 'vite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserBoundary } from './browser-boundary';

const repository = fileURLToPath(new URL('..', import.meta.url));
let fixture: string;

beforeEach(async function createFixture() {
	fixture = await mkdtemp(resolve(repository, '.m05a-boundary-'));
});

afterEach(async function removeFixture() {
	vi.unstubAllEnvs();
	await rm(fixture, { recursive: true, force: true });
});

async function writeFixture(path: string, contents: string): Promise<string> {
	const target = resolve(fixture, path);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, contents);
	return target;
}

async function buildBrowser(source: string, options: InlineConfig = {}): Promise<string> {
	const entry = await writeFixture('src/client/entry.tsx', source);
	const result = await build({
		root: fixture,
		configFile: false,
		logLevel: 'silent',
		plugins: [browserBoundary()],
		oxc: { jsx: { runtime: 'classic', pragma: 'h', pragmaFrag: 'null' } },
		build: { write: false, minify: false, lib: { entry, formats: ['es'] } },
		...options,
	});
	if ('on' in result) throw new Error('A one-shot build must not return a watcher.');
	const outputs = Array.isArray(result) ? result : [result];
	return outputs.flatMap(output => output.output)
		.filter(output => output.type === 'chunk')
		.map(output => output.code).join('\n');
}

describe('browser bundle boundary', () => {
	it('builds the existing custom JSX helper with browser RxJS and Zod', async () => {
		const helper = resolve(repository, 'src/client/h.ts');
		const output = await buildBrowser(`
			import { h } from ${JSON.stringify(helper)};
			import { of } from 'rxjs';
			import { z } from 'zod';
			export function render() {
				const title = z.string().parse('browser JSX checkpoint');
				of(title).subscribe(value => document.body.appendChild(<p>{value}</p>));
			}
		`);
		expect(output).toContain('browser JSX checkpoint');
		expect(output).not.toContain('React.createElement');
	});

	it.each(['server', 'worker'])('rejects a runtime import from src/%s', async directory => {
		await writeFixture(`src/${directory}/private.ts`, 'export const secret = "server-only fixture";');
		await expect(buildBrowser(`export { secret } from '../${directory}/private';`))
			.rejects.toThrow(/browser boundary.*server-only/i);
	});

	it('rejects a server import hidden behind a shared module and an alias', async () => {
		const server = await writeFixture('src/server/private.ts', 'export const secret = "server-only fixture";');
		await writeFixture('src/shared/value.ts', 'export { secret } from "@private";');
		await expect(buildBrowser('export { secret } from "../shared/value";', {
			resolve: { alias: { '@private': server } },
		})).rejects.toThrow(/browser boundary.*server-only/i);
	});

	it('rejects a dynamic Worker import', async () => {
		await writeFixture('src/worker/private.ts', 'export const secret = "server-only fixture";');
		await expect(buildBrowser('export function load() { return import("../worker/private"); }'))
			.rejects.toThrow(/browser boundary.*server-only/i);
	});

	it('rejects an alias directly to a server package file', async () => {
		await expect(buildBrowser('export { Hono } from "@platform";', {
			resolve: { alias: { '@platform': resolve(repository, 'node_modules/hono/dist/index.js') } },
		})).rejects.toThrow(/browser boundary.*server-only/i);
	});

	it.each(['node:fs', 'fs', 'node:crypto', 'hono', 'hono/client', 'wrangler', '@cloudflare/vite-plugin', 'cloudflare:workers'])(
		'rejects runtime platform import %s', async specifier => {
			await expect(buildBrowser(`import * as platform from ${JSON.stringify(specifier)}; export { platform };`))
				.rejects.toThrow(/browser boundary.*server-only/i);
		},
	);

	it('allows a type-only server contract that produces no browser runtime import', async () => {
		await writeFixture('src/server/contract.ts', 'export interface Contract { title: string }');
		const output = await buildBrowser(`
			import type { Contract } from '../server/contract';
			export const value: Contract = { title: 'type-only contract' };
		`);
		expect(output).toContain('type-only contract');
	});

	it('exposes an explicit public variable and omits a synthetic private environment value', async () => {
		vi.stubEnv('VITE_M05A_PUBLIC_CANARY', 'public-browser-value-48da');
		vi.stubEnv('M05A_PRIVATE_CANARY', 'private-server-value-715d');
		const output = await buildBrowser(`
			export const publicValue = import.meta.env.VITE_M05A_PUBLIC_CANARY;
			export const privateValue = import.meta.env.M05A_PRIVATE_CANARY;
		`);
		expect(output).toContain('public-browser-value-48da');
		expect(output).not.toContain('private-server-value-715d');
	});

	it('allows Hono and server modules in the separate Worker build environment', async () => {
		await writeFixture('src/server/probe.ts', 'export const value = "Worker-only checkpoint";');
		const entry = await writeFixture('src/worker/entry.ts', `
			import { Hono } from 'hono';
			import { value } from '../server/probe';
			const app = new Hono();
			app.get('/probe', context => context.text(value));
			export default app;
		`);
		const builder = await createBuilder({
			root: fixture,
			configFile: false,
			logLevel: 'silent',
			plugins: [browserBoundary()],
			environments: {
				worker: { consumer: 'server', build: { ssr: entry, write: false, minify: false } },
			},
		});
		const result = await builder.build(builder.environments.worker);
		if (Array.isArray(result) || 'on' in result) throw new Error('Expected one Worker build output.');
		const code = result.output.filter(output => output.type === 'chunk').map(output => output.code).join('\n');
		expect(code).toContain('Worker-only checkpoint');
	});
});
