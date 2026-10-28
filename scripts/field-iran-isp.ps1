<#
.SYNOPSIS
  The Iranian-ISP field measurement as ONE repeatable command.

.DESCRIPTION
  Sets up the raw-ISP bypass, proves the vantage, runs the corpus through the
  app's own probe path, replays baseline vs adaptive with the shipped policy,
  restores routing, and files the evidence - in that order, with the restore
  running even when the measurement fails.

  Why a bypass at all: this machine's own Happ/sing-box tunnel owns 0.0.0.0/0, so
  every probe would leave through Germany and the "field" arm would be measuring
  Frankfurt. The bypass adds ActiveStore-only /32 routes for the CORPUS HOSTS
  (plus one IP echo), so exactly those dials leave through the physical adapter
  while the tunnel keeps everything else. Nothing about the tunnel, DNS or the
  firewall is touched, and the routes are deleted by the same tool that added
  them - in a `finally`, so a failed run does not leave the machine bypassed.

  The corpus stays where it is: it is read for host:port only (through
  scripts/rawpath-hosts.mjs) and no share link, secret or password is ever copied
  into the transcript or the evidence files.

  Evidence filed (in reports/adaptive/ unless -EvidenceDir says otherwise), one
  UTC tag per run:
    REPLAY_LIVE_IR_ISP_<tag>.json       recorded outcomes, both arms, verdict
    REPLAY_LIVE_IR_ISP_<tag>.log        the harness's own stdout
    RAW_PATH_IR_ISP_<tag>.txt           vantage, route state, port probes, restore check
  The control arm files REPLAY_LIVE_TUNNEL_CONTROL_<tag>.* / RAW_PATH_TUNNEL_CONTROL_<tag>.txt.

.PARAMETER Arm
  isp      (default) measure through the ISP. Needs elevation and will raise a
           UAC prompt (unless -NoElevate).
  control  the same corpus through the tunnel, no routing change, no elevation -
           the same-hour control the evidence report is compared against.

.PARAMETER Corpus
  File of share links, one per line (default: %TEMP%\vps-corpus.txt). It holds
  credentials, so it must live outside the repository.

.PARAMETER Tag
  UTC timestamp used in the evidence file names; pass one to name a run.

.PARAMETER Plan
  Print every action this run would take and change nothing (no routes, and no
  network reads beyond the route table).

.PARAMETER Recover
  Delete a bypass left behind by an interrupted run (the marker records the
  targets), then exit. Elevates if needed.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/field-iran-isp.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/field-iran-isp.ps1 -Arm control -Tag control-2
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/field-iran-isp.ps1 -Plan
#>
[CmdletBinding()]
param(
    [ValidateSet('isp', 'control')][string]$Arm = 'isp',
    [string]$Corpus = (Join-Path $env:TEMP 'vps-corpus.txt'),
    [int]$LiveNodes = 15,
    [int]$TimeoutMs = 8000,
    [string]$Tag = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHHmmZ'),
    [string]$EvidenceDir = 'reports/adaptive',
    [switch]$Plan,
    [switch]$NoElevate,
    [switch]$Recover
)

$ErrorActionPreference = 'Stop'

# Both halves of the encoding problem, measured on the control arm: PowerShell 5.1
# decodes a native command's stdout with the console code page (CP1252 here), so
# the replay's UTF-8 verdict came back with its em dash turned into mojibake; and
# Get-Content without -Encoding reads a UTF-8 JSON as ANSI, mangling it a second
# time. The transcript and the report row must quote the harness exactly.
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {
    Write-Host "note: could not force UTF-8 console I/O ($($_.Exception.Message)); non-ASCII evidence may be mangled"
}

$root = Split-Path -Parent $PSScriptRoot
$bypass = Join-Path $PSScriptRoot 'rawpath-bypass.ps1'
$marker = Join-Path $PSScriptRoot 'rawpath-bypass.json'
$hostsTool = Join-Path $PSScriptRoot 'rawpath-hosts.mjs'
$replay = Join-Path $PSScriptRoot 'bench-adaptive-replay.ts'

$isIsp = $Arm -eq 'isp'
$evidenceRoot = Join-Path $root $EvidenceDir
$stem = if ($isIsp) { "REPLAY_LIVE_IR_ISP_$Tag" } else { "REPLAY_LIVE_TUNNEL_CONTROL_$Tag" }
$rawStem = if ($isIsp) { "RAW_PATH_IR_ISP_$Tag" } else { "RAW_PATH_TUNNEL_CONTROL_$Tag" }
$jsonPath = Join-Path $evidenceRoot "$stem.json"
$logPath = Join-Path $evidenceRoot "$stem.log"
$rawPath = Join-Path $evidenceRoot "$rawStem.txt"

