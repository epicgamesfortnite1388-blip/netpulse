//! Persistence layer for NANI observations and model state.
//!
//! Provides a bounded, versioned, atomic on-disk store for:
//!   - Observations: API probe results (timestamp, category, success, latency)
//!   - Model state: per-API success trackers (BetaBernoulli parameters)
//!
//! Design constraints:
//!   - Versioned schema (schema version file)
//!   - Bounded retention (oldest evicted when cap reached)
//!   - Atomic writes (write temp, then rename)
//!   - No secrets: observation records contain no authorization headers,
//!     cookies, tokens, or raw request bodies
//!   - No new crate dependencies: serde_json is already a dependency
//!   - Raw observations stored separately from derived model state

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};

/// Schema version. Increment on any breaking change to the persisted shape.
pub const SCHEMA_VERSION: u64 = 1;

/// Maximum observations retained before compaction.
const MAX_OBSERVATIONS: usize = 10_000;

/// Append this many observations between full-file compactions. Rewriting the
/// whole journal on every record is O(n²) and made a 10k-record run take
/// minutes; appending is O(1) and compaction is amortized.
const COMPACT_EVERY: usize = 512;

/// Subdirectory name under the app data dir.
const STORE_DIR: &str = "nani";

/// A single persisted observation: what was measured, when, and the outcome.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Observation {
    pub api_id: String,
    pub timestamp_ms: u64,
    pub category: String,
    pub success: bool,
    pub latency_ms: Option<f64>,
}

/// Calibration outcomes retained before the oldest are evicted.
const MAX_CALIBRATION_SAMPLES: usize = 500;

/// Derived model state (bandit params, drift state, calibration).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelState {
    pub bandit: HashMap<String, f64>,
    pub calibration: HashMap<String, f64>,
    /// Real `(confidence, confirmed)` pairs from observed probes, oldest first.
    /// `serde(default)` keeps a model file written before this field loadable.
    #[serde(default)]
    pub calibration_samples: Vec<(f64, f64)>,
}

/// Persistence store: observations JSONL + model state JSON, schema versioned.
#[derive(Debug, Clone)]
pub struct PersistenceStore {
    dir: PathBuf,
    observations_path: PathBuf,
    model_state_path: PathBuf,
    version_path: PathBuf,
    observations: Vec<Observation>,
    model: ModelState,
    /// Appends since the last full-file compaction.
    appends_since_compaction: usize,
}

