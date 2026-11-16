//! NANI Phase 4B — crash-safe local profile storage.
//!
//! One versioned JSON document holds context metadata, robust baselines, the
//! hierarchical posterior, and bounded transition history. Writes go to a
//! temporary file and are renamed over the target so a crash cannot leave a
//! half-written profile. Invalid/corrupt records are reported, not silently
//! accepted as valid evidence.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::network_intelligence::context::engine::{
    NetworkProfileEngine, ProfileEngineSnapshot, PROFILE_SCHEMA_VERSION,
};

pub const PROFILE_FILE_NAME: &str = "network_profiles.json";
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProfileEnvelope {
    schema_version: u32,
    engine: ProfileEngineSnapshot,
}

#[derive(Debug, Clone)]
pub enum ProfileStorageError {
    Io(String),
    Corrupt(String),
    UnsupportedVersion(u32),
}

impl std::fmt::Display for ProfileStorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "profile storage I/O error: {e}"),
            Self::Corrupt(e) => write!(f, "profile storage is corrupt: {e}"),
            Self::UnsupportedVersion(v) => write!(f, "unsupported profile schema version {v}"),
        }
    }
}

impl std::error::Error for ProfileStorageError {}

/// Profile path inside the app data directory.
pub fn profile_path(data_dir: &Path) -> PathBuf {
    data_dir.join("nani").join(PROFILE_FILE_NAME)
}

/// Load a profile engine. A missing file is not an error (`Ok(None)`).
pub fn load_engine(path: &Path) -> Result<Option<NetworkProfileEngine>, ProfileStorageError> {
    if !path.exists() {
        return Ok(None);
    }
    let meta = fs::metadata(path).map_err(|e| ProfileStorageError::Io(e.to_string()))?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(ProfileStorageError::Corrupt(format!(
            "file exceeds {MAX_FILE_BYTES} bytes"
        )));
    }
    let data = fs::read_to_string(path).map_err(|e| ProfileStorageError::Io(e.to_string()))?;
    let value: serde_json::Value = serde_json::from_str(&data)
        .map_err(|e| ProfileStorageError::Corrupt(e.to_string()))?;
    let version = value
        .get("schema_version")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| ProfileStorageError::Corrupt("missing schema_version".into()))?
        as u32;
    if version != PROFILE_SCHEMA_VERSION {
        return Err(ProfileStorageError::UnsupportedVersion(version));
    }
    let envelope: ProfileEnvelope = serde_json::from_value(value)
        .map_err(|e| ProfileStorageError::Corrupt(e.to_string()))?;
    NetworkProfileEngine::from_snapshot(envelope.engine)
        .map(Some)
        .ok_or_else(|| ProfileStorageError::Corrupt("invalid model parameters".into()))
}

/// Atomically save an engine snapshot.
pub fn save_engine(
    path: &Path,
    engine: &NetworkProfileEngine,
) -> Result<(), ProfileStorageError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| ProfileStorageError::Io(e.to_string()))?;
    }
    let envelope = ProfileEnvelope {
        schema_version: PROFILE_SCHEMA_VERSION,
        engine: engine.snapshot(),
    };
    let json = serde_json::to_vec_pretty(&envelope)
        .map_err(|e| ProfileStorageError::Corrupt(e.to_string()))?;
    if json.len() as u64 > MAX_FILE_BYTES {
        return Err(ProfileStorageError::Corrupt("snapshot exceeds size cap".into()));
    }
    let tmp = path.with_extension("json.tmp");
    let mut file = fs::File::create(&tmp).map_err(|e| ProfileStorageError::Io(e.to_string()))?;
    file.write_all(&json)
        .map_err(|e| ProfileStorageError::Io(e.to_string()))?;
    file.sync_all()
        .map_err(|e| ProfileStorageError::Io(e.to_string()))?;
    drop(file);
    fs::rename(&tmp, path).map_err(|e| ProfileStorageError::Io(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network_intelligence::context::context_identity::ContextSignals;

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nani-profile-test-{}-{name}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        dir.join(PROFILE_FILE_NAME)
    }

    #[test]
    fn missing_file_is_none() {
        let path = temp_path("missing");
        assert!(load_engine(&path).expect("missing is not an error").is_none());
    }

    #[test]
    fn save_and_load_round_trip() {
        let path = temp_path("roundtrip");
        let mut engine = NetworkProfileEngine::new();
        engine.observe_signals(&ContextSignals {
            is_wifi: true,
            gateway_class: Some("home".into()),
            ..Default::default()
        });
        engine.record_metric("latency_ms", 20.0, 100);
        engine.observe_outcome("api", Some(true));
        save_engine(&path, &engine).expect("save");
        let loaded = load_engine(&path).expect("load").expect("present");
        assert_eq!(loaded.status().contexts, 1);
        assert!((loaded.reliability("api") - engine.reliability("api")).abs() < 1e-12);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn corrupt_json_is_reported_not_accepted() {
        let path = temp_path("corrupt");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{not-json").unwrap();
        assert!(matches!(load_engine(&path), Err(ProfileStorageError::Corrupt(_))));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn unsupported_version_is_rejected() {
        let path = temp_path("version");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, br#"{"schema_version":99,"engine":{}}"#).unwrap();
        assert!(matches!(
            load_engine(&path),
            Err(ProfileStorageError::UnsupportedVersion(99))
        ));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}
