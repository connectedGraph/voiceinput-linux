'use strict';
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const dir = '/data/scratch/mimo-asr-clipboard-test';
fs.mkdirSync(dir, { recursive: true });
const current = spawnSync('wl-paste', ['--list-types'], { encoding: 'utf8' });
const originalTypes = current.status === 0 ? current.stdout.trim().split('\n').filter(Boolean) : [];
const manifest = [];
for (const [i, mime] of originalTypes.entries()) {
  const value = spawnSync('wl-paste', ['--no-newline', '--type', mime], { maxBuffer: 64 * 1024 * 1024 });
  if (value.status !== 0) throw new Error(`Unable to snapshot ${mime}`);
  const file = path.join(dir, `original-${i}.bin`);
  fs.writeFileSync(file, value.stdout);
  manifest.push(`${mime}\t${file}`);
}
const originalManifest = path.join(dir, 'original.txt');
fs.writeFileSync(originalManifest, manifest.join('\n') + (manifest.length ? '\n' : ''));
let restorer = null;
const owner = spawn(path.join(root, 'build', 'clipboard-fixture'), [path.join(root, 'assets', 'icon.png')],
  { env: { ...process.env, GDK_BACKEND: 'x11' }, stdio: ['ignore', 'pipe', 'inherit'] });
owner.once('error', error => { console.error(error); process.exitCode = 1; });
owner.stdout.once('data', () => {
  const types = spawnSync('wl-paste', ['--list-types'], { encoding: 'utf8' }).stdout;
  if (!types.includes('image/png') || !types.includes('text/html') || !types.includes('application/x-mimo-binary')) {
    console.error(`Clipboard fixture did not advertise all MIME types: ${types}`);
    owner.kill(); process.exitCode = 1; return;
  }
  const runner = spawn(path.join(root, 'node_modules', 'electron', 'dist', 'electron'),
    [path.join(__dirname, 'desktop.cjs'), '--no-sandbox'], { stdio: 'inherit' });
  runner.on('exit', async code => {
    owner.kill();
    await delay(300);
    if (manifest.length) {
      restorer = spawn(path.join(root, 'build', 'clipboard-fixture'), [`--restore=${originalManifest}`],
        { env: { ...process.env, GDK_BACKEND: 'x11' }, stdio: ['ignore', 'ignore', 'inherit'] });
      await new Promise(resolve => restorer.once('spawn', resolve));
      await delay(300);
      const restored = spawnSync('wl-paste', ['--list-types'], { encoding: 'utf8' });
      const restoredTypes = restored.stdout.trim().split('\n').filter(Boolean).sort();
      if (JSON.stringify(restoredTypes) !== JSON.stringify([...originalTypes].sort())) code = 1;
      for (const [i, mime] of originalTypes.entries()) {
        const value = spawnSync('wl-paste', ['--no-newline', '--type', mime], { maxBuffer: 64 * 1024 * 1024 });
        if (value.status !== 0 || !value.stdout.equals(fs.readFileSync(path.join(dir, `original-${i}.bin`)))) code = 1;
      }
      if (code) console.error('The original clipboard formats/bytes were not restored exactly.');
      else console.log('PASS: the original multi-format clipboard was restored byte-for-byte');
    }
    process.exitCode = code || 0;
  });
});
process.on('exit', () => { owner.kill(); if (restorer) restorer.unref(); });