$script:Lines = [System.Collections.Generic.List[string]]::new()
$script:AddedRoutes = $false
$script:Failed = $null

function Note([string]$Text = '') {
    if ($Text) { Write-Host $Text }
    $script:Lines.Add($Text)
}
function Section([string]$Title) { Note ''; Note "## $Title" }
function Step([string]$Text) { Note ''; Note "=== $Text" }

# A native command: its exit code is the verdict, and its output belongs in the
# transcript as evidence.
# `$ErrorActionPreference = 'Continue'` around the invocation is not optional:
# npm, the proxy cores and curl all narrate on stderr, and with `Stop` PowerShell
# 5.1 turns the FIRST stderr line into a terminating error - measured, it aborted
# the replay on npm's own notice line while the command was still running fine.
# Stderr is captured as text here; the exit code decides.
#
# `2>&1 | Out-String` is not enough on its own: PowerShell 5.1 turns each stderr
# line into an ErrorRecord and Out-String renders it with the
# `node : ... At line:1 char:1 ... CategoryInfo ... NativeCommandError`
# decoration, which made a SUCCESSFUL replay read like a failure in the filed
# transcript. Taking the record's message instead reproduces the line exactly as
# the child wrote it - measured against a probe that writes two UTF-8 stderr
# lines (the em dash intact) and exits 0 and 1.
function Capture([string]$Label, [scriptblock]$Command) {
    Note "--- $Label"
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& $Command 2>&1 | ForEach-Object {
                if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" }
            })
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previous }
    foreach ($line in $lines) { if ($line.Trim()) { Note ('    ' + $line.TrimEnd()) } }
    if ($code -ne 0) { throw "$Label exited with $code" }
    return ($lines -join "`r`n")
}

# A PowerShell script in this repository: it throws on its own failures, so there
# is no exit code to read (and `$LASTEXITCODE` would still hold a stale value
# from the last native command).
function Invoke-Ps([string]$Label, [scriptblock]$Command) {
    Note "--- $Label"
    $lines = @(& $Command *>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" }
        })
    foreach ($line in $lines) { if ($line.Trim()) { Note ('    ' + $line.TrimEnd()) } }
    return ($lines -join "`r`n")
}

function Test-Elevated {
    try {
        (New-Object System.Security.Principal.WindowsPrincipal(
            [System.Security.Principal.WindowsIdentity]::GetCurrent()
        )).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { $false }
}

# Re-launch this script elevated and wait for it. The child owns the evidence (it
# runs the whole measurement, including the restore); the parent only prints where
# that evidence landed and hands back the child's exit code.
function Invoke-ElevatedSelf {
    $argList = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"",
        '-Arm', $Arm, '-Corpus', "`"$Corpus`"", '-LiveNodes', $LiveNodes,
        '-TimeoutMs', $TimeoutMs, '-Tag', $Tag, '-EvidenceDir', "`"$EvidenceDir`""
    )
    if ($NoElevate) { $argList += '-NoElevate' }
    if ($Recover) { $argList += '-Recover' }
    Write-Host 'elevation is required for the bypass routes - a UAC prompt will appear for this script'
    $proc = Start-Process -FilePath (Get-Process -Id $PID).Path -Verb RunAs -Wait -PassThru -ArgumentList $argList
    return $proc.ExitCode
}

# ---------------------------------------------------------------------------
# Corpus -> routes. Computing this instead of pasting a host is what makes the
# bypass cover exactly what is about to be measured.
# ---------------------------------------------------------------------------

function Get-CorpusTopology([string]$Path) {
    $out = Capture 'corpus hosts (host:port only - no link is ever printed)' { node $hostsTool $Path }
    $topology = @()
    $inHosts = $false
    foreach ($line in ($out -split "`r?`n")) {
        if ($line -match '^===\s+distinct hosts') { $inHosts = $true; continue }
        if (-not $inHosts -or -not $line.Trim()) { continue }
        $columns = $line.Trim() -split '\s+'
        $hostName = $columns[0]
        $ports = @($columns | Where-Object { $_ -match '^[a-z0-9]+:\d+$' } |
            ForEach-Object { [int]($_ -split ':')[1] } | Sort-Object -Unique)
        if ($hostName -and $ports.Count -gt 0) {
            $topology += [pscustomobject]@{ Host = $hostName; Ports = $ports }
        }
    }
    if ($topology.Count -eq 0) { throw "no host:port could be derived from $Path" }
    return $topology
}

