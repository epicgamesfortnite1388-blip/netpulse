# Measure whether DNS queries leave through the VPN tunnel or escape beside it.
#
# A leak is not "the resolver is external" - a tunnel is expected to reach
# public resolvers. A leak is a DNS query whose packets leave through a
# non-tunnel interface. So this harness answers the question in two layers,
# and keeps them separate:
#
#   1. PATH (decisive): for every configured resolver, ask the routing table
#      which interface a datagram to it would use. Same interface as the
#      tunnel's own exit -> the query would be carried by the tunnel. Any other
#      interface -> that query would leave beside the tunnel.
#   2. REACHABILITY: query each resolver for an echo record. A resolver that
#      answers gets its egress identity recorded; a resolver that times out is
#      not used by the OS in practice, so it cannot leak anything.
#
# A leak is claimed only when a resolver that is routed OFF the tunnel also
# answers. Route membership without an answer is not a proven leak, and an
# answer from a tunnel-routed resolver is not a leak at all.
#
# Known limitation, recorded in the output rather than hidden: this cannot see
# packets. It sees the routing decision the OS would make for each resolver,
# which is the same decision the DNS client makes. A TUN that captures by
# rule rather than by route (for example a proxy-only tunnel) would not be
# represented here; in that case every resolver would classify as off-tunnel.
#
# Read-only. No route, adapter, resolver or tunnel is changed.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/measure-dns-leak.ps1
#   powershell ... -File scripts/measure-dns-leak.ps1 -Tag "tun-up-2"
#
# Exit codes: 0 = artifacts filed (leak, no leak, or an explicit INCONCLUSIVE
#                 verdict - read the verdict, not the exit code),
#             2 = could not measure at all (no resolvers or no route).
param(
  [string]$Tag = '',
  [string]$OutDir = '',
  [int]$TimeoutMs = 4000
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $OutDir) { $OutDir = Join-Path $repoRoot 'reports/adaptive' }
$suffix = if ($Tag) { "-$($Tag -replace '[^A-Za-z0-9._-]', '-')" } else { '' }

function Get-TraceEgress {
  # Cloudflare's trace reports the address the request came FROM: the tunnel
  # exit while the tunnel owns the default route.
  try {
    $trace = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 12 -Uri 'https://1.1.1.1/cdn-cgi/trace').Content
    $map = @{}
    foreach ($line in ($trace -split "`n")) {
      $kv = $line.Trim() -split '=', 2
      if ($kv.Count -eq 2) { $map[$kv[0]] = $kv[1] }
    }
    return [pscustomobject]@{ ok = $true; ip = $map['ip']; loc = $map['loc']; colo = $map['colo']; error = $null }
  } catch {
    return [pscustomobject]@{ ok = $false; ip = $null; loc = $null; colo = $null; error = $_.Exception.Message }
  }
}

function Write-TextFile {
  param([string]$Path, [string]$Text)
  # No BOM: the evidence is read by Node, Markdown viewers and humans, and a
  # stray U+FEFF at the top of a JSON/Markdown file is noise in all three.
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-RouteFor {
  param([string]$Address)
  try {
    $route = Find-NetRoute -RemoteIPAddress $Address -ErrorAction Stop | Select-Object -First 1
    return [pscustomobject]@{ interfaceAlias = $route.InterfaceAlias; ifIndex = $route.InterfaceIndex; ok = $true; error = $null }
  } catch {
    return [pscustomobject]@{ interfaceAlias = $null; ifIndex = $null; ok = $false; error = $_.Exception.Message.Split("`n")[0].Trim() }
  }
}

function Resolve-Echo {
  # whoami.akamai.net is an A-record echo: it returns the address of the
  # recursive resolver that asked, which is how a resolver's egress is named
  # without depending on TXT records. TXT is tried as a second witness because
  # some paths strip that record type (observed: every TXT answer empty here).
  param([string]$Server)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $a = Resolve-DnsName -Name 'whoami.akamai.net' -Type A -Server $Server -DnsOnly -QuickTimeout -ErrorAction Stop |
      Where-Object { $_.IPAddress } | Select-Object -First 1
    $sw.Stop()
    if ($a) {
      return [pscustomobject]@{ answered = $true; echo = $a.IPAddress; record = 'A whoami.akamai.net'; rttMs = [int]$sw.ElapsedMilliseconds; error = $null }
    }
    return [pscustomobject]@{ answered = $false; echo = $null; record = $null; rttMs = [int]$sw.ElapsedMilliseconds; error = 'no A answer' }
  } catch {
    $sw.Stop()
    return [pscustomobject]@{ answered = $false; echo = $null; record = $null; rttMs = [int]$sw.ElapsedMilliseconds; error = $_.Exception.Message.Split("`n")[0].Trim() }
  }
}

