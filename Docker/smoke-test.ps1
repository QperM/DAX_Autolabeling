param(
  [string]$WebUrl = "http://localhost:38080",
  [string]$ApiUrl = "http://localhost:3001",
  [string]$Sam2Url = "http://localhost:37860"
)

$ErrorActionPreference = "Stop"

Write-Host "== DAX smoke test ==" -ForegroundColor Cyan

function Check-Http([string]$Url) {
  Write-Host "GET $Url"
  $resp = Invoke-WebRequest -Uri $Url -Method GET -TimeoutSec 15 -UseBasicParsing
  Write-Host "  -> $($resp.StatusCode)"
}

Check-Http "$Sam2Url/health"
Check-Http "$ApiUrl/api/health"
Check-Http "$WebUrl/"

Write-Host ""
Write-Host "OK: basic endpoints reachable." -ForegroundColor Green

