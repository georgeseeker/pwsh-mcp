import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFIX = '@@PWSH_MCP@@';
const BOOTSTRAP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bootstrap.ps1');
const PROCESS_START_MS = Date.now() - Math.round(process.uptime() * 1000);

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// PowerShell prepends the per-user module directories to the inherited
// PSModulePath, so their presence marks a terminal launched from a
// PowerShell-family shell (pwsh or Windows PowerShell).
export function detectPwshTerminal(env = process.env) {
  const modulePath = env.PSModulePath ?? '';
  return /[\\/]Documents[\\/](PowerShell|WindowsPowerShell)[\\/]Modules/i.test(modulePath);
}

function resolveLoadProfile(override) {
  if (override != null) return !!override;
  const setting = process.env.PWSH_MCP_LOAD_PROFILE;
  if (setting === '1') return true;
  if (setting === '0') return false;
  const detected = detectPwshTerminal();
  process.stderr.write(`[pwsh-mcp] PowerShell terminal detected: ${detected}; loading user profile: ${detected}\n`);
  return detected;
}

function renderSnap(snap) {
  if (!snap.over) return snap.headText;
  const sep = snap.omitted > 0 ? `\n... [pwsh-mcp: ~${snap.omitted} characters omitted] ...\n` : '\n';
  return `${snap.headText}${sep}${snap.tailText}`;
}

// Bounded collector: keeps a head chunk plus a rolling tail so output size
// cannot exhaust memory, while still draining the pipe until the end frame.
function createPending(id, child, maxChars, resolve, reject) {
  const headBudget = Math.floor(maxChars * 0.6);
  const tailBudget = Math.max(maxChars - headBudget, 1);
  const head = [];
  let headLen = 0;
  const tail = [];
  let tailLen = 0;
  let omitted = 0;
  let over = false;

  return {
    id,
    child,
    resolve,
    reject,
    timer: null,
    push(line) {
      if (!over && headLen + line.length + 1 <= headBudget) {
        head.push(line);
        headLen += line.length + 1;
        return;
      }
      over = true;
      let add = line;
      if (add.length + 1 > tailBudget) {
        omitted += add.length + 1 - tailBudget;
        add = add.slice(-tailBudget);
      }
      tail.push(add);
      tailLen += add.length + 1;
      while (tailLen > tailBudget && tail.length > 1) {
        const dropped = tail.shift();
        tailLen -= dropped.length + 1;
        omitted += dropped.length + 1;
      }
    },
    snapshot() {
      return { headText: head.join('\n'), tailText: tail.join('\n'), omitted, over };
    },
  };
}

export class PwshSession {
  constructor(options = {}) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? 20000;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? envInt('PWSH_MCP_TIMEOUT_MS', 300000);
    this.defaultMaxOutputChars = options.defaultMaxOutputChars ?? envInt('PWSH_MCP_MAX_OUTPUT_CHARS', 500000);
    this.loadProfile = resolveLoadProfile(options.loadProfile);
    this.exeOverride = options.exe ?? process.env.PWSH_MCP_PWSH ?? null;

