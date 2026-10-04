//! Loopback port reservation for the sidecar.
//!
//! Two questions only: "give me a free port" and "can WE still take this
//! one?". They are separate from supervision because the answers are pure OS
//! questions with no process attached, and because the sidecar re-checks its
//! own reservation between picking and binding — bind-and-release is
//! inherently racy, so the check has to be callable at two different moments
//! in the spawn sequence.

/// Ask the OS for a free loopback port (bind to 127.0.0.1:0, read it, drop).
pub(crate) fn reserve_ephemeral_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .map(|l| l.local_addr().map(|a| a.port()).unwrap_or(0))
        .unwrap_or(0)
}

/// True when WE can still bind the port (a stolen reserved port would make
/// the sidecar die with EADDRINUSE before printing anything useful).
pub(crate) fn port_bindable(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}
