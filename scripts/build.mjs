import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/extension.ts', 'src/transport/broker/broker.ts'], outdir: 'dist', outbase: 'src', bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', sourcemap: true, define: { __PI_COMMS_PACKAGE_VERSION__: JSON.stringify(version) }, banner: { js: '// Includes MIT-adapted pi-intercom code. See THIRD-PARTY-NOTICES.md.' } });
await writeFile('dist/VERSION', version + '\n');
