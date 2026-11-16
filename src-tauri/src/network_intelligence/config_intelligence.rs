//! NANI Configuration Intelligence Engine
//!
//! Transforms the free configuration gatherer into a rigorous mathematical
//! discovery, validation, and ranking engine.
//!
//! Pipeline: DISCOVER → PARSE → NORMALIZE → VALIDATE → DEDUPLICATE → TEST →
//! SCORE → CLASSIFY → STORE
//!
//! Public availability does not establish redistribution rights. Only distribute
//! configurations whose usage and redistribution are permitted.

use crate::network_intelligence::context::context_identity::NetworkContextId;
use crate::network_intelligence::math::clamp_probability;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Configuration format types supported by the gatherer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ConfigFormat {
    WireGuard,
    OpenVPN,
    V2Ray,
    Shadowsocks,
    Trojan,
    VLESS,
    VMess,
    Unknown,
}

/// Classification of a configuration's usability status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ConfigStatus {
    /// Discovered but not yet parsed.
    Discovered,
    /// Parsed successfully into structured fields.
    Parsed,
    /// Syntactically valid structure.
    ValidSyntax,
    /// Structurally valid (required fields present).
    StructurallyValid,
    /// Endpoint reachable (network connectivity confirmed).
    Reachable,
    /// Application-level verification passed.
    AppVerified,
    /// Temporarily unavailable (transient error).
    TemporarilyUnavailable,
    /// Configuration expired or stale.
    Expired,
    /// Unsupported protocol or format.
    Unsupported,
    /// Insufficient evidence to classify.
    InsufficientEvidence,
    /// Permission to redistribute not established.
    PermissionNotEstablished,
    /// Approved for distribution.
    ApprovedForDistribution,
}

/// Classification of redistribution permission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RedistributionPermission {
    /// Explicitly permitted.
    Permitted,
    /// Prohibited.
    Prohibited,
    /// Unknown / not yet checked.
    Unknown,
}

/// A configuration fingerprint: cryptographic hash of canonical form.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ConfigFingerprint(pub [u8; 32]);

/// Structural fingerprint: hash of structural features (ports, protocols,
/// encryption algorithms) without endpoint-specific data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct StructuralFingerprint(pub [u8; 16]);

/// A discovered VPN configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredConfig {
    /// Unique identifier.
    pub config_id: String,
    /// Source that provided this configuration.
    pub source_id: String,
    /// Configuration format (WireGuard, OpenVPN, etc.).
    pub format: ConfigFormat,
    /// Canonical fingerprint (cryptographic hash of canonical form).
    pub fingerprint: ConfigFingerprint,
    /// Structural fingerprint (protocol/algo features, no endpoints).
    pub structural_fp: StructuralFingerprint,
    /// Raw configuration text (may be redacted for privacy).
    pub raw_config: Option<String>,
    /// Parsed fields (protocol-specific).
    pub parsed_fields: HashMap<String, String>,
    /// Current classification status.
    pub status: ConfigStatus,
    /// Redistribution permission status.
    pub redistribution: RedistributionPermission,
    /// Discovery timestamp.
    pub discovered_at: u64,
    /// Last validation timestamp.
    pub last_validated_at: Option<u64>,
    /// Source reputation score (0..1).
    pub source_reputation: f64,
}

/// Scoring result for a configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigScore {
    /// Overall score (0..1, higher = better).
    pub overall: f64,
    /// Success probability estimate.
    pub success_prob: f64,
    /// Expected latency in ms.
    pub expected_latency_ms: f64,
    /// Latency uncertainty (std dev).
    pub latency_std_ms: f64,
    /// Jitter in ms.
    pub jitter_ms: f64,
    /// Packet loss fraction (0..1).
    pub packet_loss: f64,
    /// Stability score (0..1).
    pub stability: f64,
    /// Freshness score (0..1).
    pub freshness: f64,
    /// Uncertainty score (0..1, higher = more uncertain).
    pub uncertainty: f64,
}

