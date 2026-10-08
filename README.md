# pwsh-mcp

给 **QoderCN CLI（qoderclicn）** 的常驻 PowerShell（pwsh）会话 MCP 服务器。

在 Windows 上用 qoderclicn 让 AI 跑 PowerShell，以前只能靠 Bash 工具包一层 `pwsh -Command "..."`——每条命令冷启动、引号转义地狱、命令之间没有任何状态。本项目把**一个常驻的 pwsh 进程**包装成标准 MCP 工具：AI 直接调用，毫秒级响应，变量 / 函数 / 环境变量 / 工作目录全部跨调用保留。

> A persistent PowerShell (pwsh) session as an MCP server — built for the QoderCN CLI, works with any stdio MCP client.

## 它解决什么问题

| 直接用 Bash 工具跑 pwsh | 使用 pwsh-mcp |
|---|---|
| 每条命令冷启动 pwsh（约 1s+） | 进程常驻，调用毫秒级 |
| Bash → pwsh 引号 / 转义 / 编码易错 | 直接传 PowerShell 源码，全程 UTF-8，中文 / emoji 可靠 |
| 无状态：变量、函数、`cd` 全部丢失 | 会话状态完整保留 |
| 环境需手工重建 | 继承启动 CLI 的终端环境；终端是 PowerShell 时自动加载 Profile |
| 出错后进程残留难以管理 | 超时自动杀进程树并重启；三层清理，绝不残留孤儿进程 |

## 功能

**`run`** — 在常驻会话里执行 PowerShell 或原生命令

- 跨调用保留：变量、函数、环境变量、当前目录
- 可选 `cwd` 参数：单次调用切换目录，执行后自动还原
- 超时控制（默认 300s）：超时杀进程树 + 自动重启
- 输出保护：超大输出自动头尾保留并加省略标记；`Write-Host` / `Write-Warning` / 错误流全部捕获
- 严格失败语义：命令报错或任意原生命令非零退出 → `ok=false`，退出码在结果首行可见

**`reset`** — 杀掉当前会话并换一个全新进程

## 安装

要求：Windows + Node.js ≥ 20；pwsh 7（缺失时自动回退 Windows PowerShell 5.1）。

```powershell
git clone https://github.com/georgeseeker/pwsh-mcp.git
cd pwsh-mcp
npm install
```

注册到 QoderCN CLI（用户级，所有项目可用）：

```powershell
qoderclicn mcp add pwsh node "C:\path\to\pwsh-mcp\src\server.mjs" --scope user --transport stdio
```

之后在 CLI 里执行 `/mcp reload` 即可使用。

其他 MCP 客户端（Claude Desktop 等）用标准 stdio 配置即可：

```json
{
  "mcpServers": {
    "pwsh": { "command": "node", "args": ["C:\\path\\to\\pwsh-mcp\\src\\server.mjs"] }
  }
}
```

## 工具用法

### run

| 参数 | 必填 | 说明 |
|---|---|---|
| `command` | ✔ | 要执行的 PowerShell 代码（支持多行；原生命令直接写，如 `git status`） |
| `cwd` | | 本次调用的工作目录（执行后会话目录自动还原） |
| `timeoutMs` | | 本次超时（默认 300000）；超时会杀会话并在下次调用自动重启（状态丢失） |
| `maxOutputChars` | | 返回字符数上限（默认 500000），超出时保留头尾并加省略标记 |

返回示例：

```text
ok=true exit=none time=12ms cwd=C:\Develop\MCPs pid=29660
Hello, 会话
```

首行为状态头：`ok`（成败）、`exit`（原生命令退出码，无则 `none`）、`time`、`cwd`（会话当前目录）、`pid`（会话进程），附加标记 `session-restarted` / `output-truncated`；其后为命令输出。

### reset

无参数。杀掉当前 pwsh 进程，换一个新会话，返回新 `pid`。

## 工作原理

```text
qoderclicn ⇄ (MCP/stdio) ⇄ node src/server.mjs ⇄ (行协议) ⇄ 常驻 pwsh (bootstrap.ps1)
```