function Resolve-RouteTargets($Topology) {
    $ips = foreach ($entry in $Topology) {
        if ($entry.Host -match '^\d{1,3}(\.\d{1,3}){3}$') { $entry.Host }
        else {
            $answer = Resolve-DnsName -Name $entry.Host -Type A -ErrorAction Stop |
                Where-Object { $_.IPAddress } | Select-Object -First 1
            if (-not $answer) { throw "no A record for $($entry.Host)" }
            $answer.IPAddress
        }
    }
    return @($ips | Sort-Object -Unique)
}

# The vantage echo must be in the bypass too. The field arm proves its vantage by
# reading Cloudflare's trace on 1.1.1.1 over the RAW path; with no /32 for that
# address the read leaves through the tunnel, reports the tunnel's address, and
# the arm fails its own inequality check - measured in plan mode, where the
# targets came out as the corpus host alone.
function Get-BypassTargets($Topology, [switch]$ForIsp) {
    $ips = @(Resolve-RouteTargets $Topology)
    if ($ForIsp) { $ips = @(($ips + '1.1.1.1') | Sort-Object -Unique) }
    return $ips
}

# Probe the RESOLVED targets (what the routes cover), not the names: a name that
# resolves down two different paths would probe the wrong one.
function Get-ProbePairs($Topology, [string[]]$Targets) {
    $pairs = @()
    foreach ($ip in $Targets) {
        $entry = $Topology | Where-Object { $_.Host -eq $ip } | Select-Object -First 1
        $ports = if ($entry) { $entry.Ports } else { @(443) }
        foreach ($port in $ports) { $pairs += [pscustomobject]@{ Host = $ip; Port = $port } }
    }
    return $pairs
}

function Test-RawTcp([string]$Address, [int]$Port, [int]$TimeoutMs = 6000) {
    $client = [System.Net.Sockets.TcpClient]::new()
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $task = $client.ConnectAsync($Address, $Port)
        if ($task.Wait($TimeoutMs)) {
            $watch.Stop()
            if ($task.IsFaulted) { return 'refused' }
            return ('open in {0} ms' -f [int]$watch.Elapsed.TotalMilliseconds)
        }
        return ('no answer within {0}s' -f [int]($TimeoutMs / 1000))
    } catch { return 'refused' } finally { $client.Dispose() }
}

# A network READ, whose failure is evidence rather than a reason to abandon the
# run: a vantage endpoint can be unreachable for one instant while the corpus is
# still perfectly measurable, and the transcript has to say which happened. The
# reads that ARE gating (the corpus probe, the raw trace on the field arm) check
# their own result explicitly instead of relying on this helper.
function Read-Network([string]$Label, [string]$Url, [switch]$NoProxy) {
    Note "--- $Label"
    $curlArgs = @('-s', '-m', '20')
    if ($NoProxy) { $curlArgs += '--noproxy', '*' }
    $curlArgs += $Url
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & curl.exe @curlArgs 2>&1 | Out-String
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previous }
    foreach ($line in ($out -split "`r?`n")) { if ($line.Trim()) { Note ('    ' + $line.TrimEnd()) } }
    if ($code -ne 0) { Note ("    (curl exited {0}: this read is unavailable right now - recorded, and the run continues)" -f $code) }
    return [pscustomobject]@{ Output = $out; ExitCode = $code; Ok = ($code -eq 0) }
}

function Get-TunnelEgress { Read-Network "tunnel egress (ipinfo.io through the user's tunnel)" 'https://ipinfo.io/json' }
function Get-RawTrace { Read-Network 'raw egress (Cloudflare trace on 1.1.1.1, no proxy)' 'https://1.1.1.1/cdn-cgi/trace' -NoProxy }

function IpFromJson([string]$Json) { try { ($Json | ConvertFrom-Json).ip } catch { $null } }
function IpFromTrace([string]$Trace) {
    $line = ($Trace -split "`r?`n") | Where-Object { $_ -match '^ip=' } | Select-Object -First 1
    if ($line) { return ($line -replace '^ip=', '').Trim() }
    return $null
}

