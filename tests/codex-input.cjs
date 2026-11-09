'use strict';
// Opens a disposable Codex composer. No Enter/submit or synthetic keys are sent.
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { captureTarget, inject } = require('../src/inject');
const dir = fs.mkdtempSync('/data/scratch/mimo-codex-input-');
const output = `${dir}/screen.txt`;
(async () => {
  const terminal = spawn('cosmic-term', ['-e', 'script', '-q', '-f', '-c', 'codex --no-alt-screen --no-daemon -c check_for_update_on_startup=false', output],
    { cwd: '/home/rap', stdio: ['ignore', 'ignore', 'pipe'] });
  terminal.stderr.on('data', b => process.stderr.write(b));
  try {
    await delay(4000);
    const before = fs.readFileSync(output, 'utf8');
    if (!before.includes('context') && !before.includes('OpenAI Codex')) throw new Error(`Codex composer not ready; inspect ${output}`);
    const marker = '语音注入验证MIMO7391';
    fs.writeFileSync(`${dir}/focus.txt`, execFileSync('gdbus', ['call', '--session', '--dest', 'org.fcitx.Fcitx5', '--object-path', '/controller', '--method', 'org.fcitx.Fcitx.Controller1.DebugInfo']));
    console.log('screenshot', execFileSync('cosmic-screenshot', ['--interactive=false', '--modal=false', '--notify=false', '--save-dir', dir], { encoding: 'utf8', timeout: 5000 }).trim());
    const result = await inject(marker, { target: await captureTarget() });
    console.log('bridge reply', result);
    if (!result.ok) throw new Error(result.reason);
    await delay(1200);
    const after = fs.readFileSync(output, 'utf8').slice(before.length);
    fs.writeFileSync(`${dir}/after.txt`, after);
    const plain = after.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    if (!plain.includes(marker)) throw new Error(`Bridge accepted but Codex composer did not echo the marker. Inspect ${dir}`);
    console.log(`PASS: actual Codex composer echoed ${marker}; no submission; evidence ${dir}`);
    const screen = execFileSync('cosmic-screenshot', ['--interactive=false', '--modal=false', '--notify=false', '--save-dir', dir], { encoding: 'utf8', timeout: 5000 });
    console.log('screenshot', screen.trim());
  } finally {
    // cosmic-term can fork; killing the launcher alone leaves its script/Codex child running.
    function stopTree(pid) {
      try {
        const children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
        for (const child of children) stopTree(Number(child));
        process.kill(pid, 'SIGTERM');
      } catch (_) {}
    }
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const args = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0');
        if ((args[0] === 'script' || args[0]?.endsWith('/script')) && args.includes(output)) stopTree(Number(entry));
      } catch (_) {}
    }
    terminal.kill();
  }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
