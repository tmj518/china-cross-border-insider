# Daily unattended run of the Landed Math workflow.
#
# Registered as a Windows scheduled task by tools/register-daily-task.ps1.
#
# Why a wrapper rather than calling dsh directly from the task:
#
#   1. PATH. `dsh headless` does not inherit a PATH containing node, and every tool
#      in this repository is a node script. Without this the run starts and fails
#      on its first command. Proven rather than assumed: a headless probe reported
#      "node is not installed or on PATH" while listing the workspace correctly.
#   2. Transcript. An unattended run that fails silently is worse than one that does
#      not run, so stdout and stderr are both written to logs/ with a dated name.
#   3. The task text is piped from a file, so no shell quoting can corrupt it. An
#      earlier inline attempt failed on PowerShell quoting rather than on the agent.

$ErrorActionPreference = "Continue"

# Encoding, set before anything is read or piped. Windows PowerShell 5.1 encodes
# text sent to a native program with the ANSI code page, which on this machine is
# GBK; the Chinese instructions therefore reached the agent as question marks even
# though the file on disk was correct UTF-8 with a BOM.
$utf8 = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = $utf8
[Console]::OutputEncoding = $utf8
[Console]::InputEncoding = $utf8

$Repo = "C:\Users\tmj19\Desktop\出海官网更新工作流"
$NodeBin = "C:\Users\tmj19\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin"
$Dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
$TaskFile = Join-Path $Repo "自动化_每日任务.txt"
$LogDir = Join-Path $Repo "logs"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$stamp = Get-Date -Format "yyyy-MM-dd_HHmm"
$log = Join-Path $LogDir "daily-$stamp.log"

function Say($m) {
  $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $m
  Write-Output $line
  Add-Content -Path $log -Value $line -Encoding UTF8
}

Say "=== daily run started ==="

# 1. Environment. Git and node must be findable by the agent's shell.
$env:PATH = "$NodeBin;$env:PATH"
$gitCmd = "$env:LOCALAPPDATA\Programs\PortableGit\cmd"
if (Test-Path $gitCmd) { $env:PATH = "$gitCmd;$env:PATH" }

Say "node on PATH: $((Get-Command node -ErrorAction SilentlyContinue) -ne $null)"
Say "git on PATH : $((Get-Command git -ErrorAction SilentlyContinue) -ne $null)"
Say "dsh present : $(Test-Path $Dsh)"
Say "task file   : $(Test-Path $TaskFile)"

if (-not (Test-Path $Dsh)) { Say "FATAL: dsh not found at $Dsh"; exit 2 }
if (-not (Test-Path $TaskFile)) { Say "FATAL: task file not found at $TaskFile"; exit 2 }

Set-Location $Repo
Say "working directory: $(Get-Location)"

# 2. Record the state the run starts from, so the log shows what changed.
try {
  $head = (& git rev-parse --short HEAD 2>&1) -join ""
  Say "HEAD before: $head"
  $dirty = (& git status --porcelain 2>&1 | Measure-Object -Line).Lines
  Say "uncommitted files before: $dirty"
} catch { Say "git state unavailable: $_" }

# 3. Run the workflow. The task text goes in on stdin, which removes all quoting risk.
Say "invoking dsh headless (this can take a long time)"
$task = [System.IO.File]::ReadAllText($TaskFile, [System.Text.Encoding]::UTF8)

$sw = [System.Diagnostics.Stopwatch]::StartNew()
try {
  $task | & $Dsh headless - *>&1 | Tee-Object -FilePath $log -Append
  $code = $LASTEXITCODE
} catch {
  Say "dsh threw: $_"
  $code = 1
}
$sw.Stop()
Say "dsh finished in $([int]$sw.Elapsed.TotalMinutes) min, exit code $code"

# 4. Record what changed, so the log is self-contained.
try {
  $head2 = (& git rev-parse --short HEAD 2>&1) -join ""
  Say "HEAD after: $head2"
  if ($head -ne $head2) { Say "commits were made during this run" } else { Say "no new commit during this run" }
} catch {}

Say "=== daily run finished ==="
exit $code
