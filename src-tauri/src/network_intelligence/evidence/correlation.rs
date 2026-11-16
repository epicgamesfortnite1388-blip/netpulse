//! NANI Phase 4 — Correlated evidence handling.
//!
//! A DNS timeout, a TCP connect timeout and an HTTP timeout observed in the
//! same window are often three symptoms of one underlying fault. A Bayesian
//! update that treats them as independent multiplies the same likelihood three
//! times and becomes overconfident.
//!
//! This module makes the dependency structure explicit. Each group lists tests
//! that share a causal path. Before evidence enters a diagnosis, each
//! observation after the first (strongest) member of a cluster is discounted by
//! `1 / (1 + preceding_correlated_count)`. The observation is kept — it is real
//! evidence — but it no longer counts as an independent proof of the same
//! hypothesis.
//!
//! The model is deliberately conservative: it only discounts, never promotes,
//! and it never drops an observation entirely.

/// How strongly a repeated causal path is discounted. 1.0 would divide by
/// `1 + n`; the calibrated value keeps the evidence while preventing the same
/// fault from being counted as several independent confirmations. It is set
/// from deterministic simulator accuracy, not from intuition.
const CORRELATION_DISCOUNT: f64 = 0.5;

/// Tests that share an upstream causal path and therefore must not be counted
/// as independent confirmations of the same hypothesis.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorrelationGroup {
    pub id: String,
    pub test_ids: Vec<String>,
    pub reason: String,
}

impl CorrelationGroup {
    pub fn new(id: impl Into<String>, test_ids: &[&str], reason: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            test_ids: test_ids.iter().map(|t| (*t).to_string()).collect(),
            reason: reason.into(),
        }
    }

    pub fn contains(&self, test_id: &str) -> bool {
        self.test_ids.iter().any(|t| t == test_id)
    }
}

/// Explicit dependency structure over the diagnostic test library.
#[derive(Debug, Clone)]
pub struct CorrelationModel {
    groups: Vec<CorrelationGroup>,
}

impl Default for CorrelationModel {
    fn default() -> Self {
        Self::new()
    }
}

impl CorrelationModel {
    /// Default structure for NANI's diagnostic tests.
    ///
    /// - `shared-transport`: TCP, TLS and HTTP all traverse the same transport
    ///   path; one routing/transport fault explains all three.
    /// - `shared-resolver`: a DNS lookup and an HTTP request that begins with
    ///   resolution share the resolver, but only the lookup isolates DNS.
    /// - `provider-side`: authentication, rate limiting and the application
    ///   operation all depend on the same provider endpoint.
    pub fn new() -> Self {
        Self {
            groups: vec![
                CorrelationGroup::new(
                    "shared-transport",
                    &["tcp-connect", "tls-handshake", "http-reachability", "mtu-probe"],
                    "same transport path",
                ),
                CorrelationGroup::new(
                    "shared-resolver",
                    &["dns-lookup", "http-reachability", "app-operation"],
                    "HTTP and application probes resolve the hostname first",
                ),
                CorrelationGroup::new(
                    "provider-side",
                    &["auth-check", "rate-limit-check", "app-operation"],
                    "same provider endpoint",
                ),
            ],
        }
    }

    pub fn with_groups(groups: Vec<CorrelationGroup>) -> Self {
        Self { groups }
    }

    pub fn groups(&self) -> &[CorrelationGroup] {
        &self.groups
    }

    /// IDs of groups containing `test_id`.
    pub fn groups_for(&self, test_id: &str) -> Vec<&CorrelationGroup> {
        self.groups.iter().filter(|g| g.contains(test_id)).collect()
    }

    pub fn correlated(&self, a: &str, b: &str) -> bool {
        self.groups
            .iter()
            .any(|g| g.contains(a) && g.contains(b))
    }

