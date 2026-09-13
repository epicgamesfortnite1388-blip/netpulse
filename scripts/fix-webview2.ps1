#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Registers the WebView2 runtime for NetPulse Desktop on machines that have
    Microsoft Edge installed but no externally-registered WebView2 runtime.
#>
$ErrorActionPreference = 'Stop'
Write-Host 'NetPulse WebView2 Runtime Registration' -ForegroundColor Cyan
Write-Host '=======================================' -ForegroundColor Cyan
$edgePaths = @('C:\Program Files (x86)\Microsoft\Edge\Application', 'C:\Program Files\Microsoft\Edge\Application')
$edgeDir = $null
foreach ($base in $edgePaths) {
    if (Test-Path $base) {
        $v = Get-ChildItem $base -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } | Sort-Object Name -Descending
        if ($v) { $edgeDir = Join-Path $base $v[0].Name; break }
    }
}
if (-not $edgeDir) {
    Write-Host 'Microsoft Edge not found. Install Edge or WebView2 runtime.' -ForegroundColor Yellow
    exit 1
}
Write-Host "Found Edge: $edgeDir" -ForegroundColor Green
$wv2Files = @('msedge.dll', 'EdgeWebView.dat', 'webview2_integration.dll')
foreach ($f in $wv2Files) {
    if (Test-Path (Join-Path $edgeDir $f)) { Write-Host "  Found: $f" -ForegroundColor Green } else { Write-Host "  Missing: $f" -ForegroundColor Red; exit 1 }
}
$existing = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Edge WebView2\Runtime' -Name 'Path' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path
if ($existing -eq $edgeDir) { Write-Host 'Already registered.' -ForegroundColor Green; exit 0 }
Write-Host 'Registering...' -ForegroundColor Cyan
$rk = 'HKLM:\SOFTWARE\Microsoft\Edge WebView2\Runtime'
if (-not (Test-Path $rk)) { New-Item -Path $rk -Force | Out-Null }
Set-ItemProperty -Path $rk -Name 'Path' -Value $edgeDir -Type String -Force
$ck = 'HKLM:\SOFTWARE\Microsoft\EdgeWebView\CVulWatcher'
if (-not (Test-Path $ck)) { New-Item -Path $ck -Force | Out-Null }
Set-ItemProperty -Path $ck -Name 'EdgeAppInstanceId' -Value 'MicrosoftEdge' -Type String -Force
Write-Host 'WebView2 runtime registered. You can now launch NetPulse.' -ForegroundColor Green