function Show-RouteState([string[]]$Targets) {
    foreach ($ip in $Targets) {
        $route = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "$ip/32" -ErrorAction SilentlyContinue
        if ($route) { Note ('  {0,-20} present   via {1} (ifIndex {2}, metric {3})' -f "$ip/32", $route.NextHop, $route.InterfaceIndex, $route.RouteMetric) }
        else { Note ('  {0,-20} absent' -f "$ip/32") }
    }
}

function Show-DefaultRoutes {
    Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
        Sort-Object RouteMetric | ForEach-Object {
            Note ('  default   via {0,-16} ifIndex {1,-5} metric {2}' -f $_.NextHop, $_.InterfaceIndex, $_.RouteMetric)
        }
}

function Show-Evidence {
    Step 'evidence filed'
    foreach ($file in @($jsonPath, $logPath, $rawPath)) {
        $mark = if (Test-Path $file) { 'filed  ' } else { 'MISSING' }
        Note ('  {0}  {1}' -f $mark, $file)
    }
    if (-not (Test-Path $jsonPath)) { return }
    $evidence = Get-Content $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $rows = @(
        @('episodes compared', $evidence.baseline.episodes, $evidence.adaptive.episodes),
        @('reached a working core', $evidence.baseline.successRate, $evidence.adaptive.successRate),
        @('worked on the FIRST core tried', $evidence.baseline.firstChoiceRate, $evidence.adaptive.firstChoiceRate),
        @('mean attempts per episode', $evidence.baseline.meanAttempts, $evidence.adaptive.meanAttempts),
        @('p50 ms to a working core', $evidence.baseline.p50MsToWorking, $evidence.adaptive.p50MsToWorking),
        @('p95 ms to a working core', $evidence.baseline.p95MsToWorking, $evidence.adaptive.p95MsToWorking),
        @('attempts on a core that never worked', $evidence.baseline.wastedAttempts, $evidence.adaptive.wastedAttempts)
    )
    $width = ($rows | ForEach-Object { $_[0].Length } | Measure-Object -Maximum).Maximum
    Note ''
    Note ('  {0}  {1,10}  {2,10}' -f 'metric'.PadRight($width), 'baseline', 'adaptive')
    foreach ($row in $rows) { Note ('  {0}  {1,10}  {2,10}' -f $row[0].PadRight($width), $row[1], $row[2]) }
    Note ''
    Note ('  first-core choice differed from baseline: {0} of {1} episodes' -f $evidence.firstChoiceDiffered, $evidence.baseline.episodes)
    Note ('  adaptive won / lost a first attempt:       {0} / {1}' -f $evidence.adaptiveWins, $evidence.adaptiveLosses)
    Note ''
    Note ('  verdict: {0}' -f $evidence.verdict)
    Note ''
    Note '  for the evidence report (the narrative sentences are still yours to write):'
    Note ('    | {0} | {1} | {2} recorded attempts | {3} comparable episodes | {4} |' -f `
            $Arm, $Tag, $evidence.attemptsRecorded, $evidence.comparableEpisodes, $evidence.verdict.Split([char]0x2014)[0].Trim())
}

# The transcript is written from the finally below, so a failure still files the
# evidence of how far the run got.
function New-Transcript {
    $header = @(
        '# Raw-path vantage evidence - NetPulse adaptive field measurement',
        "# arm: $Arm - generated by scripts/field-iran-isp.ps1 at $((Get-Date).ToUniversalTime().ToString('o'))"
    )
    $all = @($header + $script:Lines)
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($rawPath, [string[]]$all, $utf8NoBom)
}

# ---------------------------------- preflight -------------------------------

$elevated = Test-Elevated
$corpusExists = Test-Path $Corpus
$entries = if ($corpusExists) {
    @(Get-Content $Corpus | Where-Object { $_.Trim() -and -not $_.Trim().StartsWith('#') }).Count
} else { 0 }

if ($Plan) {
    Write-Host ''
    Write-Host "arm                $Arm"
    Write-Host "repository         $root"
    Write-Host "corpus             $Corpus ($entries usable link(s))"
    if (-not $corpusExists) {
        Write-Host '                   MISSING - one share link per line, kept OUT of the repository (it holds credentials)'
    }
    Write-Host "elevated now       $elevated"
    Write-Host ''
    if ($corpusExists) {
        $topology = Get-CorpusTopology $Corpus
        $targets = Get-BypassTargets $topology -ForIsp:$isIsp
        Write-Host 'route targets (the bypass covers exactly these):'
        $targets | ForEach-Object { Write-Host "  $_/32" }
        Write-Host 'probe pairs:'
        Get-ProbePairs $topology $targets | ForEach-Object { Write-Host ('  {0}:{1}' -f $_.Host, $_.Port) }
    }
    Write-Host ''
    Write-Host 'steps:'
    if ($Recover) {
        Write-Host '  1. bypass remove (targets read back from the marker), then exit'
    } else {
        if ($isIsp) {
            Write-Host "  1. $(if ($elevated) { 'run' } else { 'elevate (UAC), then run' }) scripts/rawpath-bypass.ps1 add with the targets and ports above"
            Write-Host '  2. verify every route is present and the default route is untouched'
            Write-Host '  3. read the raw vantage and require it to differ from the tunnel egress'
            Write-Host '  4. probe TCP reachability of the corpus endpoints'
        }
        $step = if ($isIsp) { '5' } else { '1' }
        Write-Host ("  {0}. npx --no-install tsx scripts/bench-adaptive-replay.ts   [SOURCE=live NODES_FILE={1} LIVE_NODES={2} TIMEOUT_MS={3} OUT={4}]" -f `
                $step, $Corpus, $LiveNodes, $TimeoutMs, $jsonPath)
        if ($isIsp) {
            Write-Host '  6. re-probe reachability, then bypass remove and verify the routes are gone (always, even on failure)'
        }
    }
    Write-Host ''
    Write-Host "evidence would be filed at:"
    Write-Host "  $jsonPath"
    Write-Host "  $logPath"
    Write-Host "  $rawPath"
    Write-Host ''
    exit 0
}

