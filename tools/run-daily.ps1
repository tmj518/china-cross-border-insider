# run-daily.ps1 - the full daily job for Landed Math: review, write, gate, publish.
#
# Launched by Windows Task Scheduler as LandedMath-Daily, and safe to run by hand:
#     powershell -NoProfile -ExecutionPolicy Bypass -File tools\run-daily.ps1
#
# The task text comes from 自动化_每日任务.txt and is piped into `dsh headless -`.
#
# Patterns taken from the working PolicyBriefEN job in this same DSH install, each
# one because it fixes a real failure observed here:
#
#   * $root from $MyInvocation, not a hardcoded path. The scheduled task was
#     registered with an empty WorkingDirectory, so anything relative resolved
#     against System32.
#   * $ErrorActionPreference = "Continue", never "Stop": with Stop, a native tool
#     writing to stderr raises a terminating NativeCommandError and aborts the run.
#     dsh writes per-step diagnostics to stderr, so it aborted every time.
#   * Output appended with Add-Content -Encoding UTF8, not Tee-Object. Tee-Object
#     -Append writes UTF-16 and garbled the log.
#   * node and git placed on PATH explicitly: `dsh headless` does not inherit a PATH
#     containing node, and every tool in this repository is a node script.
#   * Fail closed. Preflight runs first; if it does not clear, the reason is written
#     to the log and the agent is still invoked, because a run that reports nothing
#     is worse than one that reports a block.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\run-daily.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\run-daily.ps1 -PreflightOnly
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\run-daily.ps1 -TaskFile .\probe.txt

[CmdletBinding()]
param(
    [string]$TaskFile = "",
    [switch]$PreflightOnly
)

$ErrorActionPreference = "Continue"

# Encoding, set before anything is read or piped. PowerShell 5.1 encodes text sent
# to a native program with the ANSI code page, which on this machine is GBK, so the
# Chinese instructions reached the agent as question marks.
$utf8 = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = $utf8
[Console]::OutputEncoding = $utf8
[Console]::InputEncoding = $utf8

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$nodeBin = "C:\Users\tmj19\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin"
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format "yyyy-MM-dd_HHmm"
$log = Join-Path $logDir "daily-$stamp.log"

if (-not $TaskFile) { $TaskFile = Join-Path $root "自动化_每日任务.txt" }

function Say($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Write-Host $line
    Add-Content -Path $log -Value $line -Encoding UTF8
}

Say "==================== daily run start ===================="
Say "root=$root"
Say "log=$log"

# ---------------------------------------------------------------- 0. environment
$gitCmd = "$env:LOCALAPPDATA\Programs\PortableGit\cmd"
if (Test-Path $gitCmd) { $env:PATH = "$gitCmd;$env:PATH" }
if (Test-Path $nodeBin) { $env:PATH = "$nodeBin;$env:PATH" }

$node = Get-Command node -ErrorAction SilentlyContinue
$git = Get-Command git -ErrorAction SilentlyContinue
Say "node : $(if ($node) { $node.Source } else { 'NOT FOUND' })"
Say "git  : $(if ($git) { $git.Source } else { 'NOT FOUND' })"
Say "dsh  : $(if (Test-Path $dsh) { $dsh } else { 'NOT FOUND' })"
Say "task : $(if (Test-Path $TaskFile) { $TaskFile } else { 'NOT FOUND' })"

if (-not $node) { Say "FATAL node not found. Nothing can run."; exit 2 }
if (-not (Test-Path $dsh)) { Say "FATAL dsh not found at $dsh"; exit 2 }
if (-not (Test-Path $TaskFile)) { Say "FATAL task file not found at $TaskFile"; exit 2 }

Set-Location $root
Say "cwd  : $(Get-Location)"

# ---------------------------------------------------------------- 1. preflight
Say "step 1/3  preflight"
$pre = & node (Join-Path $root "tools\preflight.mjs") 2>&1 | ForEach-Object { $_.ToString() }
$preExit = $LASTEXITCODE
if ($pre) { $pre | Add-Content -Path $log -Encoding UTF8 }
foreach ($l in $pre) { if ($l -match "ALL CLEAR|BLOCKING|\[FAIL\]") { Say "  $l" } }
Say "preflight exit=$preExit"

if ($PreflightOnly) { Say "PreflightOnly set - finished."; exit $preExit }

# ---------------------------------------------------------------- 2. the agent
Say "step 2/3  invoking dsh headless (this can take a long time)"
$task = [System.IO.File]::ReadAllText($TaskFile, [System.Text.Encoding]::UTF8)
Say "task text: $($task.Length) chars"

$sw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    # Captured as an array of strings and appended, rather than piped to Tee-Object,
    # which writes UTF-16 and corrupts the log.
    $out = $task | & $dsh headless - 2>&1 | ForEach-Object { $_.ToString() }
    $agentExit = $LASTEXITCODE
    if ($out) { $out | Add-Content -Path $log -Encoding UTF8 }
} catch {
    Say "dsh threw: $_"
    $agentExit = 1
}
$sw.Stop()
Say "dsh finished in $([int]$sw.Elapsed.TotalMinutes) min, exit=$agentExit"

# ---------------------------------------------------------------- 3. what changed
Say "step 3/3  recording what changed"
$head = (& git -C $root rev-parse --short HEAD 2>&1) -join ""
$dirty = (& git -C $root status --porcelain 2>&1 | Measure-Object -Line).Lines
Say "HEAD=$head  uncommitted=$dirty"
$ahead = (& git -C $root rev-list --count origin/main..HEAD 2>&1) -join ""
Say "commits not yet pushed: $ahead"
Say "==================== daily run finished ===================="
exit $agentExit
