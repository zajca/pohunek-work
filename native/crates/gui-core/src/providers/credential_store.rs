//! Credential-store lookup behind [`KeyringTokenSource`](super::linear::KeyringTokenSource).
//!
//! One lookup reads one entry from the platform store (macOS Keychain, Linux
//! Secret Service) on a blocking thread. Failures are classified into
//! [`TokenErrorKind`] with fixed, remediation-bearing messages: the token value
//! never reaches an error, and only the entry name (a reference) does.
//!
//! A `get_password` call may block for as long as the platform waits on an
//! unlock prompt, and it cannot be cancelled. The caller's timeout stops the
//! wait but not the blocking thread. A locked keychain blocks every entry, so
//! the whole store has one lookup in flight at most. Further lookups wait for
//! a permit asynchronously: a waiter holds no blocking-pool thread, honors the
//! caller's timeout, and proceeds once the running lookup returns. A lookup
//! stuck on an unlock prompt keeps the permit, so later lookups of the process
//! time out until it ends.

// Rust guideline compliant 2026-10-01

use std::sync::{Arc, OnceLock};

use tokio::sync::Semaphore;
use tokio::task::JoinError;

use super::linear::{TokenError, TokenErrorKind};

/// `errSecInteractionNotAllowed` in `SecBase.h`: the keychain is locked and no
/// unlock UI may be shown.
const ERR_SEC_INTERACTION_NOT_ALLOWED: i32 = -25308;

/// `errSecUserCanceled` in `SecBase.h`: the user dismissed the unlock prompt.
const ERR_SEC_USER_CANCELED: i32 = -128;

/// `errSecAuthFailed` in `SecBase.h`: the store refused access to the entry.
const ERR_SEC_AUTH_FAILED: i32 = -25293;

/// Kind a Keychain status code stands for, `None` when it has no dedicated
/// meaning.
fn status_kind(code: i32) -> Option<TokenErrorKind> {
    match code {
        ERR_SEC_INTERACTION_NOT_ALLOWED | ERR_SEC_USER_CANCELED => Some(TokenErrorKind::Locked),
        ERR_SEC_AUTH_FAILED => Some(TokenErrorKind::Unavailable),
        _ => None,
    }
}

/// Returns the Keychain status code inside a boxed platform failure.
///
/// The downcast targets `security_framework::base::Error` at the major version
/// keyring links; a mismatch would leave the downcast failing silently, which
/// the `keyring_platform_failure_downcasts_to_locked` test rules out.
#[cfg(target_os = "macos")]
fn platform_failure_status(source: &(dyn std::error::Error + 'static)) -> Option<i32> {
    source
        .downcast_ref::<security_framework::base::Error>()
        .map(|error| error.code())
}

/// Keyring reports no recognizable platform status off macOS: a locked Secret
/// Service collection surfaces as an unavailable store.
#[cfg(not(target_os = "macos"))]
fn platform_failure_status(_source: &(dyn std::error::Error + 'static)) -> Option<i32> {
    None
}

/// Reads `service`/`key` from the platform keyring.
pub(super) fn read_keyring(service: &str, key: &str) -> Result<String, TokenError> {
    let entry = keyring::Entry::new(service, key)
        .map_err(|source| classify_keyring_error(&source, service, key))?;
    entry
        .get_password()
        .map_err(|source| classify_keyring_error(&source, service, key))
}

/// Maps a keyring failure to a classified [`TokenError`].
fn classify_keyring_error(source: &keyring::Error, service: &str, key: &str) -> TokenError {
    match source {
        keyring::Error::NoEntry => not_found(service, key),
        // Backend error text is untrusted and may carry sensitive data, so no
        // branch formats it; only an OSStatus number can appear.
        keyring::Error::PlatformFailure(detail) => {
            let status = platform_failure_status(detail.as_ref());
            match status.and_then(status_kind) {
                Some(TokenErrorKind::Locked) => locked(),
                Some(TokenErrorKind::Unavailable) => denied(),
                _ => unavailable(status),
            }
        }
        keyring::Error::BadEncoding(_) => invalid("the stored value is not valid UTF-8"),
        keyring::Error::TooLong(..) | keyring::Error::Invalid(..) => {
            invalid("the entry name is not accepted by the credential store")
        }
        keyring::Error::Ambiguous(matches) => invalid(&format!(
            "{} credentials match the entry name; keep exactly one",
            matches.len()
        )),
        // `NoStorageAccess` and any future variant: no usable detail.
        _ => unavailable(None),
    }
}

fn not_found(service: &str, key: &str) -> TokenError {
    TokenError::with_kind(
        TokenErrorKind::NotFound,
        format!(
            "no credential named `{key}` in service `{service}`; \
             add an entry with account name `{key}` to that service"
        ),
    )
}

fn locked() -> TokenError {
    TokenError::with_kind(
        TokenErrorKind::Locked,
        "the credential store is locked; unlock the login keychain and retry",
    )
}

fn denied() -> TokenError {
    TokenError::with_kind(
        TokenErrorKind::Unavailable,
        "the credential store refused access to the entry; allow access in Keychain Access \
         or unlock the login keychain with its password, then retry",
    )
}

fn unavailable(status: Option<i32>) -> TokenError {
    let status = status.map_or_else(String::new, |code| format!(" (status {code})"));
    TokenError::with_kind(
        TokenErrorKind::Unavailable,
        format!(
            "the credential store is unavailable{status}; check that the login keychain \
             exists and is accessible (Linux: that a Secret Service provider is running and \
             its collection is unlocked)"
        ),
    )
}

fn invalid(detail: &str) -> TokenError {
    TokenError::with_kind(
        TokenErrorKind::Invalid,
        format!("the credential cannot be used: {detail}"),
    )
}

/// Maps a failed lookup task to an error. Neither the panic payload nor the
/// join error text reaches the message: a payload is arbitrary text.
fn task_failed(error: &JoinError) -> TokenError {
    tracing::error!(
        panicked = error.is_panic(),
        cancelled = error.is_cancelled(),
        "credential lookup task did not complete"
    );
    TokenError::with_kind(
        TokenErrorKind::Other,
        "the credential lookup ended unexpectedly; retry, and report this if it persists",
    )
}

/// Single permit shared by every lookup of the process.
fn store_permit() -> &'static Arc<Semaphore> {
    static PERMIT: OnceLock<Arc<Semaphore>> = OnceLock::new();
    PERMIT.get_or_init(|| Arc::new(Semaphore::new(1)))
}

/// Runs `read` on a blocking thread as the store's only in-flight lookup.
///
/// The wait for the permit is async, so a caller timeout drops the waiter
/// without it ever occupying a blocking thread. The permit moves into the
/// blocking closure and is released when the read returns, panics, or is
/// dropped unrun at runtime shutdown, never when the caller gives up.
pub(super) async fn lookup<F>(read: F) -> Result<String, TokenError>
where
    F: FnOnce() -> Result<String, TokenError> + Send + 'static,
{
    let permit = Arc::clone(store_permit())
        .acquire_owned()
        .await
        .map_err(|_closed| {
            TokenError::with_kind(
                TokenErrorKind::Other,
                "the credential lookup gate is closed; report this",
            )
        })?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        read()
    })
    .await
    .map_err(|error| task_failed(&error))?
}