if ($Recover) {
    if (-not $elevated) {
        if ($NoElevate) { Write-Host 'recovery needs an elevated shell (Remove-NetRoute)'; exit 3 }
        exit (Invoke-ElevatedSelf)
    }
    if (-not (Test-Path $marker)) { Write-Host 'no bypass marker: there is nothing recorded to undo'; exit 0 }
    Invoke-Ps 'bypass remove (targets read back from the marker)' { & $bypass remove } | Out-Null
    exit 0
}

if (-not $corpusExists) {
    Write-Host "no corpus at $Corpus"
    Write-Host "expected: one share link per line, from the project's own server. It holds credentials, so it"
    Write-Host 'stays outside the repository (e.g. %TEMP%\vps-corpus.txt), or pass -Corpus <path>.'
    exit 2
}
if ($entries -eq 0) { Write-Host "no usable link in $Corpus"; exit 2 }

if ($isIsp -and -not $elevated) {
    if ($NoElevate) {
        Write-Host 'the isp arm needs an elevated shell (New-NetRoute); re-run from one, or use -Arm control'
        exit 3
    }
    exit (Invoke-ElevatedSelf)
}

New-Item -ItemType Directory -Force -Path $evidenceRoot | Out-Null

# ------------------------------------ run -----------------------------------