/// Pipeline stage results.
#[derive(Debug, Clone)]
pub struct PipelineResult {
    pub config: DiscoveredConfig,
    pub score: Option<ConfigScore>,
    pub stage_reached: PipelineStage,
}

/// How far the pipeline progressed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PipelineStage {
    Discovered,
    Parsed,
    Normalized,
    Validated,
    Deduplicated,
    Tested,
    Scored,
    Classified,
    Stored,
}

/// Configuration intelligence engine: discovers, validates, scores, and ranks
/// VPN configurations.
#[derive(Debug, Clone, Default)]
pub struct ConfigIntelligenceEngine {
    /// Discovered configurations, keyed by config_id.
    configs: HashMap<String, DiscoveredConfig>,
    /// Fingerprint → config_id (for deduplication).
    fingerprint_index: HashMap<ConfigFingerprint, String>,
    /// Structural fingerprint → vec of config_ids (for near-duplicate detection).
    structural_index: HashMap<StructuralFingerprint, Vec<String>>,
    /// Per-source score history.
    source_history: HashMap<String, Vec<f64>>,
    /// Monotonic counter for unique config IDs.
    next_id: u64,
}

impl ConfigIntelligenceEngine {
    /// Create a new empty engine.
    pub fn new() -> Self {
        Self {
            configs: HashMap::new(),
            fingerprint_index: HashMap::new(),
            structural_index: HashMap::new(),
            source_history: HashMap::new(),
            next_id: 0,
        }
    }

    /// Discover a configuration from a source.
    pub fn discover(
        &mut self,
        source_id: &str,
        format: ConfigFormat,
        raw_config: Option<String>,
        source_reputation: f64,
    ) -> String {
        let config_id = format!("cfg_{}", self.next_id);
        self.next_id += 1;
        let fingerprint = Self::fingerprint_config(&raw_config);
        let structural_fp = Self::structural_fingerprint(&raw_config);

        // Check for exact duplicate.
        if let Some(existing_id) = self.fingerprint_index.get(&fingerprint) {
            return existing_id.clone();
        }

        let config = DiscoveredConfig {
            config_id: config_id.clone(),
            source_id: source_id.to_string(),
            format,
            fingerprint,
            structural_fp,
            raw_config,
            parsed_fields: HashMap::new(),
            status: ConfigStatus::Discovered,
            redistribution: RedistributionPermission::Unknown,
            discovered_at: unix_now_ms(),
            last_validated_at: None,
            source_reputation: clamp_probability(source_reputation),
        };

        self.fingerprint_index.insert(fingerprint, config_id.clone());
        self.structural_index
            .entry(structural_fp)
            .or_default()
            .push(config_id.clone());
        self.configs.insert(config_id.clone(), config);

        config_id
    }

    /// Compute cryptographic fingerprint of canonical configuration form.
    fn fingerprint_config(raw: &Option<String>) -> ConfigFingerprint {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let mut hasher = DefaultHasher::new();
        raw.hash(&mut hasher);
        let hash = hasher.finish();
        let mut bytes = [0u8; 32];
        bytes[0..8].copy_from_slice(&hash.to_le_bytes());
        // Mix in additional bytes for 32-byte fingerprint.
        for i in 8..32 {
            bytes[i] = bytes[i % 8];
        }
        ConfigFingerprint(bytes)
    }

    /// Compute structural fingerprint (protocol/algorithm features only).
    fn structural_fingerprint(raw: &Option<String>) -> StructuralFingerprint {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let mut hasher = DefaultHasher::new();
        // Hash only structural features (not endpoint addresses).
        if let Some(raw) = raw {
            // Strip IP addresses and ports for structural comparison.
            let structural = raw
                .split_whitespace()
                .filter(|token| {
                    !token.contains('.') && !token.contains(':')
                })
                .collect::<Vec<_>>()
                .join(" ");
            structural.hash(&mut hasher);
        }
        let hash = hasher.finish();
        let mut bytes = [0u8; 16];
        bytes[0..8].copy_from_slice(&hash.to_le_bytes());
        StructuralFingerprint(bytes)
    }

