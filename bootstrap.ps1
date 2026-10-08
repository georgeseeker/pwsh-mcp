# pwsh-mcp bootstrap: persistent command loop speaking a line protocol over stdio.
#
# stdin : one JSON line per command: {"id":"...","cwd":"<optional>","cmd":"<code>"}
# stdout: command output lines, followed by control lines prefixed with @@PWSH_MCP@@
#         ready -> {"type":"ready","pid":..,"ps":..}
#         end   -> {"type":"end","id":..,"ok":..,"exit":..,"cwd":..,"ms":..}
#
# The loop must stay ASCII-only so Windows PowerShell 5.1 can parse it
# without a BOM. Internal variables use the __mcp_ prefix so they are
# unlikely to collide with dot-sourced user code (which shares this scope).

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$ConfirmPreference = 'None'
if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' }

$utf8 = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = $utf8

$__mcp_in = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $utf8)
$__mcp_out = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), $utf8)
$__mcp_out.NewLine = "`n"
$__mcp_out.AutoFlush = $true

function Write-Raw([string]$text) {
  try { $__mcp_out.Write($text) } catch { [Environment]::Exit(0) }
}

function Send-Ctrl($payload) {
  try { $__mcp_out.WriteLine('@@PWSH_MCP@@' + ($payload | ConvertTo-Json -Compress -Depth 4)) }
  catch { [Environment]::Exit(0) }
}

# Watchdog: the stdin-EOF path reaps this process when Node exits normally,
# but if a command blocks the loop while Node dies, only a separate thread
# can notice. The parent identity is passed in via environment variables by
# Node (PID + start time) so no CIM/WMI query is needed. Start-ThreadJob is
# bundled with PowerShell 7; skip if absent.
try {
  $__mcp_parentPid = 0
  $__mcp_parentStartMs = 0
  if ($env:PWSH_MCP_PARENT_PID) { $__mcp_parentPid = [int]$env:PWSH_MCP_PARENT_PID }
  if ($env:PWSH_MCP_PARENT_START_MS) { $__mcp_parentStartMs = [int64]$env:PWSH_MCP_PARENT_START_MS }
  if ($__mcp_parentPid -gt 0 -and (Get-Command Start-ThreadJob -ErrorAction SilentlyContinue)) {
    Start-ThreadJob -ScriptBlock {
      param($ppid, $pstartMs)
      while ($true) {
        Start-Sleep -Seconds 3
        $alive = $false
        try {
          $p = [System.Diagnostics.Process]::GetProcessById($ppid)
          try {
            $actualMs = [int64]$p.StartTime.ToUniversalTime().Subtract([datetime]::UnixEpoch).TotalMilliseconds
            $alive = [math]::Abs($actualMs - $pstartMs) -le 2000
          } catch { $alive = $true }
        } catch { $alive = $false }
        if (-not $alive) { [System.Diagnostics.Process]::GetCurrentProcess().Kill(); break }
      }
    } -ArgumentList $__mcp_parentPid, $__mcp_parentStartMs | Out-Null
  }
} catch { }

Send-Ctrl @{ type = 'ready'; pid = $PID; ps = $PSVersionTable.PSVersion.ToString() }

while ($true) {
  $__mcp_line = $__mcp_in.ReadLine()
  if ($null -eq $__mcp_line) { break }

  $__mcp_frame = $null
  try { $__mcp_frame = $__mcp_line | ConvertFrom-Json } catch { continue }
  if ($null -eq $__mcp_frame -or $null -eq $__mcp_frame.id -or $null -eq $__mcp_frame.cmd) { continue }

  $__mcp_id = [string]$__mcp_frame.id
  $__mcp_cmd = [string]$__mcp_frame.cmd
  $__mcp_watch = [System.Diagnostics.Stopwatch]::StartNew()
  $__mcp_ok = $false
  $__mcp_entry = $null
  $__mcp_text = ''
  $__mcp_saved = $null

  try {
    if ($__mcp_frame.cwd) {
      $__mcp_saved = $PWD
      Set-Location -LiteralPath ([string]$__mcp_frame.cwd) -ErrorAction Stop
    }

    $global:LASTEXITCODE = $null
    # $? and $LASTEXITCODE at the dot-source call site reflect only the
    # invocation itself, so the block samples both right after user code.
    $__mcp_probe = "`n`$__mcp_p_ok = `$?`n`$__mcp_p_lec = `$LASTEXITCODE`n"
    $__mcp_p_ok = $null
    $__mcp_p_lec = $null

    try {
      $__mcp_block = [scriptblock]::Create($__mcp_cmd + $__mcp_probe)
      $__mcp_res = . $__mcp_block *>&1
      if ($null -eq $__mcp_p_ok) { $__mcp_ok = $true } else { $__mcp_ok = [bool]$__mcp_p_ok }
      $__mcp_entry = $__mcp_p_lec
      if ($null -eq $__mcp_entry) { $__mcp_entry = $LASTEXITCODE }
      if (($null -ne $__mcp_entry) -and ($__mcp_entry -ne 0)) { $__mcp_ok = $false }
      if ($null -ne $__mcp_res) { $__mcp_text = ($__mcp_res | Out-String -Width 300) }
    } catch {
      $__mcp_ok = $false
      $__mcp_entry = $LASTEXITCODE
      $__mcp_text = ($_ | Out-String -Width 300)
    }
  } catch {
    $__mcp_ok = $false
    $__mcp_text = 'pwsh-mcp: ' + $_.Exception.Message
  } finally {
    if ($null -ne $__mcp_saved) {
      try { Set-Location -LiteralPath $__mcp_saved.Path -ErrorAction Stop } catch { }
    }
  }
  $__mcp_watch.Stop()

  if ($__mcp_text.Length -gt 0) {
    $__mcp_text = $__mcp_text.TrimEnd([char]13, [char]10)
    if ($__mcp_text.Length -gt 0) { Write-Raw ($__mcp_text + "`n") }
  }
  Send-Ctrl @{ type = 'end'; id = $__mcp_id; ok = $__mcp_ok; exit = $__mcp_entry; cwd = $PWD.Path; ms = [int]$__mcp_watch.ElapsedMilliseconds }
}
