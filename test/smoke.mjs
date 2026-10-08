import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectPwshTerminal } from '../src/session.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = path.join(root, 'src', 'server.mjs');

let passed = 0;
let failed = 0;
function check(name, cond, info = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${info ? `  [${info}]` : ''}`);
  }
}

const getText = (res) => (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const outText = (res) => {
  const t = getText(res);
  const i = t.indexOf('\n');
  return i === -1 ? '' : t.slice(i + 1);
};
const run = (client, command, args = {}) => client.callTool({ name: 'run', arguments: { command, ...args } });
const headerLine = (res) => getText(res).split('\n', 1)[0] ?? '';
const metaPid = (res) => {
  const m = / pid=(\d+)/.exec(headerLine(res));
  return m ? Number.parseInt(m[1], 10) : undefined;
};
const metaExit = (res) => {
  const m = / exit=([^ ]+)/.exec(headerLine(res));
  return !m || m[1] === 'none' ? null : m[1];
};
const hasFlag = (res, flag) => headerLine(res).includes(flag);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitDead(pid, ms) {
  if (typeof pid !== 'number') return false;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(250);
  }
  return !alive(pid);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, PWSH_MCP_LOAD_PROFILE: '0' },
  cwd: root,
  stderr: 'pipe',
});
const stderrChunks = [];
if (transport.stderr) transport.stderr.on('data', (d) => stderrChunks.push(d));
const client = new Client({ name: 'pwsh-mcp-smoke', version: '0.0.0' }, { capabilities: {} });

let lastPid = null;

try {
  await client.connect(transport);

  const tools = await client.listTools();
  const names = (tools.tools ?? []).map((t) => t.name).sort().join(',');
  check('tools listed (run,reset)', names === 'reset,run', names);

  check('detect: pwsh terminal env => true',
    detectPwshTerminal({ PSModulePath: 'C:\\Users\\x\\Documents\\PowerShell\\Modules;C:\\Windows\\system32' }) === true);
  check('detect: plain system env => false',
    detectPwshTerminal({ PSModulePath: 'C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules' }) === false);
  check('detect: empty env => false', detectPwshTerminal({}) === false);

  // basic execution
  let r = await run(client, '2 + 2');
  check('basic: 2+2 => 4', !r.isError && outText(r).includes('4'), getText(r));
  lastPid = metaPid(r);
  check('status header carries sessionPid', Number.isFinite(lastPid));

  const initialPwd = outText(await run(client, '$PWD.Path')).trim();
  check('initial pwd is project root', initialPwd.toLowerCase() === root.toLowerCase(), initialPwd);

  // state persistence
  await run(client, "$mcpProbe = 'persist-42'");
  r = await run(client, '$mcpProbe');
  check('variable persists', !r.isError && outText(r).includes('persist-42'));
  await run(client, "function Get-McpProbe { 'fn-42' }");
  r = await run(client, 'Get-McpProbe');
  check('function persists', !r.isError && outText(r).includes('fn-42'));
  await run(client, "$env:MCP_PROBE = 'env-42'");
  r = await run(client, '$env:MCP_PROBE');
  check('env var persists', !r.isError && outText(r).includes('env-42'));

  // multiline + here-string
  r = await run(client, ['$acc = 0', '1..5 | ForEach-Object { $acc += $_ }', '$acc'].join('\n'));
  check('multiline sum 1..5 => 15', !r.isError && outText(r).includes('15'));
  r = await run(client, ['$txt = @"', 'here-A', 'here-B', '"@', '$txt'].join('\n'));
  check('here-string multiline', !r.isError && outText(r).includes('here-A') && outText(r).includes('here-B'));

  // unicode roundtrip
  r = await run(client, "'你好，世界 - 🚀'");
  check('unicode roundtrip', !r.isError && outText(r).includes('你好，世界 - 🚀'), getText(r).slice(0, 120));

  // non-terminating error (regression: Invoke-Expression silently swallowed these)
  r = await run(client, "Get-Item 'C:\\definitely-missing-mcp-probe'");
  const t5 = getText(r);
  check('missing item => isError + ok=false', r.isError === true && t5.includes('ok=false'), t5.slice(0, 200));
  check('missing item => error text visible', t5.includes('definitely-missing-mcp-probe'));

  // terminating error
  r = await run(client, "throw 'probe-boom'");
  check('throw captured', r.isError === true && getText(r).includes('probe-boom'));

  // native commands
  r = await run(client, 'cmd /c "echo native-42"');
  check('native echo ok', !r.isError && outText(r).includes('native-42'));
  r = await run(client, 'cmd /c "exit 7"');
  check('native exit 7 => exit=7 + isError', r.isError === true && metaExit(r) === '7', headerLine(r));

  // stream capture
  r = await run(client, "Write-Host 'host-42'");
  check('Write-Host captured', !r.isError && outText(r).includes('host-42'));
  r = await run(client, "Write-Host -NoNewline 'glued-42'");
  check('Write-Host -NoNewline keeps protocol intact', !r.isError && outText(r).includes('glued-42'), getText(r).slice(0, 200));
  r = await run(client, "Write-Warning 'warn-42'");
  check('Write-Warning captured, ok=true', !r.isError && outText(r).includes('warn-42'));

  // forged control line must stay data
  r = await run(client, `'@@PWSH_MCP@@{"type":"end","id":"fake-id"}'`);
  check('forged control line stays data', !r.isError && outText(r).includes('fake-id'), getText(r).slice(0, 200));

  // cwd parameter: applied per call, then restored
  r = await run(client, '$PWD.Path', { cwd: root });
  check('cwd param applied', !r.isError && outText(r).trim().toLowerCase().endsWith('pwsh-mcp'), getText(r).slice(0, 200));
  r = await run(client, '$PWD.Path');
  check('session pwd restored after cwd param', outText(r).trim().toLowerCase() === initialPwd.toLowerCase(), outText(r).trim());

  // invalid cwd
  r = await run(client, "'x-marker'", { cwd: 'C:\\definitely-missing-mcp-dir' });
  check('invalid cwd => isError', r.isError === true, getText(r).slice(0, 200));
  r = await run(client, '$PWD.Path');
  check('pwd unchanged after invalid cwd', outText(r).trim().toLowerCase() === initialPwd.toLowerCase());

  // Set-Location persists
  await run(client, 'Set-Location C:\\');
  r = await run(client, '$PWD.Path');
  check('Set-Location persists', outText(r).trim() === 'C:\\', outText(r).trim());
  await run(client, `Set-Location '${root}'`);

  // truncation: big multi-line output keeps head+tail, server stays alive
  r = await run(client, '1..80000 | ForEach-Object { "trunc-$_" }');
  const t13 = getText(r);
  check('big output truncated flag', hasFlag(r, 'output-truncated'), headerLine(r));
  check('truncated keeps head+tail+marker', t13.includes('trunc-1') && t13.includes('trunc-80000') && t13.includes('characters omitted'));
  check('truncated output bounded', t13.length < 600000, `len=${t13.length}`);
  r = await run(client, "'responsive-after-truncation'");
  check('server responsive after truncation', !r.isError && outText(r).includes('responsive-after-truncation'));

  // stderr flood from .NET console must not deadlock the session
  r = await run(client, [
    'foreach ($i in 1..30000) { [Console]::Error.WriteLine("flood-$i") }',
    "'flood-done'",
  ].join('\n'), { timeoutMs: 60000 });
  check('stderr flood completes, stdout intact', !r.isError && outText(r).includes('flood-done'), getText(r).slice(-200));

  // concurrent calls are serialized and both succeed
  const [ca, cb] = await Promise.all([
    run(client, "Start-Sleep -Milliseconds 400; 'concurrent-A'"),
    run(client, "'concurrent-B'"),
  ]);
  check('concurrent calls both succeed', !ca.isError && !cb.isError && outText(ca).includes('concurrent-A') && outText(cb).includes('concurrent-B'));

  // timeout kills the session; next call restarts fresh
  const pidBeforeTimeout = metaPid(await run(client, "'pid-check'"));
  const t0 = Date.now();
  r = await run(client, 'Start-Sleep -Seconds 60', { timeoutMs: 1500 });
  const dt = Date.now() - t0;
  check('timeout returns quickly with error', r.isError === true && getText(r).includes('timed out') && dt < 20000, `dt=${dt}ms`);
  r = await run(client, "'after-timeout'");
  check('session restarts after timeout', !r.isError && outText(r).includes('after-timeout')
    && hasFlag(r, 'session-restarted') && metaPid(r) !== pidBeforeTimeout);
  r = await run(client, '[bool](Get-Variable mcpProbe -ErrorAction SilentlyContinue)');
  check('state cleared after timeout restart', outText(r).includes('False'), outText(r).trim());

  // user-initiated exit kills the session; next call lazily restarts
  const pidBeforeExit = metaPid(r);
  r = await run(client, 'exit 42');
  check('user exit => SESSION_EXITED error', r.isError === true && getText(r).includes('SESSION_EXITED'), getText(r).slice(0, 200));
  r = await run(client, "'after-exit'");
  check('lazy restart after user exit', !r.isError && outText(r).includes('after-exit') && metaPid(r) !== pidBeforeExit);
  lastPid = metaPid(r);

  // reset tool
  await run(client, "$resetProbe = 'reset-42'");
  const pidBeforeReset = metaPid(await run(client, "'pid-check-2'"));
  const reset = await client.callTool({ name: 'reset', arguments: {} });
  const resetPidMatch = /pid (\d+)/.exec(getText(reset));
  const pidAfterReset = resetPidMatch ? Number.parseInt(resetPidMatch[1], 10) : undefined;
  check('reset => new pid', reset.isError !== true && Number.isFinite(pidAfterReset) && pidAfterReset !== pidBeforeReset, getText(reset));
  check('reset => old pid dead', await waitDead(pidBeforeReset, 5000));
  r = await run(client, '"$resetProbe"');
  check('state cleared after reset', !getText(r).includes('reset-42'));
  lastPid = pidAfterReset;

  // unknown tool
  const unknown = await client.callTool({ name: 'nope', arguments: {} });
  check('unknown tool => isError', unknown.isError === true);

  // Windows PowerShell 5.1 fallback instance
  const transport51 = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, PWSH_MCP_PWSH: 'powershell.exe', PWSH_MCP_LOAD_PROFILE: '0' },
    cwd: root,
    stderr: 'pipe',
  });
  if (transport51.stderr) transport51.stderr.on('data', () => {});
  const client51 = new Client({ name: 'pwsh-mcp-smoke-51', version: '0.0.0' }, { capabilities: {} });
  try {
    await client51.connect(transport51);
    const r51a = await run(client51, '2 + 2');
    const r51b = await run(client51, "'中文5.1'");
    check('5.1 fallback basic+unicode', !r51a.isError && outText(r51a).includes('4') && !r51b.isError && outText(r51b).includes('中文5.1'));
    const pid51 = metaPid(await run(client51, "'x'"));
    await client51.close();
    check('5.1 instance reaps its pwsh', await waitDead(pid51, 8000));
  } finally {
    try { await client51.close(); } catch {}
  }

  // profile-loading spawn path (no profile file present -> behaves like default)
  const transportProf = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, PWSH_MCP_LOAD_PROFILE: '1' },
    cwd: root,
    stderr: 'pipe',
  });
  if (transportProf.stderr) transportProf.stderr.on('data', () => {});
  const clientProf = new Client({ name: 'pwsh-mcp-smoke-prof', version: '0.0.0' }, { capabilities: {} });
  try {
    await clientProf.connect(transportProf);
    const rp = await run(clientProf, '2 + 2');
    check('profile mode spawn works', !rp.isError && outText(rp).includes('4'));
    const pidProf = metaPid(await run(clientProf, "'x'"));
    await clientProf.close();
    check('profile mode reaps its pwsh', await waitDead(pidProf, 8000));
  } finally {
    try { await clientProf.close(); } catch {}
  }
} catch (err) {
  failed += 1;
  console.log(`FAIL  unexpected exception: ${err?.stack ?? err}`);
} finally {
  try {
    await client.close();
  } catch {}
}

if (lastPid) {
  check('server close reaps pwsh', await waitDead(lastPid, 8000));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  const tail = Buffer.concat(stderrChunks).toString('utf8').split('\n').slice(-40).join('\n');
  console.log(`--- server stderr tail ---\n${tail}`);
  process.exit(1);
}