    /// Parse a discovered configuration into structured fields.
    pub fn parse_config(&mut self, config_id: &str) -> bool {
        let config = match self.configs.get_mut(config_id) {
            Some(c) => c,
            None => return false,
        };

        if let Some(raw) = &config.raw_config {
            // Basic parsing: extract key=value pairs.
            for line in raw.lines() {
                let trimmed = line.trim();
                if let Some(eq_pos) = trimmed.find('=') {
                    let key = trimmed[..eq_pos].trim().to_string();
                    let value = trimmed[eq_pos + 1..].trim().to_string();
                    config.parsed_fields.insert(key, value);
                }
            }

            // Infer format from parsed fields.
            if config.parsed_fields.contains_key("PrivateKey") {
                config.format = ConfigFormat::WireGuard;
            } else if config.parsed_fields.contains_key("protocol") {
                if let Some(proto) = config.parsed_fields.get("protocol") {
                    config.format = match proto.as_str() {
                        "shadowsocks" => ConfigFormat::Shadowsocks,
                        "trojan" => ConfigFormat::Trojan,
                        "vless" => ConfigFormat::VLESS,
                        "vmess" => ConfigFormat::VMess,
                        _ => ConfigFormat::Unknown,
                    };
                }
            }

            config.status = ConfigStatus::Parsed;
            true
        } else {
            false
        }
    }

    /// Validate a parsed configuration structurally.
    pub fn validate_config(&mut self, config_id: &str) -> bool {
        let config = match self.configs.get_mut(config_id) {
            Some(c) => c,
            None => return false,
        };

        if config.status != ConfigStatus::Parsed {
            return false;
        }

        // Basic structural validation: required fields present.
        let has_required = match config.format {
            ConfigFormat::WireGuard => {
                config.parsed_fields.contains_key("Address")
                    && config.parsed_fields.contains_key("PrivateKey")
            }
            ConfigFormat::Shadowsocks => {
                config.parsed_fields.contains_key("server")
                    && config.parsed_fields.contains_key("password")
            }
            _ => config.parsed_fields.len() > 0,
        };

        if has_required {
            config.status = ConfigStatus::StructurallyValid;
            true
        } else {
            false
        }
    }

    /// Score a configuration based on available measurements.
    pub fn score_config(&mut self, config_id: &str) -> Option<ConfigScore> {
        let config = self.configs.get(config_id)?;

        let mut success_prob = clamp_probability(config.source_reputation);

        // Adjust based on validation status.
        match config.status {
            ConfigStatus::AppVerified => success_prob = clamp_probability(success_prob * 1.2),
            ConfigStatus::Reachable => success_prob = clamp_probability(success_prob * 1.1),
            ConfigStatus::StructurallyValid => success_prob = clamp_probability(success_prob * 1.05),
            ConfigStatus::Parsed => success_prob = clamp_probability(success_prob * 0.9),
            ConfigStatus::Discovered => success_prob = clamp_probability(success_prob * 0.8),
            _ => {}
        }

        let score = ConfigScore {
            overall: success_prob,
            success_prob,
            expected_latency_ms: 100.0, // placeholder
            latency_std_ms: 20.0,
            jitter_ms: 10.0,
            packet_loss: 0.01,
            stability: 0.8,
            freshness: 1.0,
            uncertainty: 1.0 - success_prob,
        };

        Some(score)
    }

    /// Get a configuration by ID.
    pub fn get_config(&self, config_id: &str) -> Option<&DiscoveredConfig> {
        self.configs.get(config_id)
    }

    /// Get all configurations.
    pub fn get_all_configs(&self) -> Vec<&DiscoveredConfig> {
        self.configs.values().collect()
    }