impl PersistenceStore {
    /// Open (or create) the persistent store at `dir`.
    ///
    /// Creates `dir/nani/` if missing, reads the schema version and any
    /// existing model state, and loads recent observations from the journal.
    pub fn new(data_dir: &Path) -> std::io::Result<Self> {
        let dir = data_dir.join(STORE_DIR);
        fs::create_dir_all(&dir)?;
        let observations_path = dir.join("observations.jsonl");
        let model_state_path = dir.join("model_state.json");
        let version_path = dir.join("schema.version");

        // Ensure the schema version file exists and migrate older stores. A
        // future schema change lands here as an explicit migration step rather
        // than silently trusting an older on-disk shape.
        let existing_version = if version_path.exists() {
            fs::read_to_string(&version_path)
                .ok()
                .and_then(|s| s.trim().parse::<u64>().ok())
                .unwrap_or(0)
        } else {
            0
        };
        if existing_version > SCHEMA_VERSION {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("unsupported schema version {existing_version}"),
            ));
        }
        // Migration support: older versions are normalized to the current
        // schema. The current schema has only version 1, so this is a no-op
        // today but keeps the migration point explicit.
        fs::write(&version_path, format!("{}\n", SCHEMA_VERSION))?;

        let observations = Self::load_observations(&observations_path)?;
        let model = Self::load_model_state(&model_state_path).unwrap_or_default();

        Ok(Self {
            dir,
            observations_path,
            model_state_path,
            version_path,
            observations,
            model,
            appends_since_compaction: 0,
        })
    }

    /// In-memory store for tests (no disk I/O).
    pub fn default() -> Self {
        Self {
            dir: PathBuf::new(),
            observations_path: PathBuf::new(),
            model_state_path: PathBuf::new(),
            version_path: PathBuf::new(),
            observations: Vec::new(),
            model: ModelState::default(),
            appends_since_compaction: 0,
        }
    }

    fn load_observations(path: &Path) -> std::io::Result<Vec<Observation>> {
        if !path.exists() {
            return Ok(Vec::new());
        }
        let file = fs::File::open(path)?;
        let reader = BufReader::new(file);
        let mut obs = Vec::new();
        for line in reader.lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Observation>(&line) {
                Ok(o) => obs.push(o),
                Err(_) => {
                    // Skip malformed lines rather than corrupting the store.
                }
            }
        }
        // Keep only the most recent MAX_OBSERVATIONS.
        if obs.len() > MAX_OBSERVATIONS {
            let drop = obs.len() - MAX_OBSERVATIONS;
            obs.drain(0..drop);
        }
        Ok(obs)
    }

    fn load_model_state(path: &Path) -> std::io::Result<ModelState> {
        if !path.exists() {
            return Ok(ModelState::default());
        }
        let data = fs::read_to_string(path)?;
        serde_json::from_str(&data).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, e)
        })
    }

    /// Schema version.
    pub fn schema_version(&self) -> u64 {
        SCHEMA_VERSION
    }

    /// Record an observation, appending it to the journal and compacting if needed.
    pub fn record_observation(&mut self, obs: Observation) {
        self.observations.push(obs);
        if self.observations.len() > MAX_OBSERVATIONS {
            let drop = self.observations.len() - MAX_OBSERVATIONS;
            self.observations.drain(0..drop);
        }
        // O(1) append on the normal path. If the append fails (missing file,
        // permissions), fall back to a full rewrite so the record is not lost.
        if self.append_observation().is_err() {
            let _ = self.persist_observations();
            self.appends_since_compaction = 0;
            return;
        }
        self.appends_since_compaction += 1;
        if self.observations.len() >= MAX_OBSERVATIONS && self.appends_since_compaction >= COMPACT_EVERY {
            let _ = self.persist_observations();
            self.appends_since_compaction = 0;
        }
    }

    /// Append one observation to the journal without rewriting it.
    fn append_observation(&self) -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.observations_path)?;
        let line = serde_json::to_string(self.observations.last().expect("just pushed"))
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        writeln!(file, "{line}")?;
        file.flush()
    }

    /// Persist the observation journal to disk (rewrite whole file atomically).
    fn persist_observations(&self) -> std::io::Result<()> {
        let tmp = self.observations_path.with_extension("jsonl.tmp");
        let file = fs::File::create(&tmp)?;
        let mut writer = std::io::BufWriter::new(file);
        for obs in &self.observations {
            let line = serde_json::to_string(obs)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
            writeln!(writer, "{line}")?;
        }
        writer.flush()?;
        drop(writer);
        fs::rename(&tmp, &self.observations_path)?;
        Ok(())
    }

    /// User-initiated reset: clear observations and model state, then rewrite
    /// the (now empty) store atomically. Returns the number of observations
    /// removed. A missing/corrupt store is reported as an I/O error only when
    /// the directory itself cannot be written.
    pub fn reset(&mut self) -> std::io::Result<usize> {
        let removed = self.observations.len();
        self.observations.clear();
        self.model = ModelState::default();
        self.appends_since_compaction = 0;
        self.persist_observations()?;
        self.persist_model_state()?;
        Ok(removed)
    }

    /// Alias for [`reset`] for callers that prefer clear semantics.
    pub fn clear(&mut self) -> std::io::Result<usize> {
        self.reset()
    }

    /// All retained observations (oldest first).
    pub fn observations(&self) -> Vec<Observation> {
        self.observations.clone()
    }

    /// Record one real calibration outcome: the confidence the engine held, and
    /// whether the next probe kept the same hypothesis leading.
    ///
    /// Malformed values are refused rather than clamped: a confidence outside
    /// `[0, 1]` or a label that is not 0/1 would distort the fitted map, and a
    /// sample that never happened is not something to repair.
    pub fn record_calibration_sample(&mut self, predicted: f64, confirmed: f64) {
        let valid_label = confirmed == 0.0 || confirmed == 1.0;
        if !predicted.is_finite() || !(0.0..=1.0).contains(&predicted) || !valid_label {
            return;
        }
        self.model.calibration_samples.push((predicted, confirmed));
        let len = self.model.calibration_samples.len();
        if len > MAX_CALIBRATION_SAMPLES {
            self.model
                .calibration_samples
                .drain(0..len - MAX_CALIBRATION_SAMPLES);
        }
        let _ = self.persist_model_state();
    }

    /// Recorded calibration outcomes, oldest first.
    pub fn calibration_samples(&self) -> &[(f64, f64)] {
        &self.model.calibration_samples
    }

    /// Current model state.
    pub fn model_state(&self) -> ModelState {
        self.model.clone()
    }

    /// Replace the model state and persist it atomically.
    pub fn set_model_state(&mut self, model: ModelState) {
        self.model = model;
        let _ = self.persist_model_state();
    }

    /// Persist model state atomically (write temp, then rename).
    fn persist_model_state(&self) -> std::io::Result<()> {
        let tmp = self.model_state_path.with_extension("json.tmp");
        let data = serde_json::to_string_pretty(&self.model)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        fs::write(&tmp, data)?;
        fs::rename(&tmp, &self.model_state_path)?;
        Ok(())
    }
}

