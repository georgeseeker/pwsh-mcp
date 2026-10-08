#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PwshSession } from './session.mjs';

const session = new PwshSession();

const TOOLS = [
  {
    name: 'run',
    description: [
      'Run PowerShell (pwsh) code in a persistent session on this machine. Session state - variables, functions, environment variables and the current directory - persists across calls, so this is the preferred way to run PowerShell and native Windows commands.',
      'Both PowerShell cmdlets and native executables work, e.g. run({command: "git status --short"}) or run({command: "Get-ChildItem *.json | Select-Object -First 5"}).',
      'The session keeps its working directory between calls; pass cwd to run a single call in another directory (the session directory is restored afterwards).',
      'The session inherits the environment of the terminal that launched this CLI. When that terminal is a PowerShell one, the user profile is loaded as well, so aliases, functions and profile-set variables behave like in the terminal (PWSH_MCP_LOAD_PROFILE=1/0 forces the choice).',
      'The result text starts with a status header (ok= exit= time= cwd= pid=), followed by the formatted output. Complex objects are rendered as console tables; use ConvertTo-Json in the command for raw structured data. Very long output is truncated with an omission marker.',
      'Failure semantics: ok=false when the command writes errors or any native command exited non-zero. If a call exceeds timeoutMs (default 300000), the pwsh process is killed and the session restarts on the next call - all session state is lost.',
      'Do not run interactive commands (Read-Host, prompts, text editors): they block until the timeout and restart the session.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'PowerShell code to execute (multi-line allowed).' },
        cwd: { type: 'string', description: 'Directory to execute this call in; the session working directory is restored afterwards.' },
        timeoutMs: { type: 'number', description: 'Per-call timeout in ms (default 300000). On expiry the session is killed and restarted.' },
        maxOutputChars: { type: 'integer', description: 'Approximate cap on returned output characters (default 500000); the middle of larger output is elided with a marker.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'reset',
    description: 'Kill the current persistent pwsh session and start a fresh one (all session state is lost). Use when the session looks stuck or a clean environment is needed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function textResult(text, extra = {}) {
  return { content: [{ type: 'text', text }], ...extra };
}

function formatRunResult(r) {
  const flags = [
    r.restarted ? 'session-restarted' : null,
    r.truncated ? 'output-truncated' : null,
  ].filter(Boolean);
  const header = `ok=${r.ok} exit=${r.exitCode ?? 'none'} time=${r.ms ?? '?'}ms cwd=${r.cwd ?? '?'} pid=${r.sessionPid ?? '?'}${flags.length ? ` ${flags.join(' ')}` : ''}`;
  return `${header}\n${r.output.length ? r.output : '(no output)'}`;
}

function errorText(err) {
  const code = err?.code ? ` [${err.code}]` : '';
  let text = `pwsh-mcp error${code}: ${err?.message ?? String(err)}`;
  if (typeof err?.partial === 'string' && err.partial.length > 0) {
    text += `\n--- partial output ---\n${err.partial}`;
  }
  return text;
}

const server = new Server({ name: 'pwsh', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params?.name;
  const args = request.params?.arguments ?? {};
  try {
    if (name === 'run') {
      if (typeof args.command !== 'string' || args.command.trim().length === 0) {
        return textResult('pwsh-mcp error: "command" must be a non-empty string.', { isError: true });
      }
      const result = await session.run(args.command, {
        cwd: typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : undefined,
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
        maxOutputChars: typeof args.maxOutputChars === 'number' ? args.maxOutputChars : undefined,
      });
      return textResult(formatRunResult(result), { isError: !result.ok });
    }
    if (name === 'reset') {
      const { pid } = await session.reset();
      return textResult(`pwsh session restarted (pid ${pid})`);
    }
    return textResult(`pwsh-mcp error: unknown tool "${name}"`, { isError: true });
  } catch (err) {
    return textResult(errorText(err), { isError: true });
  }
});

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    session.dispose();
  } catch {}
  process.exit(code);
}

server.onclose = () => shutdown(0);
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => {
  try {
    session.dispose();
  } catch {}
});

const transport = new StdioServerTransport();
await server.connect(transport);

session.ensureStarted().catch((err) => {
  process.stderr.write(`[pwsh-mcp] warm start failed: ${err.message}\n`);
});
