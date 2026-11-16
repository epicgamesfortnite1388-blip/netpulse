//! NANI Phase 4 — Network context identification.
//!
//! Identifies which network environment the device is on using only local,
//! non-identifying signals. Deliberately does NOT use SSIDs, BSSIDs, MAC
//! addresses, raw private IP addresses, or full browsing URLs, so no
//! cross-service tracking fingerprint is constructed.
//!
//! Each context is assigned a local random identifier. Contexts persist in
//! local storage and can be reset or deleted by the user.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A pseudonymized network context identifier.
///
/// Generated randomly and stored locally only. Never derived from hardware
/// identifiers or network names, so it cannot be used to track the device or
/// user across services.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub struct NetworkContextId(pub u64);

impl NetworkContextId {
    pub fn new() -> Self {
        // Local random identifier; not derived from any network or hardware
        // identifier, so it carries no tracking information.
        Self(rand::random::<u64>())
    }
}

/// The class of network interface, inferred from observable characteristics
/// without reading hardware identifiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum InterfaceClass {
    Unknown,
    Ethernet,
    Wifi,
    MobileHotspot,
    VpnTunnel,
}

/// Observable, non-identifying characteristics used to recognize a network
/// context without collecting SSIDs, MACs, or private IPs.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ContextSignals {
    /// Whether the interface appears to be a wired Ethernet link.
    pub is_ethernet: bool,
    /// Whether the interface appears to be a wireless link.
    pub is_wifi: bool,
    /// Whether the interface appears to be a mobile / cellular hotspot.
    pub is_mobile_hotspot: bool,
    /// Whether traffic is tunneled through a VPN.
    pub is_vpn_tunnel: bool,
    /// Observed gateway reachability class (e.g. direct / captive / proxied).
    pub gateway_class: Option<String>,
    /// Observed DNS resolver class (e.g. local / public / filtered).
    pub resolver_class: Option<String>,
    /// MTU observed on the link, if any.
    pub mtu: Option<u16>,
}

/// A classified network context.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkContext {
    pub id: NetworkContextId,
    pub interface_class: InterfaceClass,
    pub signals: ContextSignals,
    pub first_seen_ms: u64,
    pub last_seen_ms: u64,
    pub seen_count: u64,
}

/// Classifies raw signals into an interface class.
pub fn classify_interface(signals: &ContextSignals) -> InterfaceClass {
    if signals.is_vpn_tunnel {
        return InterfaceClass::VpnTunnel;
    }
    if signals.is_ethernet {
        return InterfaceClass::Ethernet;
    }
    if signals.is_wifi {
        return InterfaceClass::Wifi;
    }
    if signals.is_mobile_hotspot {
        return InterfaceClass::MobileHotspot;
    }
    InterfaceClass::Unknown
}

/// Manages network context identification. Recognizes returning contexts by
/// matching non-identifying signal patterns, assigning a new random id only
/// when no match is found.
#[derive(Debug, Clone, Default)]
pub struct ContextIdentity {
    contexts: Vec<NetworkContext>,
    /// Maximum number of retained contexts (bounded to avoid unbounded growth).
    max_contexts: usize,
}

impl ContextIdentity {
    pub fn new() -> Self {
        Self {
            contexts: Vec::new(),
            max_contexts: 64,
        }
    }

    pub fn with_max_contexts(mut self, max: usize) -> Self {
        self.max_contexts = max.max(1);
        self
    }

    /// Number of known contexts.
    pub fn len(&self) -> usize {
        self.contexts.len()
    }

    /// Identify or create a context for the given signals.
    ///
    /// Returns the context id and whether it was newly created.
    pub fn identify(&mut self, signals: &ContextSignals) -> (NetworkContextId, bool) {
        let now = unix_now_ms();
        let class = classify_interface(signals);

        // Match against existing contexts by signal similarity. A context is
        // considered a match when the interface class and gateway/resolver
        // classes agree — enough to recognize a returning network without
        // storing any identifying information.
        for ctx in &mut self.contexts {
            if ctx.interface_class == class
                && ctx.signals.gateway_class == signals.gateway_class
                && ctx.signals.resolver_class == signals.resolver_class
            {
                ctx.last_seen_ms = now;
                ctx.seen_count += 1;
                ctx.signals = signals.clone(); // refresh latest observations
                return (ctx.id, false);
            }
        }

        // No match: create a new pseudonymized context.
        let id = NetworkContextId::new();
        let ctx = NetworkContext {
            id,
            interface_class: class,
            signals: signals.clone(),
            first_seen_ms: now,
            last_seen_ms: now,
            seen_count: 1,
        };
        self.contexts.push(ctx);
        self.evict_if_over_capacity();
        (id, true)
    }

