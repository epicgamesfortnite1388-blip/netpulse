//! Deterministic, evidence-grounded explanation layer.
//!
//! The mathematical engine produces the facts. This module renders them in a
//! fixed structure — Observed / Inferred / Confidence / Next step — and only
//! then asks the optional local model to rewrite that text. The deterministic
//! answer is always available and is returned unchanged when the model is
//! unavailable or its output is unusable.

use serde::Serialize;

use super::local_runtime::LocalLlm;

/// Structured input to the explanation layer. Every field is produced by
/// deterministic code; none is model-generated.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ExplanationFacts {
    pub question: String,
    /// What was actually measured, in short sanitized lines.
    pub observed: Vec<String>,
    /// What NANI infers from those measurements.
    pub inferred: Vec<String>,
    /// MAP probability or another explicit confidence value, when available.
    pub confidence: Option<f64>,
    /// The single useful next diagnostic action, if there is one.
    pub next_step: String,
}

/// Result returned to the UI. `narrative` is optional prose from the local
/// model; `deterministic` is always present and is the authoritative text.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Explanation {
    pub deterministic: String,
    pub narrative: Option<String>,
    pub source: &'static str,
    pub grounded: bool,
    pub warning: Option<String>,
}

fn confidence_text(confidence: Option<f64>) -> String {
    match confidence {
        Some(p) if p.is_finite() => {
            let pct = (p.clamp(0.0, 1.0) * 100.0).round();
            format!("{pct}% (posterior probability of the leading hypothesis; not a guarantee)")
        }
        _ => "not estimated from the available evidence".to_string(),
    }
}

/// Build the canonical deterministic explanation.
pub fn deterministic(facts: &ExplanationFacts) -> String {
    let observed = if facts.observed.is_empty() {
        "- no verified measurements are available yet".to_string()
    } else {
        facts
            .observed
            .iter()
            .map(|line| format!("- {line}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let inferred = if facts.inferred.is_empty() {
        "- NANI has not formed a diagnosis from the current evidence".to_string()
    } else {
        facts
            .inferred
            .iter()
            .map(|line| format!("- {line}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!(
        "Observed:\n{observed}\n\nInferred:\n{inferred}\n\nConfidence:\n- {}\n\nNext step:\n- {}",
        confidence_text(facts.confidence),
        facts.next_step
    )
}

/// Prompt sent to the local model. It contains only structured facts, never raw
/// logs, packet data, credentials, or configuration text.
pub fn prompt(facts: &ExplanationFacts) -> String {
    format!(
        "You are a language layer for a network diagnostic engine. Rewrite the structured facts below as a short, clear explanation for a non-expert. \
Rules: do not invent measurements, probabilities, causes, or actions; do not recommend bypassing restrictions or changing system settings; \
do not claim recovery succeeded; keep the four sections Observed, Inferred, Confidence and Next step; answer in at most 180 words.\n\n\
STRUCTURED NANI FACTS\nQuestion: {}\nObserved:\n{}\nInferred:\n{}\nConfidence: {}\nNext step: {}\n",
        facts.question,
        facts
            .observed
            .iter()
            .map(|l| format!("- {l}"))
            .collect::<Vec<_>>()
            .join("\n"),
        facts
            .inferred
            .iter()
            .map(|l| format!("- {l}"))
            .collect::<Vec<_>>()
            .join("\n"),
        confidence_text(facts.confidence),
        facts.next_step
    )
}

/// Explain the facts, using the local model only when it is available.
pub fn explain(llm: &LocalLlm, facts: &ExplanationFacts) -> Explanation {
    let deterministic = deterministic(facts);
    if !llm.available() {
        return Explanation {
            deterministic,
            narrative: None,
            source: "deterministic",
            grounded: true,
            warning: None,
        };
    }
    match llm.generate(&prompt(facts)) {
        Ok(text) => Explanation {
            deterministic,
            narrative: Some(text),
            source: "local_model",
            grounded: true,
            warning: None,
        },
        Err(err) => Explanation {
            deterministic,
            narrative: None,
            source: "deterministic",
            grounded: true,
            warning: Some(err),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> ExplanationFacts {
        ExplanationFacts {
            question: "Why is the API slow?".into(),
            observed: vec!["api-a: healthy, 140 ms".into()],
            inferred: vec!["NANI sees 1/1 monitored APIs healthy".into()],
            confidence: Some(0.72),
            next_step: "Run one more latency probe to separate a transient spike from drift.".into(),
        }
    }

    #[test]
    fn deterministic_output_always_has_the_four_sections() {
        let text = deterministic(&facts());
        for section in ["Observed:", "Inferred:", "Confidence:", "Next step:"] {
            assert!(text.contains(section), "missing {section}: {text}");
        }
        assert!(text.contains("72%"));
    }

    #[test]
    fn model_off_returns_grounded_deterministic_text() {
        let llm = LocalLlm::default();
        let out = explain(&llm, &facts());
        assert_eq!(out.source, "deterministic");
        assert!(out.narrative.is_none());
        assert!(out.grounded);
        assert_eq!(out.deterministic, deterministic(&facts()));
    }

    #[test]
    fn prompt_contains_no_raw_payload_contract() {
        let p = prompt(&facts());
        assert!(p.contains("STRUCTURED NANI FACTS"));
        assert!(p.contains("do not invent measurements"));
    }
}