function Resolve-EchoTxt {
  param([string]$Server)
  try {
    $t = Resolve-DnsName -Name 'o-o.myaddr.l.google.com' -Type TXT -Server $Server -DnsOnly -QuickTimeout -ErrorAction Stop |
      Where-Object { $_.Strings -and $_.Strings.Count -gt 0 } | Select-Object -First 1
    if ($t) { return ($t.Strings -join '').Trim() }
    return $null
  } catch { return $null }
}

function Resolve-SystemName {
  # The query an application's getaddrinfo() makes, with no -Server override.
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $r = Resolve-DnsName -Name 'example.com' -Type A -DnsOnly -QuickTimeout -ErrorAction Stop |
      Where-Object { $_.IPAddress } | Select-Object -First 1
    $sw.Stop()
    return [pscustomobject]@{ ok = [bool]$r; address = $r.IPAddress; rttMs = [int]$sw.ElapsedMilliseconds; error = $null }
  } catch {
    $sw.Stop()
    return [pscustomobject]@{ ok = $false; address = $null; rttMs = [int]$sw.ElapsedMilliseconds; error = $_.Exception.Message.Split("`n")[0].Trim() }
  }
}

$egress = Get-TraceEgress
$defaultRoutes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
  ForEach-Object { [pscustomobject]@{ ifIndex = $_.ifIndex; nextHop = $_.NextHop; metric = $_.RouteMetric; interfaceAlias = $_.InterfaceAlias } })

# The tunnel interface is the one carrying the measured egress address - the
# same lookup the OS performs for any internet destination. If no egress could
# be measured, fall back to the lowest-metric default route.
$tunnelRoute =
  if ($egress.ok) { Get-RouteFor -Address $egress.ip }
  else { $null }
$tunnelIfIndex =
  if ($tunnelRoute -and $tunnelRoute.ok) { $tunnelRoute.ifIndex }
  elseif ($defaultRoutes.Count -gt 0) { ($defaultRoutes | Sort-Object metric | Select-Object -First 1).ifIndex }
  else { $null }
$tunnelInterface =
  if ($tunnelIfIndex -and $defaultRoutes.Count -gt 0) { ($defaultRoutes | Where-Object { $_.ifIndex -eq $tunnelIfIndex } | Select-Object -First 1).interfaceAlias }
  elseif ($tunnelRoute) { $tunnelRoute.interfaceAlias }
  else { $null }

$dnsServers = @()
try {
  $dnsServers = Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object { $_.ServerAddresses -and $_.ServerAddresses.Count -gt 0 } |
    ForEach-Object { [pscustomobject]@{ interfaceAlias = $_.InterfaceAlias; ifIndex = $_.InterfaceIndex; servers = @($_.ServerAddresses) } }
} catch { }

$uniqueServers = @($dnsServers | ForEach-Object { $_.servers } | Sort-Object -Unique)
if ($uniqueServers.Count -eq 0) {
  Write-Error 'no configured IPv4 DNS servers could be enumerated; cannot measure'
  exit 2
}
if (-not $tunnelIfIndex) {
  Write-Error 'no default route or tunnel egress could be identified; cannot classify paths'
  exit 2
}

$resolvers = foreach ($srv in $uniqueServers) {
  $path = Get-RouteFor -Address $srv
  $probe = Resolve-Echo -Server $srv
  $txt = Resolve-EchoTxt -Server $srv
  $boundList = @($dnsServers | Where-Object { $_.servers -contains $srv } | ForEach-Object { $_.interfaceAlias })
  # A public resolver is usually left on several adapters at once; naming all of
  # them buries the one fact the row needs (that it is not the tunnel adapter).
  $boundTo =
    if ($boundList.Count -gt 3) { ($boundList[0..2] -join ', ') + " (+$($boundList.Count - 3) more)" }
    else { $boundList -join ', ' }
  $viaTunnel = [bool]($path.ok -and $path.ifIndex -eq $tunnelIfIndex)
  [pscustomobject]@{
    server = $srv
    configuredOn = $boundTo
    routeInterface = $path.interfaceAlias
    routeIfIndex = $path.ifIndex
    routeViaTunnel = $viaTunnel
    answered = $probe.answered
    resolverEcho = $probe.echo
    echoRecord = $probe.record
    googleTxtEcho = $txt
    rttMs = $probe.rttMs
    error = $probe.error
    verdict =
      if ($probe.answered -and $viaTunnel) { 'answered-through-tunnel-path' }
      elseif ($probe.answered) { 'answered-through-off-tunnel-path' }
      elseif ($viaTunnel) { 'tunnel-path-unreachable' }
      else { 'off-tunnel-unreachable' }
  }
}

$system = Resolve-SystemName

