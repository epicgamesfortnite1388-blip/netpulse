//! Local llama.cpp-compatible inference process.
//!
//! Security and resource properties:
//!   - no shell: the executable is spawned directly with an argument vector;
//!   - no network client is created here, and the model path must be local;
//!   - output is capped and validated before it can reach the UI;
//!   - a hard wall-clock timeout kills the child process;
//!   - the process is spawned per request, so an unused model holds no RAM.
//!
//! This is deliberately not a general-purpose "run a command" surface. The
//! only configurable executable is a local LLM CLI, and the only argument the
//! caller controls is the prompt.

use serde::Serialize;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const DEFAULT_TIMEOUT_MS: u64 = 20_000;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 120_000;
const DEFAULT_MAX_TOKENS: u32 = 256;
const MIN_MAX_TOKENS: u32 = 64;
const MAX_MAX_TOKENS: u32 = 512;
const MAX_OUTPUT_CHARS: usize = 4_000;
const MAX_OUTPUT_BYTES: u64 = 256 * 1024;

/// Runtime configuration, read once at startup from the environment.
#[derive(Debug, Clone)]
pub struct LocalLlmConfig {
    pub enabled: bool,
    pub binary: Option<PathBuf>,
    pub model: Option<PathBuf>,
    pub timeout: Duration,
    pub max_tokens: u32,
}

impl Default for LocalLlmConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            binary: None,
            model: None,
            timeout: Duration::from_millis(DEFAULT_TIMEOUT_MS),
            max_tokens: DEFAULT_MAX_TOKENS,
        }
    }
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

fn parse_bool(value: Option<String>) -> bool {
    matches!(
        value.as_deref().map(str::trim).map(str::to_ascii_lowercase).as_deref(),
        Some("1") | Some("true") | Some("yes") | Some("on")
    )
}

impl LocalLlmConfig {
    /// Read `NANI_LLM_*` from the environment. Defaults are always safe:
    /// disabled, no executable, no model.
    pub fn from_env() -> Self {
        let enabled = parse_bool(std::env::var("NANI_LLM_ENABLED").ok());
        let timeout_ms = std::env::var("NANI_LLM_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
        let max_tokens = std::env::var("NANI_LLM_MAX_TOKENS")
            .ok()
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(DEFAULT_MAX_TOKENS)
            .clamp(MIN_MAX_TOKENS, MAX_MAX_TOKENS);
        Self {
            enabled,
            binary: env_path("NANI_LLM_BINARY"),
            model: env_path("NANI_LLM_MODEL"),
            timeout: Duration::from_millis(timeout_ms),
            max_tokens,
        }
    }

    fn usable_binary(&self) -> Option<&PathBuf> {
        self.binary.as_ref().filter(|p| p.is_file())
    }

    fn usable_model(&self) -> Option<&PathBuf> {
        self.model.as_ref().filter(|p| p.is_file())
    }
}

/// Status exposed to the UI. Never contains file contents or secrets.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AiStatus {
    pub enabled: bool,
    pub available: bool,
    pub runtime: &'static str,
    pub binary_configured: bool,
    pub model_configured: bool,
    pub model_name: Option<String>,
    pub timeout_ms: u64,
    pub max_tokens: u32,
    pub message: String,
}

/// The optional local model process.
#[derive(Debug, Clone)]
pub struct LocalLlm {
    config: LocalLlmConfig,
}

impl Default for LocalLlm {
    fn default() -> Self {
        Self::new(LocalLlmConfig::default())
    }
}

impl LocalLlm {
    pub fn new(config: LocalLlmConfig) -> Self {
        Self { config }
    }

    pub fn from_env() -> Self {
        Self::new(LocalLlmConfig::from_env())
    }

    pub fn config(&self) -> &LocalLlmConfig {
        &self.config
    }

    pub fn available(&self) -> bool {
        self.config.enabled
            && self.config.usable_binary().is_some()
            && self.config.usable_model().is_some()
    }

