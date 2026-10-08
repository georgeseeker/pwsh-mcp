// Helper for the watchdog test: starts a pwsh session, blocks it with a long
// command, prints the pwsh PID, then kills its own process abruptly (SIGKILL,
// no cleanup handlers run). The pwsh child must then be reaped by the
// in-pwsh watchdog thread alone. Driven by test/watchdog.mjs.
import { PwshSession } from '../src/session.mjs';

const session = new PwshSession();
const pid = await session.ensureStarted();
console.log(pid);
session.run('Start-Sleep -Seconds 120').catch(() => {});
setTimeout(() => process.kill(process.pid, 'SIGKILL'), 1500);
