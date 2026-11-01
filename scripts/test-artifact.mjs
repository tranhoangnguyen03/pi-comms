import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = mkdtempSync(join(tmpdir(), 'pc-package-'));
try {
  execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], { encoding: 'utf8' }));
  assert.ok(pack.files.some(f => f.path === 'dist/extension.js'));
  assert.ok(pack.files.some(f => f.path === 'dist/transport/broker/broker.js'));
  assert.ok(pack.files.some(f => f.path === 'THIRD-PARTY-NOTICES.md'));
  assert.ok(pack.files.some(f => f.path === 'skills/pi-comms/SKILL.md'), 'on-demand collaboration skill must be included');
  assert.ok(!pack.files.some(f => /^(prototype|test|src|\.scratch|node_modules)\//.test(f.path)));
  const prefix = join(root, 'install'); mkdirSync(prefix);
  writeFileSync(join(prefix, 'package.json'), '{"private":true,"type":"module"}');
  execFileSync('npm', ['install', '--ignore-scripts', '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund', join(root, pack.filename)], { cwd: prefix, stdio: 'inherit' });
  const installed = join(prefix, 'node_modules/pi-comms');
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  const sourceManifest = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(manifest.version, sourceManifest.version); assert.deepEqual(manifest.pi.extensions, ['./dist/extension.js']); assert.deepEqual(manifest.pi.skills, ['./skills']);
  assert.equal(manifest.dependencies, undefined, 'no runtime dependencies bundled; host supplies Pi/typebox/TUI');
  // Load through the real Pi resource loader, which supplies host module mappings.
  const sdk = pathToFileURL(resolve('node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href;
  const probe = `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DefaultResourceLoader } from ${JSON.stringify(sdk)};
const loader = new DefaultResourceLoader({ cwd: ${JSON.stringify(prefix)}, agentDir: ${JSON.stringify(join(root, 'agent'))}, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [${JSON.stringify(join(installed, 'dist/extension.js'))}] });
await loader.reload();
const result = loader.getExtensions(); assert.deepEqual(result.errors, []); assert.equal(result.extensions.length, 1); console.log('Installed artifact loaded by Pi 1.4.0');

// Load the *package root*, not only the compiled extension. The package manifest
// must advertise its skill to Pi's normal resource loader.
const packageLoader = new DefaultResourceLoader({
  cwd: ${JSON.stringify(prefix)},
  agentDir: ${JSON.stringify(join(root, 'agent'))},
  noExtensions: true, noSkills: false, noPromptTemplates: true, noThemes: true,
  noContextFiles: true, additionalExtensionPaths: [${JSON.stringify(installed)}],
});
await packageLoader.reload();
const packageResult = packageLoader.getExtensions();
assert.deepEqual(packageResult.errors, []);
assert.equal(packageResult.extensions.length, 1, 'package root must expose the extension');
const discovered = packageLoader.getSkills();
assert.deepEqual(discovered.diagnostics.filter(d => d.type === 'error'), [], 'skill discovery must have no errors');
const matches = discovered.skills.filter(s => s.name === 'pi-comms');
assert.equal(matches.length, 1, 'installed package must advertise exactly one pi-comms skill');
assert.ok(matches[0].filePath.startsWith(${JSON.stringify(installed)}), 'skill must load from installed artifact');
assert.match(readFileSync(matches[0].filePath, 'utf8'), /# Communicate with Pi colleagues/);
console.log('Installed package advertises pi-comms skill through Pi resource loader');`;
  const file = join(root, 'probe.mjs'); writeFileSync(file, probe);
  execFileSync(process.execPath, [file], { env: { ...process.env, PI_CODING_AGENT_DIR: join(root, 'agent') }, stdio: 'inherit' });
  execFileSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', 'test/base-integration.test.ts', 'test/base-shutdown.test.ts'], { env: { ...process.env, PI_COMMS_TEST_EXTENSION: join(installed, 'dist/extension.js') }, stdio: 'inherit' });
  console.log(`Verified ${pack.filename}: ${pack.size} packed bytes; ${pack.unpackedSize} unpacked bytes`);
} finally { rmSync(root, { recursive: true, force: true }); }