$offTunnelAnswered = @($resolvers | Where-Object { $_.verdict -eq 'answered-through-off-tunnel-path' })
$throughTunnel = @($resolvers | Where-Object { $_.verdict -eq 'answered-through-tunnel-path' })
# Public resolvers configured on PHYSICAL adapters are the fail-open surface: they
# are harmless while the tunnel owns the route, and become raw-path queries the
# moment it stops doing so. This footprint is measured, not inferred.
$failOpenSurface = @($dnsServers | Where-Object { $_.ifIndex -ne $tunnelIfIndex } | ForEach-Object { $_.servers } | Sort-Object -Unique)

$leak = $offTunnelAnswered.Count -gt 0
$verdict =
  # Without a measured egress address there is no proof the default route is a
  # tunnel at all, so "everything is tunneled" must not be claimed from it.
  if (-not $egress.ok) { 'INCONCLUSIVE: no tunnel egress address, so the default route cannot be shown to be a tunnel' }
  elseif ($offTunnelAnswered.Count -gt 0) { 'LEAK: a configured resolver answered over a non-tunnel interface' }
  elseif ($throughTunnel.Count -gt 0) { 'NO LEAK OBSERVED: every answering resolver routes through the tunnel' }
  else { 'INCONCLUSIVE: no configured resolver answered' }

$result = [pscustomobject]@{
  measuredAt = (Get-Date).ToUniversalTime().ToString('o')
  tag = $Tag
  host = [pscustomobject]@{ name = $env:COMPUTERNAME; os = [System.Environment]::OSVersion.VersionString; ps = $PSVersionTable.PSVersion.ToString() }
  tunnel = [pscustomobject]@{
    interfaceAlias = $tunnelInterface
    ifIndex = $tunnelIfIndex
    egressIp = $egress.ip
    location = $egress.loc
    colo = $egress.colo
    traceOk = $egress.ok
    traceError = $egress.error
    defaultRoutes = $defaultRoutes
  }
  dns = [pscustomobject]@{
    serversByInterface = $dnsServers
    resolverProbes = @($resolvers)
    systemResolution = $system
    failOpenSurface = $failOpenSurface
  }
  verdict = [pscustomobject]@{
    leaked = $leak
    summary = $verdict
    answeredOffTunnel = @($offTunnelAnswered | ForEach-Object { $_.server })
    answeredThroughTunnel = @($throughTunnel | ForEach-Object { $_.server })
    note = 'A resolver is judged by the interface its packets would use, not by being public. Off-tunnel resolvers that never answer are unreachable, not leaking. failOpenSurface lists public resolvers configured on physical adapters: they are not leaking now, but would be raw-path queries if the tunnel route disappeared.'
  }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$jsonPath = Join-Path $OutDir "dns_leak_ir_isp$suffix.json"
$mdPath = Join-Path $OutDir "dns_leak_ir_isp$suffix.md"
Write-TextFile -Path $jsonPath -Text ($result | ConvertTo-Json -Depth 8)

$lines = @()
$lines += ('# DNS leak measurement' + $(if ($Tag) { " ($Tag)" } else { '' }))
$lines += ''
$lines += "measured: $($result.measuredAt)"
$lines += ''
$lines += "Tunnel: interface ``$tunnelInterface`` (ifIndex $tunnelIfIndex), egress $($egress.ip) $($egress.loc)$(if ($egress.colo) { " (colo $($egress.colo))" })"
$lines += ''
$lines += '| resolver | configured on | route interface | answers | resolver echo | verdict |'
$lines += '| --- | --- | --- | --- | --- | --- |'
foreach ($r in $resolvers) {
  $lines += "| $($r.server) | $($r.configuredOn) | $($r.routeInterface) | $($r.answered) | $($r.resolverEcho) | $($r.verdict) |"
}
$lines += ''
$lines += "System resolution (example.com): $(if ($system.ok) { $system.address } else { 'FAILED: ' + $system.error })"
$lines += ''
$lines += "Fail-open surface (public resolvers on physical adapters): $(if ($failOpenSurface.Count) { $failOpenSurface -join ', ' } else { 'none' })"
$lines += ''
$lines += "**Verdict:** $verdict"
Write-TextFile -Path $mdPath -Text ($lines -join [Environment]::NewLine)

Write-Output "tunnel        : $tunnelInterface (ifIndex $tunnelIfIndex), egress $($egress.ip) $($egress.loc)"
foreach ($r in $resolvers) { Write-Output ("resolver      : {0,-16} route={1,-14} answered={2,-5} echo={3,-15} {4}" -f $r.server, $r.routeInterface, $r.answered, $r.resolverEcho, $r.verdict) }
Write-Output "system resolve: $(if ($system.ok) { $system.address } else { 'FAILED' })"
Write-Output "fail-open     : $(if ($failOpenSurface.Count) { $failOpenSurface -join ', ' } else { 'none' })"
Write-Output "verdict       : $verdict"
Write-Output "evidence      : $jsonPath"
Write-Output "evidence      : $mdPath"
exit 0