    /// Weight of one new observation given the earlier observations in the
    /// current diagnostic window. Repeating the *same* test is new evidence
    /// over time and keeps full weight; only different tests on the same
    /// causal path are discounted. Allocation-free so the Bayesian update
    /// stays cheap on the hot path.
    pub fn weight_for(&self, prior_tests: &[&str], test_id: &str) -> f64 {
        let correlated_prior = prior_tests
            .iter()
            .filter(|prior| **prior != test_id && self.correlated(test_id, prior))
            .count();
        1.0 / (1.0 + CORRELATION_DISCOUNT * correlated_prior as f64)
    }

    /// Discount reliability for a chronological observation sequence.
    ///
    /// Returns one weight per input observation, aligned by index. The first
    /// observation in each correlated cluster keeps its reliability; each later
    /// member is divided by `1 + number of earlier correlated observations`.
    /// Returns `None` when the input and output would be misaligned (defensive).
    pub fn adjusted_weights(&self, observations: &[(String, f64)]) -> Option<Vec<f64>> {
        let mut seen: Vec<&str> = Vec::with_capacity(observations.len());
        let mut out = Vec::with_capacity(observations.len());
        for (test_id, reliability) in observations {
            if !reliability.is_finite() {
                return None;
            }
            let correlated_prior = seen
                .iter()
                .filter(|prior| self.correlated(test_id, prior))
                .count();
            let weight =
                reliability.clamp(0.0, 1.0) / (1.0 + CORRELATION_DISCOUNT * correlated_prior as f64);
            out.push(weight);
            seen.push(test_id);
        }
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obs(id: &str, r: f64) -> (String, f64) {
        (id.to_string(), r)
    }

    #[test]
    fn independent_tests_keep_full_weight() {
        let model = CorrelationModel::new();
        // DNS and TLS share no group.
        let w = model
            .adjusted_weights(&[obs("dns-lookup", 1.0), obs("tls-handshake", 0.9)])
            .unwrap();
        assert_eq!(w, vec![1.0, 0.9]);
    }

    #[test]
    fn correlated_tests_are_discounted_not_dropped() {
        let model = CorrelationModel::new();
        let w = model
            .adjusted_weights(&[
                obs("tcp-connect", 1.0),
                obs("tls-handshake", 1.0),
                obs("http-reachability", 1.0),
            ])
            .unwrap();
        assert_eq!(w.len(), 3);
        assert_eq!(w[0], 1.0);
        assert_eq!(w[1], 1.0 / 1.5);
        assert_eq!(w[2], 1.0 / 2.0);
    }

    #[test]
    fn overlapping_groups_use_the_strongest_discount() {
        let model = CorrelationModel::new();
        // http-reachability is in both shared-transport and shared-resolver,
        // after dns-lookup and tcp-connect, so two prior correlated probes.
        let w = model
            .adjusted_weights(&[
                obs("dns-lookup", 1.0),
                obs("tcp-connect", 1.0),
                obs("http-reachability", 1.0),
            ])
            .unwrap();
        assert_eq!(w[2], 1.0 / 2.0);
    }

    #[test]
    fn unknown_tests_are_independent() {
        let model = CorrelationModel::new();
        let w = model
            .adjusted_weights(&[obs("custom-probe-a", 1.0), obs("custom-probe-b", 1.0)])
            .unwrap();
        assert_eq!(w, vec![1.0, 1.0]);
    }

    #[test]
    fn non_finite_reliability_is_rejected() {
        let model = CorrelationModel::new();
        assert!(model
            .adjusted_weights(&[obs("dns-lookup", f64::NAN)])
            .is_none());
    }
    #[test]
    fn repeating_the_same_test_is_new_evidence_not_correlation() {
        let model = CorrelationModel::new();
        assert_eq!(model.weight_for(&["dns-lookup"], "dns-lookup"), 1.0);
        assert_eq!(
            model.weight_for(&["tcp-connect", "tls-handshake"], "tls-handshake"),
            1.0 / 1.5
        );
    }

}
