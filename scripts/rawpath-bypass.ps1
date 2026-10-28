# Temporary host-route bypass, used to measure the ISP's own path while the
# user's Happ/sing-box tunnel keeps owning 0.0.0.0/0 for everything else.
#
#   add     add /32 routes via the LAN gateway, prove the raw egress, check the
#           corpus ports, and write scripts/rawpath-bypass.json (what to undo)
#   remove  delete exactly the routes this script added, then re-check the egress
#   status  print whether the bypass is in place (no change)
#
# Routes go to the ActiveStore only: they never persist across a reboot, and
# nothing about the tunnel, DNS or firewall is touched.
#
# `-Targets`/`-Ports` exist so a harness can compute them from the corpus it is
# about to measure; `remove` and `status` read them back from the marker when one
# exists, so an interrupted run is undone by `remove` alone.
param(
    [Parameter(Mandatory = $true)][ValidateSet('add', 'remove', 'status')][string]$Action,

    # The /32 routes to add: the corpus host(s), plus an IP echo to read the
    # vantage from. Computed from the corpus by scripts/field-iran-isp.ps1, which
    # is what makes this reusable instead of tied to one measurement.
    [string[]]$Targets = @('206.1.96.89', '1.1.1.1'),

    # Ports probed for raw-path reachability at `add`. Defaults to the corpus
    # node ports the first field measurement used.
    [int[]]$Ports = @(443, 2053, 2087, 8443)
)

$ErrorActionPreference = 'Stop'
$marker = Join-Path $PSScriptRoot 'rawpath-bypass.json'

# `remove` and `status` prefer what the marker actually recorded: a run that was
# interrupted (Ctrl+C in the elevated window, a closed console) leaves only the
# marker, and asking the operator to remember the target list is how a route
# stays behind forever.
$recorded = $null
if (Test-Path $marker) {
    try { $recorded = @((Get-Content $marker -Raw | ConvertFrom-Json).targets) } catch { $recorded = $null }
}
if ($Action -ne 'add' -and $recorded -and $recorded.Count -gt 0) { $Targets = $recorded }
$targets = @($Targets)

function Get-LanPath {
    $addr = Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
        $_.InterfaceAlias -eq 'Ethernet' -and $_.IPAddress -like '192.168.1.*'
    } | Select-Object -First 1
    if (-not $addr) { throw 'no 192.168.1.x address on the Ethernet adapter' }
    $gw = (Get-NetIPConfiguration -InterfaceIndex $addr.InterfaceIndex).IPv4DefaultGateway
    if (-not $gw) { throw 'the Ethernet adapter has no IPv4 default gateway' }
    [pscustomobject]@{ IfIndex = $addr.InterfaceIndex; NextHop = $gw.NextHop }
}

function Show-Egress([string]$label) {
    Write-Output ''
    Write-Output "=== $label"
    foreach ($ip in $targets) {
        $fields = curl.exe --noproxy '*' -s -m 15 "https://$ip/cdn-cgi/trace" 2>&1 |
            Select-String -Pattern '^(ip|loc|colo)=' | ForEach-Object { $_.Line.Trim() }
        $joined = if ($fields) { $fields -join ' ' } else { '<no answer>' }
        Write-Output ("  probe -> {0}" -f $joined)
    }
}

function Show-Ports {
    param([string]$Host_, [int[]]$Ports)
    Write-Output ''
    Write-Output "=== raw-path TCP reachability to ${Host_}"
    foreach ($port in $Ports) {
        $client = [System.Net.Sockets.TcpClient]::new()
        $state = 'timeout'
        try {
            $task = $client.ConnectAsync($Host_, $port)
            if ($task.Wait(6000)) { $state = if ($task.IsFaulted) { 'refused' } else { 'open' } }
        } catch { $state = 'refused' }
        finally { $client.Dispose() }
        Write-Output ("  {0}:{1}  {2}" -f $Host_, $port, $state)
    }
}

switch ($Action) {
    'status' {
        Get-NetRoute -AddressFamily IPv4 | Where-Object {
            $_.DestinationPrefix -in ($targets | ForEach-Object { "$_/32" })
        } | Select-Object DestinationPrefix, NextHop, InterfaceAlias, RouteMetric | Format-Table -AutoSize
        foreach ($ip in $targets) {
            $present = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "$ip/32" -ErrorAction SilentlyContinue
            Write-Output ("  {0,-20} {1}" -f "$ip/32", $(if ($present) { 'IN place (dialled through the Ethernet gateway)' } else { 'NOT in place (dialled through the tunnel)' }))
        }
        if ($recorded -and $recorded.Count -gt 0) {
            Write-Output ("  marker records:      {0}" -f ($recorded -join ', '))
        } else {
            Write-Output '  marker records:      nothing (no bypass to undo)'
        }
    }
    'add' {
        if ($recorded -and $recorded.Count -gt 0) {
            throw "a bypass from an earlier run is still recorded in $marker for: $($recorded -join ', '). Run ``remove`` (elevated) first so those routes are deleted before new ones are added - otherwise a target list from the earlier run can be left behind by this one."
        }
        $lan = Get-LanPath
        foreach ($ip in $targets) {
            $prefix = "$ip/32"
            $existing = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix $prefix -ErrorAction SilentlyContinue
            if ($existing) { $existing | Remove-NetRoute -Confirm:$false }
            New-NetRoute -DestinationPrefix $prefix -InterfaceIndex $lan.IfIndex -NextHop $lan.NextHop `
                -RouteMetric 1 -PolicyStore ActiveStore | Out-Null
            Write-Output ("added {0} via {1} ifIndex {2} (ActiveStore only)" -f $prefix, $lan.NextHop, $lan.IfIndex)
        }
        Get-NetRoute -AddressFamily IPv4 | Where-Object {
            $_.DestinationPrefix -in ($targets | ForEach-Object { "$_/32" })
        } | Select-Object DestinationPrefix, NextHop, InterfaceAlias, RouteMetric | Format-Table -AutoSize
        Show-Egress 'raw egress through the bypassed route'
        Show-Ports -Host_ $targets[0] -Ports $Ports
        [pscustomobject]@{
            addedAt   = (Get-Date).ToUniversalTime().ToString('o')
            targets   = $targets
            ports     = $Ports
            ifIndex   = $lan.IfIndex
            nextHop   = $lan.NextHop
            policyStore = 'ActiveStore'
        } | ConvertTo-Json | Set-Content -Path $marker -Encoding UTF8
        Write-Output ''
        Write-Output ("marker written: {0}" -f $marker)
    }
    'remove' {
        foreach ($ip in $targets) {
            $prefix = "$ip/32"
            $existing = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix $prefix -ErrorAction SilentlyContinue
            if ($existing) {
                $existing | Remove-NetRoute -Confirm:$false
                Write-Output "removed $prefix"
            } else {
                Write-Output "$prefix was not present"
            }
        }
        Show-Egress 'egress after restoration'
        if (Test-Path $marker) { Remove-Item $marker -Force; Write-Output ("marker removed: {0}" -f $marker) }
    }
}
