//! NANI Phase 4B — read-only local context collector.
//!
//! On Windows, asks the OS directly for the active adapter's *coarse*
//! characteristics through `GetAdaptersAddresses`. It does not spawn PowerShell
//! or any other external process, and it does not read SSIDs, MAC addresses, IP
//! addresses, or packet contents.
//!
//! The adapter index is used only as a local, non-exported discriminator so two
//! Ethernet networks with the same MTU are not merged.

use super::context_identity::ContextSignals;
use serde_json::Value;
use std::slice;

#[cfg(windows)]
use std::ptr;


/// Classify an adapter name/description into a coarse interface class.
pub fn classify_adapter(name: &str, description: &str) -> (bool, bool, bool, bool) {
    let text = format!("{} {}", name, description).to_ascii_lowercase();
    let vpn = ["vpn", "wireguard", "openvpn", "tap-", "tun", "tailscale", "wintun", "proxy"]
        .iter()
        .any(|k| text.contains(k));
    let wifi = ["wi-fi", "wifi", "wireless", "802.11", "wlan"]
        .iter()
        .any(|k| text.contains(k));
    let ethernet = !wifi
        && !vpn
        && (text.contains("ethernet") || text.contains("realtek") || text.contains("intel"));
    let mobile = !wifi
        && !ethernet
        && !vpn
        && ["cellular", "mobile", "wwan", " lte", " 5g"]
            .iter()
            .any(|k| text.contains(k));
    (wifi, ethernet, mobile, vpn)
}

#[cfg(windows)]
#[repr(C)]
struct SocketAddress {
    sockaddr: *mut SockAddr,
    length: i32,
}

#[cfg(windows)]
#[repr(C)]
struct SockAddr {
    family: u16,
    _data: [u8; 14],
}

#[cfg(windows)]
#[repr(C)]
struct AdapterDnsServer {
    _align: [u8; 8],
    next: *mut AdapterDnsServer,
    address: SocketAddress,
}

#[cfg(windows)]
#[repr(C)]
struct AdapterGateway {
    _align: [u8; 8],
    next: *mut AdapterGateway,
    address: SocketAddress,
}

#[cfg(windows)]
#[repr(C)]
struct IpAdapterAddresses {
    length: u32,
    if_index: u32,
    next: *mut IpAdapterAddresses,
    adapter_name: *mut i8,
    _first_unicast: *mut std::ffi::c_void,
    _first_anycast: *mut std::ffi::c_void,
    _first_multicast: *mut std::ffi::c_void,
    first_dns: *mut AdapterDnsServer,
    _dns_suffix: *mut u16,
    description: *mut u16,
    friendly_name: *mut u16,
    _physical_address: [u8; 8],
    _physical_address_length: u32,
    _flags: u32,
    mtu: u32,
    if_type: u32,
    oper_status: u32,
    _ipv6_if_index: u32,
    _zone_indices: [u32; 16],
    _first_prefix: *mut std::ffi::c_void,
    _transmit_link_speed: u64,
    _receive_link_speed: u64,
    _first_wins: *mut std::ffi::c_void,
    first_gateway: *mut AdapterGateway,
}

#[cfg(windows)]
extern "system" {
    fn GetAdaptersAddresses(
        family: u32,
        flags: u32,
        reserved: *mut std::ffi::c_void,
        adapter_addresses: *mut IpAdapterAddresses,
        size_pointer: *mut u32,
    ) -> u32;
}

#[cfg(windows)]
unsafe fn wide_to_string(ptr: *const u16) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let mut len = 0usize;
    while *ptr.add(len) != 0 && len < 4096 {
        len += 1;
    }
    String::from_utf16_lossy(slice::from_raw_parts(ptr, len))
}

#[cfg(windows)]
unsafe fn ansi_to_string(ptr: *const i8) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let mut len = 0usize;
    while *ptr.add(len) != 0 && len < 4096 {
        len += 1;
    }
    String::from_utf8_lossy(slice::from_raw_parts(ptr as *const u8, len)).into_owned()
}

#[cfg(windows)]
fn count_ipv4_dns(server: *mut AdapterDnsServer) -> usize {
    let mut count = 0usize;
    let mut current = server;
    unsafe {
        while !current.is_null() {
            if !(*current).address.sockaddr.is_null()
                && (*(*current).address.sockaddr).family == 2
            {
                count += 1;
            }
            current = (*current).next;
        }
    }
    count
}