    pub fn status(&self) -> AiStatus {
        let binary_ok = self.config.usable_binary().is_some();
        let model_ok = self.config.usable_model().is_some();
        let available = self.available();
        let message = if !self.config.enabled {
            "Local language model is disabled. NANI mathematical diagnostics are active.".into()
        } else if !binary_ok {
            "Local language model is enabled but the runtime executable was not found.".into()
        } else if !model_ok {
            "Local language model is enabled but the model file was not found.".into()
        } else {
            "Local language model is ready; answers are explanations of deterministic NANI results."
                .into()
        };
        AiStatus {
            enabled: self.config.enabled,
            available,
            runtime: "llama.cpp-compatible",
            binary_configured: binary_ok,
            model_configured: model_ok,
            model_name: self
                .config
                .model
                .as_ref()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().into_owned()),
            timeout_ms: self.config.timeout.as_millis() as u64,
            max_tokens: self.config.max_tokens,
            message,
        }
    }

    /// Generate text from a prompt. The prompt is supplied by the deterministic
    /// explanation layer, never directly by a webview caller.
    pub fn generate(&self, prompt: &str) -> Result<String, String> {
        if !self.config.enabled {
            return Err("local language model is disabled".into());
        }
        let binary = self
            .config
            .usable_binary()
            .ok_or_else(|| "local language model executable not found".to_string())?;
        let model = self
            .config
            .usable_model()
            .ok_or_else(|| "local language model file not found".to_string())?;
        if prompt.trim().is_empty() {
            return Err("empty prompt".into());
        }

        let mut child = Command::new(binary)
            .arg("-m")
            .arg(model)
            .arg("-p")
            .arg(prompt)
            .arg("-n")
            .arg(self.config.max_tokens.to_string())
            .arg("--temp")
            .arg("0.2")
            .arg("--top-p")
            .arg("0.9")
            .arg("--no-display-prompt")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("could not start local language model: {e}"))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "local language model produced no stdout pipe".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "local language model produced no stderr pipe".to_string())?;

        let (tx, rx) = mpsc::channel::<String>();
        std::thread::spawn(move || {
            let mut out = String::new();
            let mut limited = stdout.take(MAX_OUTPUT_BYTES);
            let _ = limited.read_to_string(&mut out);
            let _ = tx.send(out);
        });
        let err_handle = std::thread::spawn(move || {
            let mut err = String::new();
            let mut limited = stderr.take(64 * 1024);
            let _ = limited.read_to_string(&mut err);
            err
        });

        let deadline = Instant::now() + self.config.timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = err_handle.join();
                    return Err("local language model timed out".into());
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                Err(e) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = err_handle.join();
                    return Err(format!("local language model wait failed: {e}"));
                }
            }
        };

        let raw = rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
        let err = err_handle.join().unwrap_or_default();
        if !status.success() {
            let detail = err.trim();
            return Err(if detail.is_empty() {
                "local language model exited with an error".into()
            } else {
                format!("local language model exited with an error: {}", truncate(detail, 300))
            });
        }

        sanitize_output(&raw)
    }
}

fn truncate(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

/// Reject output that is empty, prompt echo, or contains control characters.
fn sanitize_output(raw: &str) -> Result<String, String> {
    let cleaned: String = raw
        .chars()
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return Err("local language model returned an empty answer".into());
    }
    if trimmed.contains("STRUCTURED NANI FACTS") {
        return Err("local language model echoed the prompt instead of answering".into());
    }
    Ok(truncate(trimmed, MAX_OUTPUT_CHARS))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_disabled_and_has_no_paths() {
        let llm = LocalLlm::default();
        let status = llm.status();
        assert!(!status.enabled);
        assert!(!status.available);
        assert!(!status.binary_configured);
        assert!(!status.model_configured);
        assert!(llm.generate("hello").is_err());
    }

    #[test]
    fn enabled_without_files_is_not_available() {
        let cfg = LocalLlmConfig {
            enabled: true,
            binary: Some(PathBuf::from("Z:\\does-not-exist\\llama-cli.exe")),
            model: Some(PathBuf::from("Z:\\does-not-exist\\model.gguf")),
            ..Default::default()
        };
        let status = LocalLlm::new(cfg).status();
        assert!(status.enabled);
        assert!(!status.available);
        assert!(!status.binary_configured);
        assert!(!status.model_configured);
    }

    #[test]
    fn output_validation_rejects_empty_and_prompt_echo() {
        assert!(sanitize_output("   \n ").is_err());
        assert!(sanitize_output("STRUCTURED NANI FACTS: ...").is_err());
        assert_eq!(sanitize_output("  A grounded answer.  ").unwrap(), "A grounded answer.");
    }

    #[test]
    fn bool_parsing_is_conservative() {
        assert!(parse_bool(Some("1".into())));
        assert!(parse_bool(Some("yes".into())));
        assert!(!parse_bool(Some("0".into())));
        assert!(!parse_bool(None));
    }
}
