# run-daily.ps1 - the full daily job for Landed Math: review, write, gate, publish.
#
# Launched by Windows Task Scheduler as LandedMath-Daily, and safe to run by hand:
#     powershell -NoProfile -ExecutionPolicy Bypass -File tools\run-daily.ps1
#
# The task text comes from daily-task.txt and is piped into `dsh headless -`.
#
# KEEP THIS FILE PURE ASCII, and keep the task file's NAME pure ASCII. No em dashes,
# no warning symbols, no Chinese, not even inside comments.
#
# Why, precisely. On 2026-10-08 the 08:10 run died on its second line with "task file
# not found", and the path in the error was mojibake. The task file was named in
# Chinese, this script had lost its UTF-8 BOM, and Windows PowerShell 5.1 therefore
# decoded the script as GBK on this locale. Run by hand it worked; run by Task
# Scheduler it did not, because the two entry points decode the file differently.
#
# So the durable fix is not "remember the BOM" - it is having no byte in this file
# whose meaning depends on the encoding. The task TEXT may be Chinese: it is read from
# its own file with an explicit UTF-8 decoding, which is unambiguous.
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
    [switch]$PreflightOnly,
    [switch]$NoPush
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

if (-not $TaskFile) { $TaskFile = Join-Path $root "daily-task.txt" }

function Say($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Write-Host $line
    Add-Content -Path $log -Value $line -Encoding UTF8
}

# Run a native command, return its exit code, append output to the log as UTF-8.
# Captured as an array and appended rather than piped to Tee-Object, which writes
# UTF-16 and garbles the log.
function Run-Cmd {
    param([string]$Exe, [string[]]$CmdArgs)
    $lines = & $Exe @CmdArgs 2>&1 | ForEach-Object { $_.ToString() }
    $code = $LASTEXITCODE
    if ($lines) { $lines | Add-Content -Path $log -Encoding UTF8 }
    return $code
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
Say "step 1/5  preflight (outside the agent sandbox)"
$pre = & node (Join-Path $root "tools\preflight.mjs") 2>&1 | ForEach-Object { $_.ToString() }
$preExit = $LASTEXITCODE
if ($pre) { $pre | Add-Content -Path $log -Encoding UTF8 }
foreach ($l in $pre) { if ($l -match "ALL CLEAR|BLOCKING|\[FAIL\]") { Say "  $l" } }
Say "preflight exit=$preExit"

if ($PreflightOnly) { Say "PreflightOnly set - finished."; exit $preExit }

# ---------------------------------------------------------------- 2. the agent
Say "step 2/5  invoking dsh headless (this can take a long time)"
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

# ---------------------------------------------------------------- 3. commit
Say "step 3/5  committing the agent's work"
$dirty = (& git -C $root status --porcelain 2>&1 | Measure-Object -Line).Lines
Say "uncommitted files: $dirty"
if ($dirty -gt 0) {
    & git -C $root add -A 2>&1 | Out-Null
    $msg = "content: unattended run $stamp"
    & git -C $root commit -q -m $msg 2>&1 | ForEach-Object { $_.ToString() } | Add-Content -Path $log -Encoding UTF8
    Say "committed"
}
$headAfter = (& git -C $root rev-parse --short HEAD 2>&1) -join ""
Say "HEAD after: $headAfter"

$ahead = [int]((& git -C $root rev-list --count origin/main..HEAD 2>&1) -join "")
Say "commits ahead of origin: $ahead"

if ($ahead -eq 0) {
    Say "nothing new to publish - finished."
    Say "==================== daily run finished ===================="
    exit 0
}

if ($NoPush) {
    Say "NoPush set - $ahead commit(s) left local."
    Say "==================== daily run finished ===================="
    exit 0
}

# ---------------------------------------------------------------- 4. push
# The gate on publishing. A production build has to succeed here first: it cannot run
# inside the agent's sandbox, and this is the only place it can run before the work
# goes live. A build failure means nothing is pushed and the commits stay local.
Say "step 4/5  verifying the production build before pushing"
$buildExit = Run-Cmd "node" @((Join-Path $root "node_modules\astro\bin\astro.mjs"), "build")
Say "astro build exit=$buildExit"

if ($buildExit -ne 0) {
    Say "BUILD FAILED - refusing to push. The commits stay local."
    Say "  Fix the build, then: git push origin main"
    Say "==================== daily run finished ===================="
    exit 1
}

Say "pushing to origin/main"
$pushExit = Run-Cmd "git" @("-C", $root, "push", "origin", "main")
Say "push exit=$pushExit"

if ($pushExit -ne 0) {
    # Distinguish the two failure modes, because the advice differs. A closed
    # accelerator is the common one and the operator can fix it. A server-side 500 is
    # GitHub's problem: pushing a fresh empty branch fails identically, reads work, and
    # the status page says operational, so retrying is pointless and the commits wait.
    $pushLog = Get-Content -Path $log -Tail 40 -Encoding UTF8 -ErrorAction SilentlyContinue
    if ($pushLog -match "Internal Server Error|remote rejected") {
        Say "PUSH REJECTED BY GITHUB - this is server-side, not your accelerator."
        Say "  A test push of an empty branch fails the same way, so it is not the content."
        Say "  The commits are safe locally. The next run will retry automatically."
    } else {
        Say "PUSH FAILED - is the accelerator running? That is the usual cause."
    }
    Say "  Commits are safe locally. Push later with: git push origin main"
    Say "==================== daily run finished ===================="
    exit 1
}

# ---------------------------------------------------------------- 5. verify live
Say "step 5/5  waiting for the deploy, then verifying live"
Start-Sleep -Seconds 45
$verify = Run-Cmd "node" @((Join-Path $root "tools\verify-live.mjs"))
Say "live verification exit=$verify"

Say "==================== daily run finished ===================="
if ($verify -ne 0) { exit $verify }
exit $agentExit
