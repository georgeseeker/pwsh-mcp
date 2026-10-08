// Watchdog test: verifies the in-pwsh watchdog thread reaps the pwsh child
// when the Node parent dies abruptly (SIGKILL, no cleanup handlers) while a
// long command blocks the bootstrap loop, so stdin-EOF cleanup cannot run.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const childPath = path.join(root, 'test', 'watchdog-child.mjs');

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(process.execPath, [childPath], { stdio: ['ignore', 'pipe', 'ignore'] });
let pidText = '';
child.stdout.on('data', (d) => {
  pidText += d.toString();
});
await new Promise((r) => child.once('close', r));

const pwshPid = Number.parseInt(pidText.trim(), 10);
if (!Number.isFinite(pwshPid)) {
  console.log('FAIL  could not determine the pwsh pid from the child');
  process.exit(1);
}

const deadline = Date.now() + 15000;
let reaped = false;
while (Date.now() < deadline) {
  if (!alive(pwshPid)) {
    reaped = true;
    break;
  }
  await sleep(250);
}
if (reaped) {
  console.log(`  ok  watchdog reaps blocked pwsh (pid ${pwshPid})`);
  process.exit(0);
}
console.log(`FAIL  orphan pwsh (pid ${pwshPid}) still alive after 15s`);
try {
  process.kill(pwshPid, 'SIGKILL');
} catch {}
process.exit(1);