    fn evict_if_over_capacity(&mut self) {
        if self.contexts.len() <= self.max_contexts {
            return;
        }
        // Evict the least-recently-seen context.
        let min_idx = self
            .contexts
            .iter()
            .enumerate()
            .min_by_key(|(_, c)| c.last_seen_ms)
            .map(|(i, _)| i);
        if let Some(i) = min_idx {
            self.contexts.remove(i);
        }
    }

    /// Look up a context by id.
    pub fn get(&self, id: NetworkContextId) -> Option<&NetworkContext> {
        self.contexts.iter().find(|c| c.id == id)
    }

    /// Reset a single context (user-initiated deletion).
    pub fn remove(&mut self, id: NetworkContextId) -> bool {
        if let Some(pos) = self.contexts.iter().position(|c| c.id == id) {
            self.contexts.remove(pos);
            true
        } else {
            false
        }
    }

    /// Delete all contexts (user-initiated full reset).
    pub fn clear(&mut self) {
        self.contexts.clear();
    }

    pub fn ids(&self) -> Vec<NetworkContextId> {
        self.contexts.iter().map(|c| c.id).collect()
    }

    /// Immutable context list for versioned persistence.
    pub fn contexts(&self) -> &[NetworkContext] {
        &self.contexts
    }

    /// Restore contexts from a persisted snapshot. Duplicate ids are dropped.
    pub fn from_contexts(contexts: Vec<NetworkContext>) -> Self {
        let mut seen = std::collections::HashSet::new();
        let contexts = contexts
            .into_iter()
            .filter(|c| seen.insert(c.id))
            .collect();
        Self {
            contexts,
            max_contexts: 64,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wifi_signals() -> ContextSignals {
        ContextSignals {
            is_wifi: true,
            gateway_class: Some("home".into()),
            resolver_class: Some("local".into()),
            mtu: Some(1500),
            ..Default::default()
        }
    }

    #[test]
    fn identify_creates_new_context() {
        let mut ci = ContextIdentity::new();
        let (id, new) = ci.identify(&wifi_signals());
        assert!(new);
        assert_eq!(ci.len(), 1);
        assert_eq!(ci.get(id).unwrap().seen_count, 1);
    }

    #[test]
    fn identify_recognizes_returning_context() {
        let mut ci = ContextIdentity::new();
        let (id, _) = ci.identify(&wifi_signals());
        let (id2, new) = ci.identify(&wifi_signals());
        assert!(!new);
        assert_eq!(id, id2);
        assert_eq!(ci.get(id).unwrap().seen_count, 2);
    }

    #[test]
    fn different_classes_create_separate_contexts() {
        let mut ci = ContextIdentity::new();
        let mut eth = wifi_signals();
        eth.is_wifi = false;
        eth.is_ethernet = true;
        eth.gateway_class = Some("office".into());
        let (wifi_id, _) = ci.identify(&wifi_signals());
        let (eth_id, _) = ci.identify(&eth);
        assert_ne!(wifi_id, eth_id);
        assert_eq!(ci.len(), 2);
    }

    #[test]
    fn remove_and_clear() {
        let mut ci = ContextIdentity::new();
        let (id, _) = ci.identify(&wifi_signals());
        assert!(ci.remove(id));
        assert_eq!(ci.len(), 0);

        ci.identify(&wifi_signals());
        ci.identify(&wifi_signals());
        assert_eq!(ci.len(), 1);
        ci.clear();
        assert_eq!(ci.len(), 0);
    }

    #[test]
    fn capacity_is_bounded() {
        let mut ci = ContextIdentity::new().with_max_contexts(3);
        let mut ids = Vec::new();
        for i in 0..5 {
            let mut s = wifi_signals();
            s.gateway_class = Some(format!("gw-{}", i));
            let (id, _) = ci.identify(&s);
            ids.push(id);
        }
        assert!(ci.len() <= 3);
    }
}