# Everything after the routes go in MUST be inside this try, because the restore
# lives in its finally: an exception anywhere below (a vantage that did not take,
# a failed replay) has to leave the machine on its normal path.
try {
    $tunnelIpBefore = $null
    $targets = @()
    $probePairs = @()

    if ($isIsp) {
        Section 'A. the path this run measures'
        Step 'preflight - route state for the targets, and the default path'
        if (Test-Path $marker) {
            Note '  a bypass marker already exists: run with -Recover first - the `add` below will refuse'
        } else {
            Note '  no bypass marker: nothing from an earlier run is recorded as still added'
        }
        Note '  tunnel egress BEFORE the bypass (everything that is not a corpus host):'
        $tunnelIpBefore = IpFromJson ((Get-TunnelEgress).Output)
    } else {
        Section 'A. control arm - the corpus through the tunnel, no routing change'
        Note '  nothing is added or removed on this arm. The same command with the bypass in place is the field arm;'
        Note '  the two are meant to be run inside the same hour, and the report compares them.'
        $tunnelIpBefore = IpFromJson ((Get-TunnelEgress).Output)
    }

    $topology = Get-CorpusTopology $Corpus
    $targets = Get-BypassTargets $topology -ForIsp:$isIsp
    $probePairs = Get-ProbePairs $topology $targets

    if ($isIsp) {
        Step 'bypass setup'
        $ports = @($probePairs | ForEach-Object { $_.Port } | Sort-Object -Unique)
        Invoke-Ps "bypass add (targets: $($targets -join ', '); ports: $($ports -join ', '))" {
            & $bypass add -Targets $targets -Ports $ports
        } | Out-Null
        $script:AddedRoutes = $true

        Step 'verify the bypass - every route present, default route untouched'
        Show-RouteState $targets
        Show-DefaultRoutes
        $missing = @($targets | Where-Object {
                -not (Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "$_/32" -ErrorAction SilentlyContinue)
            })
        if ($missing.Count -gt 0) { throw "the bypass is not in place for: $($missing -join ', ')" }

        Section 'B. egress through the raw ISP path'
        $rawTrace = Get-RawTrace
        $rawIp = IpFromTrace $rawTrace.Output
        if (-not $rawIp) { throw 'the raw path returned no ip= line, so the vantage cannot be proven - refusing to file this as a field arm' }
        if ($tunnelIpBefore -and $rawIp -eq $tunnelIpBefore) {
            throw "the raw path reports the same address as the tunnel ($rawIp): the bypass did not take effect, and measuring here would file a tunnel arm as a field arm"
        }
        if (-not $tunnelIpBefore) { Note '  the tunnel egress could not be read, so the inequality check above is not available: the holder lookup below is the primary proof' }

        Section 'C. holder of the raw egress address (resolved through the tunnel)'
        Step "  raw egress $rawIp"
        $holder = Read-Network "holder of $rawIp" "https://ipinfo.io/$rawIp/json"
        $holderCountry = try { ($holder.Output | ConvertFrom-Json).country } catch { $null }
        if ($holderCountry -and $holderCountry -ne 'IR') {
            Note ("  WARNING: that address is in {0}, not IR - whatever this file is named, its numbers are not an Iranian access-network measurement" -f $holderCountry)
        }

        Section 'D. raw-path TCP reachability (before the run)'
        foreach ($pair in $probePairs) {
            Note ('  {0,-22} {1}' -f ('{0}:{1}' -f $pair.Host, $pair.Port), (Test-RawTcp $pair.Host $pair.Port))
        }
    }

    Section 'E. corpus and replay'
    $env:SOURCE = 'live'
    $env:NODES_FILE = $Corpus
    $env:LIVE_NODES = "$LiveNodes"
    $env:TIMEOUT_MS = "$TimeoutMs"
    $env:OUT = $jsonPath
    try {
        $replayOut = Capture "replay (budget 2 attempts, shipped policy) -> $jsonPath" { npx --no-install tsx $replay }
        Set-Content -Path $logPath -Value $replayOut -Encoding UTF8
    } finally {
        Remove-Item Env:SOURCE, Env:NODES_FILE, Env:LIVE_NODES, Env:TIMEOUT_MS, Env:OUT -ErrorAction SilentlyContinue
    }

    if ($isIsp) {
        Section 'F. raw-path TCP reachability (after the run)'
        Note '  this ISP rotates per-port filtering, so the state the numbers were measured in belongs in the evidence:'
        foreach ($pair in $probePairs) {
            Note ('  {0,-22} {1}' -f ('{0}:{1}' -f $pair.Host, $pair.Port), (Test-RawTcp $pair.Host, $pair.Port))
        }
        Note ('  raw egress after the run: {0}' -f (IpFromTrace ((Get-RawTrace).Output)))
    }
} catch {
    $script:Failed = $_.Exception.Message
    Section 'FAILED'
    Note "  $($script:Failed)"
} finally {
    if ($script:AddedRoutes) {
        Section 'G. restore routing'
        try { Invoke-Ps 'bypass remove' { & $bypass remove -Targets $targets } | Out-Null }
        catch { Note "  RESTORE FAILED: $($_.Exception.Message)" }
        Step 'verify the routes are gone'
        Show-RouteState $targets
        Show-DefaultRoutes
        $left = @($targets | Where-Object {
                Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "$_/32" -ErrorAction SilentlyContinue
            })
        if ($left.Count -gt 0) {
            Note "  STILL PRESENT: $($left -join ', ') - undo it with: scripts/rawpath-bypass.ps1 -Action remove (elevated), or -Recover"
        } else {
            Note '  restored: every route this run added is gone'
        }
        Note '  tunnel egress after the restore:'
        $afterRestore = IpFromJson ((Get-TunnelEgress).Output)
        if ($tunnelIpBefore -and $afterRestore -and $tunnelIpBefore -ne $afterRestore) {
            Note "  note: the tunnel egress address changed during the run ($tunnelIpBefore -> $afterRestore)"
        }
    }
    New-Transcript
}

Show-Evidence
if ($script:Failed) { Write-Host "run failed: $($script:Failed)"; exit 1 }
exit 0
