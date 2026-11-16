//! NANI Layer B — optional local language model.
//!
//! This layer never decides technical truth. It receives a structured summary
//! produced by the deterministic mathematical engine and may rewrite that
//! summary into prose. It cannot add measurements, change a diagnosis, select
//! a recovery action, or execute anything.
//!
//! The runtime is disabled unless the user explicitly configures a local
//! llama.cpp-compatible executable and a local GGUF model:
//!
//! ```text
//! NANI_LLM_ENABLED=1
//! NANI_LLM_BINARY=C:\path\to\llama-cli.exe
//! NANI_LLM_MODEL=C:\path\to\model.gguf
//! NANI_LLM_TIMEOUT_MS=20000      # optional, 1000..120000
//! NANI_LLM_MAX_TOKENS=256        # optional, 64..512
//! ```
//!
//! No cloud AI endpoint is consulted. When the model is absent, disabled,
//! slow, or produces unusable text, the deterministic explanation is returned
//! unchanged.

pub mod explanation;
pub mod local_runtime;

pub use explanation::{Explanation, ExplanationFacts};
pub use local_runtime::{AiStatus, LocalLlm, LocalLlmConfig};