impl Default for PersistenceStore {
    fn default() -> Self {
        Self {
            dir: PathBuf::new(),
            observations_path: PathBuf::new(),
            model_state_path: PathBuf::new(),
            version_path: PathBuf::new(),
            observations: Vec::new(),
            model: ModelState::default(),
            appends_since_compaction: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique directory per test: the tests run in parallel, and a shared path
    /// let one test delete another's store mid-flight.
    fn test_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("nani-test-{}-{}", std::process::id(), name))
    }

    #[test]
    fn record_and_retrieve_observation() {
        let dir = test_dir("observation");
        let _ = std::fs::remove_dir_all(&dir);
        let mut store = PersistenceStore::new(&dir).expect("open store");
        store.record_observation(Observation {
            api_id: "api-1".into(),
            timestamp_ms: 1000,
            category: "Healthy".into(),
            success: true,
            latency_ms: Some(40.0),
        });
        let obs = store.observations();
        assert_eq!(obs.len(), 1);
        assert_eq!(obs[0].api_id, "api-1");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn schema_version_is_one() {
        let dir = test_dir("schema");
        let _ = std::fs::remove_dir_all(&dir);
        let store = PersistenceStore::new(&dir).expect("open store");
        assert_eq!(store.schema_version(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn model_state_round_trips() {
        let dir = test_dir("model");
        let _ = std::fs::remove_dir_all(&dir);
        let mut store = PersistenceStore::new(&dir).expect("open store");
        let mut m = ModelState::default();
        m.bandit.insert("api-1".into(), 0.75);
        store.set_model_state(m.clone());
        assert_eq!(store.model_state().bandit["api-1"], 0.75);

        // Re-open to confirm persistence across instances.
        let store2 = PersistenceStore::new(&dir).expect("reopen store");
        assert_eq!(store2.model_state().bandit["api-1"], 0.75);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn retention_bounds_observations() {
        let dir = test_dir("retention");
        let _ = std::fs::remove_dir_all(&dir);
        let mut store = PersistenceStore::new(&dir).expect("open store");
        for i in 0..(MAX_OBSERVATIONS + 100) {
            store.record_observation(Observation {
                api_id: "api-1".into(),
                timestamp_ms: i as u64,
                category: "Healthy".into(),
                success: true,
                latency_ms: None,
            });
        }
        let obs = store.observations();
        assert_eq!(obs.len(), MAX_OBSERVATIONS);
        // Most recent retained.
        assert_eq!(obs.last().unwrap().timestamp_ms, (MAX_OBSERVATIONS + 99) as u64);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reset_clears_persisted_store() {
        let dir = test_dir("reset");
        let _ = std::fs::remove_dir_all(&dir);
        let mut store = PersistenceStore::new(&dir).expect("open store");
        store.record_observation(Observation {
            api_id: "api-1".into(),
            timestamp_ms: 1000,
            category: "Healthy".into(),
            success: true,
            latency_ms: Some(40.0),
        });
        assert_eq!(store.reset().expect("reset"), 1);
        assert!(store.observations().is_empty());
        let reopened = PersistenceStore::new(&dir).expect("reopen store");
        assert!(reopened.observations().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn calibration_samples_persist_and_are_bounded() {
        let dir = std::env::temp_dir().join(format!("nani-calib-samples-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut store = PersistenceStore::new(&dir).expect("open store");

        // Malformed pairs are refused rather than clamped into the journal.
        store.record_calibration_sample(f64::NAN, 1.0);
        store.record_calibration_sample(0.5, 0.5);
        store.record_calibration_sample(1.5, 0.0);
        store.record_calibration_sample(-0.1, 1.0);
        assert!(store.calibration_samples().is_empty(), "malformed samples accepted");

        let total = MAX_CALIBRATION_SAMPLES + 5;
        for i in 0..total {
            let predicted = (i % 10) as f64 / 10.0;
            let confirmed = if i % 2 == 0 { 1.0 } else { 0.0 };
            store.record_calibration_sample(predicted, confirmed);
        }
        assert_eq!(store.calibration_samples().len(), MAX_CALIBRATION_SAMPLES);
        // Oldest evicted, newest retained.
        let last = total - 1;
        assert_eq!(
            store.calibration_samples().last().copied(),
            Some(((last % 10) as f64 / 10.0, if last % 2 == 0 { 1.0 } else { 0.0 }))
        );

        // Survives a restart and is what the calibrator will be fitted on.
        let reopened = PersistenceStore::new(&dir).expect("reopen store");
        assert_eq!(reopened.calibration_samples(), store.calibration_samples());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn default_store_has_zero_observations() {
        let store = PersistenceStore::default();
        assert!(store.observations().is_empty());
        assert_eq!(store.schema_version(), 1);
    }
}
