# Fetch Google Search Central docs and extract readable main-content text.
# Usage: pwsh -File tools/gdoc_fetch.ps1
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$outDir = Join-Path $PSScriptRoot '..\_research\gdocs'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$urls = @(
  'https://developers.google.com/search/docs/essentials',
  'https://developers.google.com/search/docs/essentials/technical',
  'https://developers.google.com/search/docs/essentials/spam-policies',
  'https://developers.google.com/search/docs/fundamentals/creating-helpful-content',
  'https://developers.google.com/search/docs/fundamentals/how-search-works',
  'https://developers.google.com/search/docs/fundamentals/seo-starter-guide',
  'https://developers.google.com/search/docs/fundamentals/using-gen-ai-content',
  'https://developers.google.com/search/docs/fundamentals/ai-optimization-guide',
  'https://developers.google.com/search/docs/fundamentals/third-party-seo',
  'https://developers.google.com/search/docs/fundamentals/do-i-need-seo',
  'https://developers.google.com/search/docs/crawling-indexing',
  'https://developers.google.com/search/docs/crawling-indexing/url-structure',
  'https://developers.google.com/search/docs/crawling-indexing/links-crawlable',
  'https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview',
  'https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap',
  'https://developers.google.com/search/docs/crawling-indexing/robots/intro',
  'https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls',
  'https://developers.google.com/search/docs/crawling-indexing/canonicalization',
  'https://developers.google.com/search/docs/crawling-indexing/mobile/mobile-sites-mobile-first-indexing',
  'https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics',
  'https://developers.google.com/search/docs/crawling-indexing/valid-page-metadata',
  'https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag',
  'https://developers.google.com/search/docs/appearance/page-experience',
  'https://developers.google.com/search/docs/appearance/core-web-vitals',
  'https://developers.google.com/search/docs/appearance/ai-features',
  'https://developers.google.com/search/docs/appearance/ranking-systems-guide',
  'https://developers.google.com/search/docs/appearance/publication-dates',
  'https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data',
  'https://developers.google.com/search/docs/appearance/structured-data/sd-policies',
  'https://developers.google.com/search/docs/appearance/structured-data/article',
  'https://developers.google.com/search/docs/appearance/structured-data/organization',
  'https://developers.google.com/search/docs/appearance/structured-data/sitelinks-searchbox',
  'https://developers.google.com/search/docs/appearance/structured-data/breadcrumb',
  'https://developers.google.com/search/docs/appearance/site-names',
  'https://developers.google.com/search/docs/specialty/international',
  'https://developers.google.com/search/docs/specialty/international/localized-versions',
  'https://developers.google.com/search/blog/2023/02/google-search-and-ai-content',
  'https://web.dev/articles/vitals',
  'https://web.dev/articles/lcp',
  'https://web.dev/articles/inp',
  'https://web.dev/articles/cls',
  'https://developers.google.com/search/docs/appearance/avoid-intrusive-interstitials'
)

function Get-MainText {
  param([string]$html)
  # Prefer the devsite article body container
  $m = [regex]::Match($html, '(?is)<div[^>]*class="[^"]*devsite-article-body[^"]*"[^>]*>(.*?)</div>\s*</article>')
  if (-not $m.Success) {
    $m = [regex]::Match($html, '(?is)<article[^>]*>(.*?)</article>')
  }
  $body = if ($m.Success) { $m.Groups[1].Value } else { $html }

  $body = [regex]::Replace($body, '(?is)<script.*?</script>', ' ')
  $body = [regex]::Replace($body, '(?is)<style.*?</style>', ' ')
  $body = [regex]::Replace($body, '(?is)<nav.*?</nav>', ' ')
  $body = [regex]::Replace($body, '(?is)<svg.*?</svg>', ' ')
  $body = [regex]::Replace($body, '(?is)<(h[1-6])[^>]*>', "`n`n## ")
  $body = [regex]::Replace($body, '(?is)</(h[1-6])>', "`n")
  $body = [regex]::Replace($body, '(?is)<li[^>]*>', "`n- ")
  $body = [regex]::Replace($body, '(?is)</(p|div|tr|ul|ol|table|section)>', "`n")
  $body = [regex]::Replace($body, '(?is)<t[dh][^>]*>', ' | ')
  $body = [regex]::Replace($body, '(?is)<br\s*/?>', "`n")
  $body = [regex]::Replace($body, '(?is)<[^>]+>', ' ')
  $body = [System.Net.WebUtility]::HtmlDecode($body)
  $body = [regex]::Replace($body, '[ \t\u00a0]+', ' ')
  $body = [regex]::Replace($body, '(\r?\n\s*){3,}', "`n`n")
  return $body.Trim()
}

$i = 0
foreach ($u in $urls) {
  $i++
  $slug = ($u -replace '^https?://', '') -replace '[^A-Za-z0-9]+', '_'
  $dest = Join-Path $outDir ("{0:d2}_{1}.txt" -f $i, $slug)
  try {
    $r = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 45 -Headers @{ 'Accept-Language' = 'en-US,en;q=0.9' }
    $txt = Get-MainText -html $r.Content
    $header = "SOURCE: $u`r`nFETCHED_HTTP: $($r.StatusCode)`r`nCHARS: $($txt.Length)`r`n" + ('=' * 70) + "`r`n"
    Set-Content -Path $dest -Value ($header + $txt) -Encoding UTF8
    Write-Output ("OK  {0,-6} {1,7} chars  {2}" -f $r.StatusCode, $txt.Length, $u)
  } catch {
    Set-Content -Path $dest -Value "SOURCE: $u`r`nFETCH_ERROR: $($_.Exception.Message)`r`n" -Encoding UTF8
    Write-Output ("ERR          {0}" -f $u)
  }
  Start-Sleep -Milliseconds 250
}
Write-Output "DONE -> $outDir"
