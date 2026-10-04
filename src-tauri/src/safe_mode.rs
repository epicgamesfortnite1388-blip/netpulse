//! Safe Mode — the single owner of one boolean.
//!
//! Safe Mode is requested with `--safe-mode`/`-s` on the command line (e.g.
//! from a Start Menu shortcut copy). It is consumed BEFORE the first window
//! exists, which means the argument list can only be parsed once, at startup:
//! the result is stored in managed state and every later reader asks this
//! module. (The runtime-status command used to re-parse `argv` independently,
//! leaving two sources of truth for the same flag.)
//!
//! The failure this module exists to prevent is quiet: a parse that misreads
//! the flag launches someone who asked for a clean recovery into the very
//! session Safe Mode was meant to escape, and nothing about that looks wrong.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};

use crate::logging::log_info;

/// Managed flag so the IPC command can answer without touching `argv` again.
pub struct SafeModeState(AtomicBool);

impl SafeModeState {
    pub fn new() -> Self {
        Self::from_flag(from_args())
    }

    /// Build from an already-parsed value.
    ///
    /// Split out so the ONE function that turns an argument list into a
    /// boolean — `parse` — is reachable from a test without relaunching the
    /// process, and so `announce_to_sidecar` can be handed the same value
    /// the rest of the app reports instead of reading `argv` a second time.
    pub(crate) fn from_flag(on: bool) -> Self {
        SafeModeState(AtomicBool::new(on))
    }

    pub fn active(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

impl Default for SafeModeState {
    fn default() -> Self {
        Self::new()
    }
}

/// The flag exactly as written on the command line.
///
/// Matching is whole-argument and exact, which is the safe direction to
/// refuse in: `--safe-mode=1`, `--safe-mode2` and `--SAFE-MODE` are typos, and
/// silently treating a typo as "launch the recovery session" — or, worse,
/// treating a user's real flag as a typo — would both be wrong in the
/// direction that matters. Only `SafeModeState::new` may call this; every
/// other reader goes through `is_active`.
fn parse<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .any(|a| matches!(a.as_ref(), "--safe-mode" | "-s"))
}

fn from_args() -> bool {
    parse(std::env::args())
}

/// Is this launch a Safe Mode launch?
///
/// Falls back to `argv` only when the managed state is missing. That is a
/// deliberate fail-safe rather than a second source of truth: with no state to
/// ask, an unknown answer must lean towards Safe Mode, because guessing "off"
/// drops a user into the broken session they launched Safe Mode to escape.
pub fn is_active(app: &AppHandle) -> bool {
    app.try_state::<SafeModeState>()
        .map(|s| s.active())
        .unwrap_or_else(from_args)
}

/// Tell the sidecar to start with its network stack disabled (null controller)
/// so a wedged networking config cannot stop the user from reaching Settings.
///
/// Takes the already-parsed value and returns it unchanged. This used to call
/// `from_args()` itself, which made the flag two sources of truth again — the
/// exact bug this module was split out of `main.rs` to remove — and the
/// announcement is the one value the backend actually acts on, so it has to be
/// the same value everything else reports.
pub fn announce_to_sidecar(on: bool) -> bool {
    if on {
        std::env::set_var("NETPULSE_SAFE_MODE", "1");
        log_info!("SAFE MODE requested: network stack disabled for this launch");
    }
    on
}

#[tauri::command]
pub fn netpulse_safe_mode(state: tauri::State<'_, SafeModeState>) -> bool {
    state.active()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
//
// Parsing is tested through `parse`, the single function that turns an
// argument list into the boolean. Launching the app with a flag would need a
// second process and could only assert on the outcome; `parse` is where every
// decision about what counts as the flag actually lives.

#[cfg(test)]
mod tests {
    use super::*;

    fn flags(args: &[&str]) -> bool {
        parse(args.iter().copied())
    }

    const EXE: &str = "netpulse-desktop.exe";

    #[test]
    fn the_long_and_short_flags_both_enable_safe_mode() {
        assert!(flags(&[EXE, "--safe-mode"]), "--safe-mode");
        assert!(flags(&[EXE, "-s"]), "-s");
    }

    #[test]
    fn a_launch_without_the_flag_is_not_a_safe_mode_launch() {
        assert!(!flags(&[EXE]), "a bare launch");
        assert!(!flags(&[EXE, "--safe-mode-off"]), "an unrelated flag");
    }

    #[test]
    fn near_miss_spellings_are_refused_rather_than_guessed() {
        // Each of these is a way for a user to ask for Safe Mode and not get
        // it (or for a typo to be read as consent for anything). None of them
        // is the flag.
        for arg in [
            "--safe-mode=1",
            "--safe-mode=true",
            "--safe-mode2",
            "--safe_mode",
            "-safe-mode",
            "--safe",
            "-S",
            "--SAFE-MODE",
            "safe-mode",
            "--",
            "-s=true",
            " --safe-mode",
            "--safe-mode ",
            "",
        ] {
            assert!(
                !flags(&[EXE, arg]),
                "{arg:?} is not the flag and must not be read as one"
            );
        }
    }

    #[test]
    fn the_flag_is_found_in_any_position_and_repeating_it_changes_nothing() {
        assert!(
            flags(&[EXE, "--verbose", "--safe-mode", "--other"]),
            "position must not matter"
        );
        assert!(
            flags(&[EXE, "--safe-mode", "-s", "--safe-mode"]),
            "a repeated flag is still one boolean, not two launches"
        );
    }

    #[test]
    fn an_empty_argument_list_is_not_safe_mode() {
        assert!(!parse(Vec::<String>::new()));
        assert!(!parse(std::iter::empty::<&str>()));
    }

    #[test]
    fn this_test_binary_was_not_launched_with_the_flag() {
        // The real `from_args` path, on a process that genuinely has no flag.
        // Guards against a `parse` that matches everything.
        assert!(!from_args(), "cargo test does not pass --safe-mode");
    }

    #[test]
    fn safe_mode_state_reports_the_value_it_was_built_from() {
        assert!(SafeModeState::from_flag(true).active());
        assert!(!SafeModeState::from_flag(false).active());
    }

    #[test]
    fn announcing_passes_the_parsed_value_through_untouched() {
        // Not "is this on" re-derived: the value announced must BE the one
        // that was parsed, so the backend can never be told something the
        // rest of the app disagrees with.
        assert!(announce_to_sidecar(true), "a parsed-true launch announces true");
        assert!(
            !announce_to_sidecar(false),
            "a parsed-false launch announces false"
        );
    }

    #[test]
    fn announcing_only_reaches_the_backend_when_safe_mode_is_on() {
        const VAR: &str = "NETPULSE_SAFE_MODE";
        std::env::remove_var(VAR);

        announce_to_sidecar(false);
        assert!(
            std::env::var_os(VAR).is_none(),
            "a normal launch must not tell the backend to disable networking"
        );

        announce_to_sidecar(true);
        assert_eq!(std::env::var(VAR).as_deref(), Ok("1"));

        // Leave the process as we found it.
        std::env::remove_var(VAR);
    }
}