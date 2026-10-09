$root = "E:/Code/Project/Vpn_app"
$ev   = Join-Path $root "evidence"
$bat  = Join-Path $root ".silence/start-sidecar.bat"
$stdout = Join-Path $ev "sidecar-out.log"
$stderr = Join-Path $ev "sidecar-err.log"

Remove-Item $stdout, $stderr -ErrorAction SilentlyContinue

$tokenFile = Join-Path $root ".silence/g4-boot-token.txt"
if (-not (Test-Path $tokenFile)) { throw "missing token file: $tokenFile" }
$token = Get-Content $tokenFile -Raw | ForEach-Object { $_.Trim() } | Select-Object -First 1
if ($token.Length -lt 32) { throw "token too short in $tokenFile" }

if (-not (Test-Path $bat)) { throw "missing bat: $bat" }
Write-Host "launching sidecar via bat: $bat (tokenLen=$($token.Length))"

$psi = [System.Diagnostics.ProcessStartInfo]@{
    FileName        = "cmd.exe"
    Arguments       = "/c `"$bat`""
    RedirectStandardOutput  = $true
    RedirectStandardError   = $true
    UseShellExecute         = $false
    CreateNoWindow          = $true
}
$p = [System.Diagnostics.Process]::Start($psi)
Write-Host "launched cmd host pid=$($p.Id)"

$boundPid = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    if ($p.HasExited) {
        Write-Host "cmd host exited rc=$($p.ExitCode)"
        break
    }
    $line = netstat -ano -p tcp | Select-String "LISTENING" | Where-Object { $_ -match "47615" }
    if ($line) {
        $boundPid = ($line.Line -replace ".*\s+(\d+)\s*$", '$1')
        Write-Host "port 47615 bound by pid=$boundPid"
        break
    }
}

$allNode = Get-Process -Name node -EA SilentlyContinue | Sort-Object Id
$ids = foreach ($n in $allNode) { $n.Id }
Write-Host "node.exe procs now count=$($ids.Count):" ($ids -join ", ")

$so = Get-Content $stdout -EA SilentlyContinue
$se = Get-Content $stderr -EA SilentlyContinue
if ($so) { Write-Host "sidecar-out.log tail:" ($so | Select-Object -Last 12) -join "`n" }
if ($se) { Write-Host "sidecar-err.log:" $se -join "`n" }
Write-Host "BOUND_PID=$boundPid"