    this.child = null;
    this.childPid = null;
    this.startPromise = null;
    this.pending = null;
    this.restarted = false;
    this.disposed = false;
    this.queue = Promise.resolve();
  }

  ensureStarted() {
    if (this.child && this.child.exitCode === null && !this.#pidGone()) return Promise.resolve(this.childPid);
    if (this.child) {
      // Previous child died but its exit event has not been processed yet.
      this.child = null;
      this.childPid = null;
      this.restarted = true;
    }
    if (!this.startPromise) {
      this.startPromise = this.#start().finally(() => {
        this.startPromise = null;
      });
    }
    return this.startPromise;
  }

  #pidGone() {
    if (typeof this.childPid !== 'number') return true;
    try {
      process.kill(this.childPid, 0);
      return false;
    } catch {
      return true;
    }
  }

  run(command, options = {}) {
    const task = () => this.#runOnce(String(command), options);
    const result = this.queue.then(task);
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  reset() {
    const task = async () => {
      if (this.disposed) throw Object.assign(new Error('pwsh session has been disposed'), { code: 'DISPOSED' });
      const old = this.child;
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        clearTimeout(p.timer);
        p.reject(Object.assign(new Error('pwsh session was reset while the command was running'), {
          code: 'RESET',
          partial: renderSnap(p.snapshot()),
        }));
      }
      this.child = null;
      this.childPid = null;
      if (old) {
        this.#killTree(old);
        await this.#waitExit(old, 3000);
      }
      this.restarted = false;
      await this.ensureStarted();
      return { pid: this.childPid };
    };
    const result = this.queue.then(task, task);
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const old = this.child;
    this.child = null;
    this.childPid = null;
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error('pwsh session was disposed'), { code: 'DISPOSED' }));
    }
    if (old) this.#killTree(old);
  }

  async #start() {
    const candidates = this.exeOverride
      ? [this.exeOverride]
      : process.platform === 'win32'
        ? ['pwsh.exe', 'powershell.exe']
        : ['pwsh'];
    let lastError = null;
    for (const exe of candidates) {
      try {
        return await this.#spawnOnce(exe);
      } catch (err) {
        lastError = err;
        if (!err.notFound) throw err;
      }
    }
    throw lastError ?? new Error('unable to start PowerShell');
  }

  #spawnOnce(exe) {
    return new Promise((resolve, reject) => {
      const args = ['-NoLogo'];
      if (!this.loadProfile) args.push('-NoProfile');
      args.push('-NonInteractive');
      if (process.platform === 'win32') args.push('-ExecutionPolicy', 'Bypass');
      args.push('-File', BOOTSTRAP);

      let child;
      try {
        child = spawn(exe, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: {
            ...process.env,
            PWSH_MCP_PARENT_PID: String(process.pid),
            PWSH_MCP_PARENT_START_MS: String(PROCESS_START_MS),
          },
        });
      } catch (err) {
        err.notFound = true;
        reject(err);
        return;
      }

      const stderrTail = [];
      child.stderr.on('data', (chunk) => {
        stderrTail.push(chunk);
        if (stderrTail.length > 30) stderrTail.shift();
        const text = chunk.toString('utf8').trimEnd();
        if (text) process.stderr.write(`[pwsh-mcp] ${text}\n`);
      });
      child.stdin.on('error', () => {});

      let settled = false;
      let started = false;

      const startupTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.#killTree(child);
        reject(new Error(`${exe} did not report ready within ${this.startupTimeoutMs} ms`));
      }, this.startupTimeoutMs);

      child.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(startupTimer);
          err.notFound = err.code === 'ENOENT';
          if (err.notFound) err.message = `${exe} was not found`;
          reject(err);
        } else {
          process.stderr.write(`[pwsh-mcp] child error: ${err.message}\n`);
        }
      });

      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on('line', (line) => {
        if (started && this.child !== child) return;
        if (line.startsWith(PREFIX)) {
          let msg = null;
          try {
            msg = JSON.parse(line.slice(PREFIX.length));
          } catch {
            msg = null;
          }
          if (msg && msg.type === 'ready') {
            if (!settled) {
              settled = true;
              started = true;
              clearTimeout(startupTimer);
              this.child = child;
              this.childPid = child.pid;
              resolve(child.pid);
            }
            return;
          }
          if (msg && msg.type === 'end' && this.#tryHandleEnd(child, msg)) return;
        }
        if (!started) return;
        if (this.pending && this.pending.child === child) {
          this.pending.push(line);
        } else {
          process.stderr.write(`[pwsh-mcp] unexpected output: ${line}\n`);
        }
      });
      rl.on('error', () => {});

      child.once('exit', (code, signal) => {
        clearTimeout(startupTimer);
        if (!settled) {
          settled = true;
          const tail = Buffer.concat(stderrTail).toString('utf8').trim();
          reject(new Error(`${exe} exited before ready (code ${code})${tail ? `: ${tail.slice(-2000)}` : ''}`));
          return;
        }
        if (this.child === child) {
          this.child = null;
          this.childPid = null;
          this.restarted = true;
        }
        if (this.pending && this.pending.child === child) {
          const p = this.pending;
          this.pending = null;
          clearTimeout(p.timer);
          p.reject(Object.assign(
            new Error(`pwsh session exited (code ${code}${signal ? `, signal ${signal}` : ''}) while the command was running`),
            { code: 'SESSION_EXITED', partial: renderSnap(p.snapshot()) },
          ));
        }
      });
    });
  }

  #tryHandleEnd(child, msg) {
    const p = this.pending;
    if (!p || p.child !== child || msg.id !== p.id) return false;
    this.pending = null;
    clearTimeout(p.timer);
    p.resolve({
      ok: msg.ok === true,
      exitCode: typeof msg.exit === 'number' ? msg.exit : null,
      cwd: typeof msg.cwd === 'string' ? msg.cwd : null,
      ms: typeof msg.ms === 'number' ? msg.ms : null,
      pid: this.childPid ?? child.pid,
      snap: p.snapshot(),
    });
    return true;
  }

  async #runOnce(command, { cwd, timeoutMs, maxOutputChars } = {}) {
    if (this.disposed) throw Object.assign(new Error('pwsh session has been disposed'), { code: 'DISPOSED' });
    await this.ensureStarted();
    const restarted = this.restarted;
    this.restarted = false;
    const child = this.child;
    const id = randomUUID().replaceAll('-', '').slice(0, 16);
    const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.defaultTimeoutMs;
    const maxChars = Number.isInteger(maxOutputChars) && maxOutputChars > 0 ? maxOutputChars : this.defaultMaxOutputChars;

    const finished = new Promise((resolve, reject) => {
      const pending = createPending(id, child, maxChars, resolve, reject);
      this.pending = pending;
      pending.timer = setTimeout(() => {
        if (this.pending !== pending) return;
        this.pending = null;
        if (this.child === child) {
          this.child = null;
          this.childPid = null;
        }
        this.#killTree(child);
        this.restarted = true;
        pending.reject(Object.assign(
          new Error(`command timed out after ${effectiveTimeout} ms; the pwsh session was killed and will restart automatically on the next call`),
          { code: 'TIMEOUT', partial: renderSnap(pending.snapshot()) },
        ));
      }, effectiveTimeout);
    });

    const frame = { id, cmd: command };
    if (cwd) frame.cwd = String(cwd);
    try {
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    } catch {
      // The exit/timeout paths settle the pending promise.
    }

    if ((this.child !== child || child.exitCode !== null) && this.pending && this.pending.id === id) {
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error('pwsh session exited before the command could be sent'), {
        code: 'SESSION_EXITED',
        partial: '',
      }));
    }

    const settled = await finished;
    return {
      ok: settled.ok,
      exitCode: settled.exitCode,
      cwd: settled.cwd,
      ms: settled.ms,
      output: renderSnap(settled.snap),
      truncated: settled.snap.omitted > 0,
      sessionPid: settled.pid,
      restarted,
    };
  }

  #waitExit(child, ms) {
    if (child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        child.removeListener('exit', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      child.once('exit', done);
    });
  }

  #killTree(child) {
    if (!child) return;
    try {
      child.stdin.end();
    } catch {}
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    }
    try {
      child.kill();
    } catch {}
  }
}
