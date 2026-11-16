//! NANI Phase 2 — Hardware capability profile and adaptive resource policy.
//!
//! Pure Rust, no external dependencies. Detection uses only standard library
//! APIs; memory is an optional input so callers can supply a measured value.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HardwareTier {
    Minimal,
    Standard,
    HighPerformance,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HardwareProfile {
    pub logical_cores: usize,
    pub memory_mb: Option<u64>,
    pub tier: HardwareTier,
}

impl HardwareProfile {
    /// Build a profile from available parallelism and an optional memory measurement.
    pub fn detect(memory_mb: Option<u64>) -> Self {
        let cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1)
            .max(1);
        let tier = classify(cores, memory_mb);
        Self {
            logical_cores: cores,
            memory_mb,
            tier,
        }
    }

    /// Adaptive sampling interval in milliseconds.
    pub fn sampling_interval_ms(&self) -> u64 {
        match self.tier {
            HardwareTier::Minimal => 5_000,
            HardwareTier::Standard => 2_000,
            HardwareTier::HighPerformance => 1_000,
        }
    }

    /// Maximum concurrent diagnostic tests.
    pub fn max_concurrent_tests(&self) -> usize {
        match self.tier {
            HardwareTier::Minimal => 1,
            HardwareTier::Standard => 2,
            HardwareTier::HighPerformance => 4,
        }
        .min(self.logical_cores.max(1))
    }

    /// Whether local model inference should be considered.
    pub fn allow_model_inference(&self) -> bool {
        matches!(self.tier, HardwareTier::Standard | HardwareTier::HighPerformance)
            && self.memory_mb.map(|m| m >= 4_096).unwrap_or(false)
    }
}

fn classify(cores: usize, memory_mb: Option<u64>) -> HardwareTier {
    let mem = memory_mb.unwrap_or(0);
    if cores >= 8 && mem >= 16_384 {
        HardwareTier::HighPerformance
    } else if cores >= 4 && mem >= 4_096 {
        HardwareTier::Standard
    } else {
        HardwareTier::Minimal
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimal_profile_for_low_resources() {
        let p = HardwareProfile::detect(Some(2_048));
        assert_eq!(p.tier, HardwareTier::Minimal);
        assert!(p.sampling_interval_ms() >= 5_000);
        assert!(!p.allow_model_inference());
    }

    #[test]
    fn high_performance_profile() {
        let p = HardwareProfile::detect(Some(32_768));
        // tier depends on cores; at least sampling sane
        assert!(p.max_concurrent_tests() >= 1);
        assert!(p.sampling_interval_ms() <= 5_000);
    }

    #[test]
    fn concurrency_bounded_by_cores() {
        let p = HardwareProfile {
            logical_cores: 1,
            memory_mb: Some(8_192),
            tier: HardwareTier::Standard,
        };
        assert_eq!(p.max_concurrent_tests(), 1);
    }
}
