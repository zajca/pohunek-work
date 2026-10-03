//! Helpers shared by the integration tests that drive real pohunek binaries.
//!
//! The binaries come from a pinned core revision and are located through
//! environment variables, never through a build of the core workspace: CI
//! installs them from the revision pinned in `native/Cargo.toml`
//! (`scripts/build-core-binaries`), and a developer exports the same variables
//! by hand.

// Rust guideline compliant 2026-10-03
#![allow(
    dead_code,
    reason = "each test binary that includes this module uses a subset of the helpers"
)]

use std::path::PathBuf;

/// Environment variable naming the `pohunekd` daemon binary.
pub(crate) const DAEMON_BIN_VAR: &str = "POHUNEK_DAEMON_BIN";
/// Environment variable naming the `pohunek-sessiond` session worker binary.
pub(crate) const WORKER_BIN_VAR: &str = "POHUNEK_WORKER_BIN";
/// Environment variable naming the `pohunek` CLI binary.
pub(crate) const CLI_BIN_VAR: &str = "POHUNEK_CLI_BIN";

/// Returns the binary named by `var`.
///
/// # Panics
///
/// Panics with setup instructions when the variable is unset or does not name an
/// existing file; a test never falls back to another binary.
#[must_use]
pub(crate) fn required_binary(var: &str, name: &str) -> PathBuf {
    let value = std::env::var_os(var).unwrap_or_else(|| {
        panic!(
            "{var} is not set; export it as the absolute path of the pinned core `{name}` \
             binary (scripts/build-core-binaries builds it)"
        )
    });
    let path = PathBuf::from(value);
    assert!(
        path.is_absolute() && path.is_file(),
        "{var}={} is not an existing absolute file path to `{name}`",
        path.display()
    );
    path
}
