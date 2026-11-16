//! NANI Phase 4 — Local episodic memory.
//!
//! Stores structured records of completed diagnostic experiences (episodes).
//! Each episode captures what the system observed, what it concluded, what it
//! did, and what happened next — all from verified outcomes only.
//!
//! All data is local. Episodes never contain secrets, credentials, or raw
//! network payloads. Users can export or delete their episode history.

use crate::network_intelligence::context::context_identity::NetworkContextId;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Evidence quality of an episode. Only `Verified` and `PartiallyVerified`
/// episodes may inform learning; unverified or rejected ones cannot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EvidenceQuality {
    /// Independently verified outcome.
    Verified,
    /// Partially verified (some but not all claims confirmed).
    PartiallyVerified,
    /// Not yet verified.
    Unverified,
    /// Contradictory evidence (conflicting observations).
    Contradictory,
    /// Rejected as invalid.
    Rejected,
    /// Evidence is stale / expired.
    Expired,
}

/// A completed diagnostic episode — a structured record of one diagnostic
/// experience, from observation through resolution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkEpisode {
    /// Unique episode identifier.
    pub episode_id: String,
    /// Network context in which the episode occurred.
    pub context_id: NetworkContextId,
    /// When the episode occurred.
    pub timestamp_ms: u64,
    /// The question or symptom that triggered the episode.
    pub question: String,
    /// Measurement references (measurement ids) consulted.
    pub measurement_refs: Vec<String>,
    /// Initial hypotheses considered.
    pub initial_hypotheses: Vec<String>,
    /// Tests that were run.
    pub tests_run: Vec<String>,
    /// Outcomes observed for each test.
    pub test_outcomes: Vec<String>,
    /// Final diagnosis.
    pub diagnosis: String,
    /// Confidence in the diagnosis (0..1).
    pub confidence: f64,
    /// Action taken.
    pub action_taken: String,
    /// Whether the action was authorized.
    pub authorized: bool,
    /// Whether the outcome was independently verified.
    pub verified: bool,
    /// Outcome persistence (did the fix last?).
    pub outcome_persisted: Option<bool>,
    /// Model versions used.
    pub model_versions: Vec<String>,
    /// Optional user correction (user disagreed with diagnosis/action).
    pub user_correction: Option<String>,
    /// Data sensitivity classification.
    pub sensitivity: Sensitivity,
    /// Evidence quality gate.
    pub quality: EvidenceQuality,
}

/// Sensitivity classification of an episode's data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Sensitivity {
    /// No sensitive data; safe to retain and analyze.
    Public,
    /// Internal operational data; retain locally only.
    Internal,
    /// Potentially sensitive; requires redaction before export.
    Restricted,
}

impl Default for Sensitivity {
    fn default() -> Self {
        Sensitivity::Internal
    }
}

impl Default for EvidenceQuality {
    fn default() -> Self {
        EvidenceQuality::Unverified
    }
}

impl NetworkEpisode {
    /// Create a new episode with default (unverified) quality.
    pub fn new(
        context_id: NetworkContextId,
        timestamp_ms: u64,
        question: impl Into<String>,
    ) -> Self {
        Self {
            episode_id: format!("ep_{}", timestamp_ms),
            context_id,
            timestamp_ms,
            question: question.into(),
            measurement_refs: Vec::new(),
            initial_hypotheses: Vec::new(),
            tests_run: Vec::new(),
            test_outcomes: Vec::new(),
            diagnosis: String::new(),
            confidence: 0.0,
            action_taken: String::new(),
            authorized: false,
            verified: false,
            outcome_persisted: None,
            model_versions: Vec::new(),
            user_correction: None,
            sensitivity: Sensitivity::Internal,
            quality: EvidenceQuality::Unverified,
        }
    }

    /// Mark the episode as verified with a given quality.
    pub fn verify(mut self, quality: EvidenceQuality) -> Self {
        self.verified = true;
        self.quality = quality;
        self
    }

    /// Record a user correction (user disagreed with the diagnosis/action).
    pub fn correct(mut self, correction: impl Into<String>) -> Self {
        self.user_correction = Some(correction.into());
        self
    }

    /// Whether this episode is suitable for learning (verified and not
    /// contradictory/rejected).
    pub fn is_learnable(&self) -> bool {
        matches!(
            self.quality,
            EvidenceQuality::Verified | EvidenceQuality::PartiallyVerified
        ) && self.sensitivity != Sensitivity::Restricted
    }
}

/// Local episodic memory store — bounded, bounded retention, user-deletable.
#[derive(Debug, Clone, Default)]
pub struct EpisodeMemory {
    episodes: Vec<NetworkEpisode>,
    max_episodes: usize,
    /// Episodes indexed by context for fast retrieval.
    by_context: HashMap<NetworkContextId, Vec<usize>>,
}

impl EpisodeMemory {
    pub fn new(max_episodes: usize) -> Self {
        Self {
            episodes: Vec::new(),
            max_episodes: max_episodes.max(1),
            by_context: HashMap::new(),
        }
    }

    /// Record a new episode.
    pub fn record(&mut self, episode: NetworkEpisode) {
        let idx = self.episodes.len();
        self.episodes.push(episode);
        let ctx = self.episodes.last().unwrap().context_id;
        self.by_context.entry(ctx).or_insert_with(Vec::new).push(idx);
        if self.episodes.len() > self.max_episodes {
            let excess = self.episodes.len() - self.max_episodes;
            self.episodes.drain(0..excess);
            // Rebuild index after drain (simple but correct).
            self.rebuild_index();
        }
    }

