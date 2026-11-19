import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { integrate } from './integration.mjs';
import { precompress } from './precompress.mjs';
import { externalizeScripts } from './externalizeScripts.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const pin = JSON.parse(await readFile(path.join(root, 'upstream.json'), 'utf8'));
const work = path.join(root, '.build');
const source = path.join(work, 'source');
const archive = path.join(work, 'upstream.tar.gz');
await mkdir(work, { recursive: true });
function run(command, args, cwd = source, env = {}) {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
    if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
if (!existsSync(archive)) {
    const response = await fetch(`https://codeload.github.com/advplyr/audiobookshelf/tar.gz/${pin.commit}`);
    if (!response.ok) throw new Error(`Pinned Audiobookshelf source download failed (${response.status})`);
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
}
const checksum = createHash('sha256').update(await readFile(archive)).digest('hex');
if (checksum !== pin.archiveSha256) throw new Error('Audiobookshelf source archive checksum mismatch');
// Remove source files while retaining only the dependency cache between builds.
await mkdir(source, { recursive: true });
run('tar', ['-xzf', archive, '--strip-components=1', '-C', source]);
await rm(path.join(source, 'client/discordActivity'), { recursive: true, force: true });
await cp(path.join(root, 'src'), path.join(source, 'client/discordActivity'), { recursive: true });
async function replace(relative, before, after, occurrence) {
    const filename = path.join(source, relative);
    const text = await readFile(filename, 'utf8');
    const count = text.split(before).length - 1;
    if (count !== 1 && !(occurrence === 1 && count > 0)) throw new Error(`Upstream patch anchor changed: ${relative} (${count} matches)`);
    await writeFile(filename, text.replace(before, after));
}
await integrate(replace);
await cp(path.join(root, 'src/ActivityLogin.vue'), path.join(source, 'client/pages/login.vue'));
await cp(path.join(root, 'src/ActivityAccount.vue'), path.join(source, 'client/pages/account.vue'));
await mkdir(path.join(source, 'client/components/discord'), { recursive: true });
await cp(path.join(root, 'src/ActivityControls.vue'), path.join(source, 'client/components/discord/ActivityControls.vue'));
await replace('client/nuxt.config.js', "'@/plugins/axios.js'", "'@/discordActivity/axios.js'");
await writeFile(path.join(source, 'client/nuxt.config.js'), (await readFile(path.join(source, 'client/nuxt.config.js'), 'utf8')) + `
// Audited Discord Activity integration. Browser routes and media routes are separate.
module.exports.router = { base: '/', mode: 'hash' }
module.exports.plugins.push('@/discordActivity/runtime.js')
module.exports.buildModules = []
module.exports.modules = ['@nuxtjs/axios']
module.exports.head.title = 'Audiobookshelf Listen'
module.exports.head.script = [{ src: '/activity-storage.js' }, { src: '/activity-session.js' }]
module.exports.head.link = [{ rel: 'icon', href: '/branding/audiobookshelf-listen-icon.png' }]
module.exports.pwa = undefined
module.exports.generate = { fallback: 'index.html', crawler: false, routes: [] }
module.exports.build = { terser: { terserOptions: { compress: { drop_console: true } } } }
`);
await cp(path.join(root, 'branding'), path.join(source, 'client/static/branding'), { recursive: true });
await cp(path.join(root, 'src/storage.js'), path.join(source, 'client/static/activity-storage.js'));
if (!process.argv.includes('--prepare-only')) {
    const client = path.join(source, 'client');
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], client, { CYPRESS_INSTALL_BINARY: '0' });
    // Keep the upstream standalone worker intact: webpack rebundling can break
    // stringified worker factories, and blob workers need a broader iframe CSP.
    await cp(path.join(client, 'node_modules/hls.js/dist/hls.worker.js'), path.join(client, 'static/hls.worker.js'));
    await cp(path.join(client, 'node_modules/hls.js/dist/hls.worker.js.map'), path.join(client, 'static/hls.worker.js.map'));
    await cp(path.join(client, 'node_modules/hls.js/LICENSE'), path.join(client, 'static/HLS-LICENSE.txt'));
    run('npm', ['run', 'generate'], client, { NODE_ENV: 'production', ROUTER_BASE_PATH: '', NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=6144', CYPRESS_INSTALL_BINARY: '0' });
    await rm(path.join(root, 'dist'), { recursive: true, force: true });
    await cp(path.join(client, 'dist'), path.join(root, 'dist'), { recursive: true });
    await externalizeScripts(path.join(root, 'dist'));
    await cp(path.join(source, 'LICENSE'), path.join(root, 'dist/AUDIOBOOKSHELF-LICENSE.txt'));
    await writeFile(path.join(root, 'dist/AUDIOBOOKSHELF-SOURCE.json'), JSON.stringify(pin, null, 2) + '\n');
    run('tar', ['-czf', path.join(root, 'dist/corresponding-source.tar.gz'), '--exclude=./client/node_modules', '--exclude=./client/.nuxt', '--exclude=./client/dist', '--exclude=./node_modules', '--exclude=./dist', '-C', source, '.'], source);
    run('tar', ['-czf', path.join(root, 'dist/activity-source.tar.gz'), '--exclude=node_modules', '--exclude=dist', '--exclude=.build', '-C', path.dirname(root), 'LICENSE', 'README.md', 'Dockerfile', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'eslint.config.js', 'native-client', 'apps/activity-web/src', 'apps/activity-web/package.json', 'apps/activity-web/tsconfig.json', 'apps/activity-web/vite.config.ts', 'apps/api/src', 'apps/api/package.json', 'apps/api/tsconfig.json', 'packages/shared/src', 'packages/shared/package.json', 'packages/shared/tsconfig.json'], source);
    await precompress(path.join(root, 'dist'));
    console.info(`Built official Audiobookshelf ${pin.version} client at ${pin.commit}`);
}