#[cfg(windows)]
pub fn collect_context() -> Option<ContextSignals> {
    // AF_UNSPEC = 0.
    let mut size = 0u32;
    let mut ret = unsafe {
        GetAdaptersAddresses(0, 0, ptr::null_mut(), ptr::null_mut(), &mut size)
    };
    // ERROR_BUFFER_OVERFLOW = 111.
    if ret != 111 && ret != 0 {
        return None;
    }
    if size == 0 {
        size = 65536;
    }
    let mut buffer = vec![0u8; size as usize];
    ret = unsafe {
        GetAdaptersAddresses(
            0,
            0,
            ptr::null_mut(),
            buffer.as_mut_ptr() as *mut IpAdapterAddresses,
            &mut size,
        )
    };
    if ret != 0 {
        return None;
    }

    // Collect the lowest-ifIndex "Up" adapter, matching the previous selection.
    let mut best: Option<*mut IpAdapterAddresses> = None;
    let mut count = 0usize;
    let mut up = 0usize;
    unsafe {
        let mut cursor = buffer.as_mut_ptr() as *mut IpAdapterAddresses;
        while !cursor.is_null() {
            count += 1;
            // Skip the software loopback pseudo-interface; the PowerShell path
            // never produced a usable context from it either.
            if (*cursor).oper_status == 1 && (*cursor).if_type != 24 {
                up += 1;
                match best {
                    None => best = Some(cursor),
                    Some(current) if (*cursor).if_index < (*current).if_index => {
                        best = Some(cursor);
                    }
                    _ => {}
                }
            }
            cursor = (*cursor).next;
        }
    }
    let adapter = best?;
    unsafe {
        let name = if !(*adapter).friendly_name.is_null() {
            wide_to_string((*adapter).friendly_name)
        } else if !(*adapter).description.is_null() {
            wide_to_string((*adapter).description)
        } else {
            ansi_to_string((*adapter).adapter_name)
        };
        let description = if !(*adapter).description.is_null() {
            wide_to_string((*adapter).description)
        } else {
            String::new()
        };
        let (wifi, ethernet, mobile, vpn) = classify_adapter(&name, &description);
        if !wifi && !ethernet && !mobile && !vpn {
            return None;
        }
        let index = (*adapter).if_index;
        let has_gateway = !(*adapter).first_gateway.is_null();
        let dns_count = count_ipv4_dns((*adapter).first_dns);
        let mtu = if (*adapter).mtu > 0 && (*adapter).mtu <= u32::from(u16::MAX) {
            Some((*adapter).mtu as u16)
        } else if (*adapter).mtu > 0 {
            // Preserve a coarse MTU without overflowing the signal type.
            Some(u16::MAX)
        } else {
            None
        };
        let has_gateway = !(*adapter).first_gateway.is_null();
        let dns_count = count_ipv4_dns((*adapter).first_dns);
        Some(ContextSignals {
            is_ethernet: ethernet,
            is_wifi: wifi,
            is_mobile_hotspot: mobile,
            is_vpn_tunnel: vpn,
            gateway_class: Some(format!("adapter{}:gw{}", index, if has_gateway { 1 } else { 0 })),
            resolver_class: Some(format!("dns{}", dns_count.min(4))),
            mtu,
        })
    }
}

#[cfg(not(windows))]
pub fn collect_context() -> Option<ContextSignals> {
    None
}

// Keep the JSON parser for compatibility/tests even though collection no longer
// uses an external process.
fn parse_output(bytes: &[u8]) -> Option<ContextSignals> {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let name = value.get("name")?.as_str().unwrap_or("");
    let description = value.get("description")?.as_str().unwrap_or("");
    let (wifi, ethernet, mobile, vpn) = classify_adapter(name, description);
    if !wifi && !ethernet && !mobile && !vpn {
        return None;
    }
    let index = value.get("ifIndex").and_then(|v| v.as_i64()).unwrap_or(0);
    let mtu = value
        .get("mtu")
        .and_then(|v| v.as_i64())
        .and_then(|v| u16::try_from(v).ok());
    let has_gateway = value
        .get("hasGateway")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let dns_count = value
        .get("dnsCount")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    Some(ContextSignals {
        is_ethernet: ethernet,
        is_wifi: wifi,
        is_mobile_hotspot: mobile,
        is_vpn_tunnel: vpn,
        gateway_class: Some(format!("adapter{}:gw{}", index, if has_gateway { 1 } else { 0 })),
        resolver_class: Some(format!("dns{}", dns_count.min(4))),
        mtu,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_common_adapters() {
        assert_eq!(classify_adapter("Wi-Fi", "Intel Wireless-AC"), (true, false, false, false));
        assert_eq!(classify_adapter("Ethernet 2", "Realtek PCIe GbE"), (false, true, false, false));
        assert_eq!(classify_adapter("wg0", "WireGuard Tunnel"), (false, false, false, true));
        assert_eq!(classify_adapter("Cellular", "WWAN LTE"), (false, false, true, false));
        assert_eq!(
            classify_adapter("Ethernet", "Realtek Gaming 2.5GbE Family Controller"),
            (false, true, false, false)
        );
    }

    #[test]
    fn parses_bounded_signal_json() {
        let json = br#"{"name":"Wi-Fi","description":"Intel Wireless","ifIndex":7,"mtu":1500,"hasGateway":true,"dnsCount":2}"#;
        let s = parse_output(json).expect("valid");
        assert!(s.is_wifi);
        assert_eq!(s.mtu, Some(1500));
        assert_eq!(s.gateway_class.as_deref(), Some("adapter7:gw1"));
        assert_eq!(s.resolver_class.as_deref(), Some("dns2"));
    }

    #[test]
    fn accepts_utf8_bom() {
        let mut json = vec![0xEF, 0xBB, 0xBF];
        json.extend_from_slice(br#"{"name":"Ethernet","description":"Realtek","ifIndex":6,"mtu":1500,"hasGateway":true,"dnsCount":1}"#);
        assert!(parse_output(&json).is_some());
    }

    #[cfg(windows)]
    #[test]
    fn native_collector_returns_context() {
        let ctx = collect_context().expect("native adapter collection");
        assert!(ctx.is_wifi || ctx.is_ethernet || ctx.is_mobile_hotspot || ctx.is_vpn_tunnel);
    }

    #[test]
    fn unknown_adapter_is_not_invented() {
        assert!(parse_output(br#"{"name":"loopback","description":"software","ifIndex":1}"#).is_none());
    }
}