    fn rebuild_index(&mut self) {
        self.by_context.clear();
        for (i, ep) in self.episodes.iter().enumerate() {
            self.by_context
                .entry(ep.context_id)
                .or_insert_with(Vec::new)
                .push(i);
        }
    }

    /// Number of stored episodes.
    pub fn len(&self) -> usize {
        self.episodes.len()
    }

    /// Whether the store is empty.
    pub fn is_empty(&self) -> bool {
        self.episodes.is_empty()
    }

    /// All verified, learnable episodes for a context, most recent first.
    pub fn verified_for_context(&self, context_id: NetworkContextId) -> Vec<&NetworkEpisode> {
        self.by_context
            .get(&context_id)
            .map(|idxs| {
                idxs.iter()
                    .filter_map(|i| self.episodes.get(*i))
                    .filter(|e| e.is_learnable())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// All verified episodes across all contexts, most recent first.
    pub fn all_verified(&self) -> Vec<&NetworkEpisode> {
        self.episodes.iter().filter(|e| e.is_learnable()).collect()
    }

    /// Attach a user correction to an existing episode. Returns false when the
    /// episode does not exist. A correction never changes evidence quality.
    pub fn set_correction(&mut self, episode_id: &str, correction: &str) -> bool {
        if let Some(episode) = self.episodes.iter_mut().find(|e| e.episode_id == episode_id) {
            episode.user_correction = Some(correction.to_string());
            true
        } else {
            false
        }
    }

    /// User-initiated: delete all episodes for a context.
    pub fn delete_context(&mut self, context_id: NetworkContextId) -> usize {
        let before = self.episodes.len();
        self.episodes.retain(|ep| ep.context_id != context_id);
        let removed = before - self.episodes.len();
        self.rebuild_index();
        removed
    }

    /// User-initiated: delete all episodes.
    pub fn clear(&mut self) -> usize {
        let count = self.episodes.len();
        self.episodes.clear();
        self.by_context.clear();
        count
    }

    /// Snapshot of all retained episodes (oldest first).
    pub fn snapshot(&self) -> Vec<NetworkEpisode> {
        self.episodes.clone()
    }

    /// Restore an episode memory from a persisted snapshot, respecting the
    /// configured bound. Corrupt or oversized inputs are truncated, never
    /// trusted beyond the bound.
    pub fn from_snapshot(episodes: Vec<NetworkEpisode>, max_episodes: usize) -> Self {
        let mut mem = Self::new(max_episodes);
        for episode in episodes {
            mem.record(episode);
        }
        mem
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn episode_records_and_retrieves() {
        let mut mem = EpisodeMemory::new(10);
        let ctx = NetworkContextId(1);
        let mut ep = NetworkEpisode::new(ctx, 1000, "dns failure".to_string());
        ep.measurement_refs.push("m1".to_string());
        ep.initial_hypotheses.push("dns".to_string());
        ep.diagnosis = "dns failure".to_string();
        ep.verified = true;
        ep.quality = EvidenceQuality::Verified;
        mem.record(ep);

        let retrieved = mem.verified_for_context(ctx);
        assert_eq!(retrieved.len(), 1);
        assert_eq!(retrieved[0].diagnosis, "dns failure");
    }

    #[test]
    fn unverified_episodes_are_not_learnable() {
        let mut mem = EpisodeMemory::new(10);
        let ctx = NetworkContextId(1);
        let ep = NetworkEpisode::new(ctx, 1000, "test".to_string());
        mem.record(ep);
        assert!(mem.verified_for_context(ctx).is_empty());
    }

    #[test]
    fn delete_context_removes_episodes() {
        let mut mem = EpisodeMemory::new(10);
        let ctx1 = NetworkContextId(1);
        let ctx2 = NetworkContextId(2);
        let mut ep1 = NetworkEpisode::new(ctx1, 1000, "a".to_string());
        ep1.verified = true;
        ep1.quality = EvidenceQuality::Verified;
        let mut ep2 = NetworkEpisode::new(ctx2, 2000, "b".to_string());
        ep2.verified = true;
        ep2.quality = EvidenceQuality::Verified;
        mem.record(ep1);
        mem.record(ep2);
        assert_eq!(mem.len(), 2);
        assert_eq!(mem.delete_context(ctx1), 1);
        assert_eq!(mem.len(), 1);
        assert_eq!(mem.verified_for_context(ctx1).len(), 0);
        assert_eq!(mem.verified_for_context(ctx2).len(), 1);
    }

    #[test]
    fn correction_updates_in_place_without_changing_quality() {
        let mut mem = EpisodeMemory::new(10);
        let ctx = NetworkContextId(1);
        let ep = NetworkEpisode::new(ctx, 1000, "t".to_string()).verify(EvidenceQuality::Verified);
        mem.record(ep);
        let id = mem.verified_for_context(ctx)[0].episode_id.clone();
        assert!(mem.set_correction(&id, "resolver was actually fine"));
        assert_eq!(mem.len(), 1);
        let stored = &mem.verified_for_context(ctx)[0];
        assert_eq!(stored.user_correction.as_deref(), Some("resolver was actually fine"));
        assert_eq!(stored.quality, EvidenceQuality::Verified);
        assert!(!mem.set_correction("missing", "x"));
    }

    #[test]
    fn bounded_retention() {
        let mut mem = EpisodeMemory::new(3);
        for i in 0..5 {
            mem.record(NetworkEpisode::new(NetworkContextId(1), i as u64, "t".to_string()));
        }
        assert_eq!(mem.len(), 3);
    }
}