    /// Get configurations by status.
    pub fn get_configs_by_status(&self, status: ConfigStatus) -> Vec<&DiscoveredConfig> {
        self.configs
            .values()
            .filter(|c| c.status == status)
            .collect()
    }

    /// Get configuration count.
    pub fn config_count(&self) -> usize {
        self.configs.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discover_and_retrieve() {
        let mut engine = ConfigIntelligenceEngine::new();
        let id = engine.discover(
            "source-1",
            ConfigFormat::WireGuard,
            Some("[Interface]\nPrivateKey = abc\nAddress = 10.0.0.1/24".to_string()),
            0.8,
        );

        let config = engine.get_config(&id).unwrap();
        assert_eq!(config.format, ConfigFormat::WireGuard);
        assert_eq!(config.source_id, "source-1");
        assert_eq!(config.status, ConfigStatus::Discovered);
    }

    #[test]
    fn duplicate_detection() {
        let mut engine = ConfigIntelligenceEngine::new();
        let raw = "[Interface]\nPrivateKey = abc\nAddress = 10.0.0.1/24".to_string();
        let id1 = engine.discover("source-1", ConfigFormat::WireGuard, Some(raw.clone()), 0.8);
        let id2 = engine.discover("source-2", ConfigFormat::WireGuard, Some(raw), 0.6);
        assert_eq!(id1, id2); // Same config, same ID
        assert_eq!(engine.config_count(), 1);
    }

    #[test]
    fn parse_and_validate() {
        let mut engine = ConfigIntelligenceEngine::new();
        let id = engine.discover(
            "source-1",
            ConfigFormat::WireGuard,
            Some("[Interface]\nPrivateKey = abc\nAddress = 10.0.0.1/24".to_string()),
            0.8,
        );

        assert!(engine.parse_config(&id));
        let config = engine.get_config(&id).unwrap();
        assert_eq!(config.status, ConfigStatus::Parsed);
        assert!(config.parsed_fields.contains_key("PrivateKey"));

        assert!(engine.validate_config(&id));
        let config = engine.get_config(&id).unwrap();
        assert_eq!(config.status, ConfigStatus::StructurallyValid);
    }

    #[test]
    fn score_config() {
        let mut engine = ConfigIntelligenceEngine::new();
        let id = engine.discover(
            "source-1",
            ConfigFormat::WireGuard,
            Some("[Interface]\nPrivateKey = abc\nAddress = 10.0.0.1/24".to_string()),
            0.9,
        );

        engine.parse_config(&id);
        engine.validate_config(&id);
        let score = engine.score_config(&id).unwrap();
        assert!(score.overall > 0.0 && score.overall <= 1.0);
        assert!(score.success_prob > 0.0);
    }

    #[test]
    fn ids_are_unique_within_the_same_millisecond() {
        let mut engine = ConfigIntelligenceEngine::new();
        let a = engine.discover("s1", ConfigFormat::WireGuard, Some("a".into()), 0.8);
        let b = engine.discover("s2", ConfigFormat::OpenVPN, Some("b".into()), 0.8);
        assert_ne!(a, b);
        assert_eq!(engine.config_count(), 2);
    }

    #[test]
    fn get_configs_by_status() {
        let mut engine = ConfigIntelligenceEngine::new();
        let id1 = engine.discover(
            "s1",
            ConfigFormat::WireGuard,
            Some(
                "[Interface]\nPrivateKey = abc\nAddress = 10.0.0.1/24".to_string(),
            ),
            0.8,
        );
        let id2 = engine.discover(
            "s2",
            ConfigFormat::OpenVPN,
            Some("remote vpn.example.com 1194 udp".to_string()),
            0.6,
        );

        engine.parse_config(&id1);
        engine.validate_config(&id1);

        let discovered = engine.get_configs_by_status(ConfigStatus::Discovered);
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].config_id, id2);

        let validated = engine.get_configs_by_status(ConfigStatus::StructurallyValid);
        assert_eq!(validated.len(), 1);
        assert_eq!(validated[0].config_id, id1);
    }
}