- `bootstrap.ps1` 在 pwsh 内循环：从 stdin 读**单行 JSON 帧**（`{id, cmd, cwd?}`），用 `[scriptblock]::Create` + **点源**执行——保证作用域持久、`$?` / `$LASTEXITCODE` 真实、错误流可捕获——再把全部输出流格式化回写，附一条 `@@PWSH_MCP@@` 前缀的控制行（含 ok / exit / cwd / 耗时）。
- `session.mjs` 管理进程生命周期：串行队列、超时杀进程树、输出有界缓冲、重启竞态防护。
- **无孤儿进程保障（三层）**：① Node 退出 → stdin EOF → pwsh 自然退出；② Node 崩溃后 pwsh 写管道遇断管 → 自杀退出；③ 看门狗线程每 3s 校验父进程（PID + 启动时间），父死则自杀——覆盖"父进程崩溃时 pwsh 正卡在长命令里"的场景。

## 行为边界（设计选择）

- **严格 ok 语义**：命令中任意原生命令非零退出即 `ok=false`（即使后面还有成功语句）。这是有意为之，比交互式 REPL 更保守；退出码始终在 `exit=` 中可见。
- **脚本里的 `exit N`**：只结束脚本并设置退出码，不会杀掉会话；直接在会话里 `exit` 才会结束会话（下次调用自动重启）。
- **交互式命令不支持**（`Read-Host`、编辑器等）：会阻塞直到超时，然后会话被杀重启。本工具面向自动化命令。
- **输出格式化**：Console 风格表格（`Out-String -Width 300`），超宽单元格可能省略；需要原始结构请在命令里用 `ConvertTo-Json`。
- **会话作用域**：命令在脚本作用域执行（与真 REPL 的 global 作用域略有差异），`$global:x` 仍可显式使用。
- **编码**：协议层全程 UTF-8；原生命令输出按系统控制台代码页解码（中文 Windows 下 GBK 工具输出正常）。

## 环境变量（可选）

| 变量 | 说明 |
|---|---|
| `PWSH_MCP_LOAD_PROFILE` | `1` 强制加载用户 Profile / `0` 强制不加载；缺省自动：检测到启动 CLI 的终端是 PowerShell 家族时加载 |
| `PWSH_MCP_PWSH` | 指定 pwsh 可执行文件（缺省 `pwsh.exe`，找不到时回退 `powershell.exe`） |
| `PWSH_MCP_TIMEOUT_MS` | 默认超时（缺省 300000） |
| `PWSH_MCP_MAX_OUTPUT_CHARS` | 默认输出上限（缺省 500000） |

## 非侵入性

- 不做全局安装、不改 PATH、不改 Profile / 注册表 / 系统设置（`-ExecutionPolicy Bypass` 仅为进程参数）
- 服务器不写日志 / 临时文件，输出只走 stderr；无窗口闪现（`windowsHide`）
- 进程生命周期严格绑定 CLI 会话，退出即回收，三层清理无孤儿

## 开发与测试

```powershell
npm test               # 47 项端到端冒烟（状态保持 / 编码 / 错误语义 / 超时重启 / 进程回收 / 5.1 回退…）
npm run test:watchdog  # 看门狗专项：父进程被强杀后，卡在长命令中的 pwsh 自动回收
```

结构：

```text
bootstrap.ps1       pwsh 侧常驻循环（行协议 + 执行引擎 + 看门狗）
src/session.mjs     进程 / 协议 / 队列 / 超时 / 截断 / 清理
src/server.mjs      MCP server（run / reset 工具）
test/smoke.mjs      端到端冒烟
test/watchdog*.mjs  看门狗专项
```

## 兼容性

- 任何支持 stdio 传输的 MCP 客户端；重点适配 QoderCN CLI
- pwsh 7.x（最优）；Windows PowerShell 5.1（自动回退，功能一致，无看门狗）
- 仅 Windows（依赖 `taskkill` 做进程树回收）
- 已在 pwsh 7.6.6 / Node 25 / 中文 Windows 11 上通过全部 47 项测试
