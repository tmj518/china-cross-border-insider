# CBAM research: reliable fetch + text extraction helpers
# Usage: . .\cbam\fetch.ps1

$script:Dir = "C:\Users\tmj19\Desktop\出海官网更新工作流\cbam"
New-Item -ItemType Directory -Force -Path $script:Dir | Out-Null

function Get-Cellar {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$Out,
        [string]$Accept = "application/xhtml+xml",
        [int]$Tries = 6
    )
    $path = Join-Path $script:Dir $Out
    for ($i = 1; $i -le $Tries; $i++) {
        $res = & curl.exe -sS -L --max-time 90 -H "Accept: $Accept" -o $path -w "%{http_code}|%{size_download}|%{content_type}|%{url_effective}" $Uri 2>&1
        $s = ($res | Out-String).Trim()
        $parts = $s -split '\|'
        $code = $parts[0]
        if ($code -eq '200' -and [int]$parts[1] -gt 2000) {
            Write-Host "[OK $i] $Out  code=$code size=$($parts[1]) type=$($parts[2])"
            Write-Host "       final=$($parts[3])"
            return $path
        }
        Write-Host "[retry $i] $Out code=$code size=$($parts[1]) :: $s"
        Start-Sleep -Seconds 3
    }
    Write-Host "[FAIL] $Out after $Tries tries"
    return $null
}

function Convert-HtmlToText {
    param([Parameter(Mandatory)][string]$In, [Parameter(Mandatory)][string]$OutTxt)
    $py = "C:\Users\tmj19\AppData\Local\Programs\Python\Python313\python.exe"
    $script = Join-Path $script:Dir "h2t.py"
    & $py $script $In $OutTxt
    $len = (Get-Item $OutTxt).Length
    Write-Host "[txt] $OutTxt bytes=$len"
}
