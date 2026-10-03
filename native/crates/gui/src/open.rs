//! Opening links and folders in the desktop's default applications.
//!
//! The target is passed to the opener (`xdg-open`, or `open` on macOS) as one
//! argument and never through a shell. A URL is already restricted to `https://`
//! by [`ExternalUrl`]; a folder is an absolute path of an existing directory, so
//! neither can start with `-` and be read as an option.

// Rust guideline compliant 2026-10-03
#![forbid(unsafe_code)]

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use pohunek_gui_core::{ExternalUrl, HostConfig, HostTransport};
use thiserror::Error;

use crate::bin_resolver::BinResolver;
use crate::notify::CommandResolution;
use crate::terminal::{spawn_observed, ObserveError};

/// Default opener outside macOS; the freedesktop launcher.
pub(crate) const DEFAULT_OPEN_COMMAND: &str = "xdg-open";

/// Default opener on macOS.
pub(crate) const DARWIN_OPEN_COMMAND: &str = "open";

/// Something the desktop can open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum OpenTarget {
    Url(ExternalUrl),
    /// An absolute directory path on this machine.
    Folder(PathBuf),
}

impl OpenTarget {
    /// Short description for status lines, such as `GitHub link`.
    pub(crate) fn describe(&self) -> String {
        match self {
            Self::Url(url) => format!("{} link", url.site().label()),
            Self::Folder(_) => "folder".to_owned(),
        }
    }

    fn argument(&self) -> OsString {
        match self {
            Self::Url(url) => OsString::from(url.as_str()),
            Self::Folder(path) => path.clone().into_os_string(),
        }
    }
}

/// Why a target was not opened.
#[derive(Debug, Error)]
pub(crate) enum OpenError {
    #[error("{} is not an absolute path", .0.display())]
    NotAbsolute(PathBuf),
    #[error("{} is not a directory on this machine", .0.display())]
    NotDirectory(PathBuf),
    #[error("cannot find the opener: {0}")]
    Resolve(String),
    #[error(transparent)]
    Start(#[from] ObserveError),
}

/// Validates `path` as a folder to open, checking the filesystem now.
///
/// # Errors
///
/// Returns [`OpenError`] when the path is relative, holds a NUL byte, or is not
/// an existing directory.
pub(crate) fn folder_target(path: &Path) -> Result<OpenTarget, OpenError> {
    if !path.is_absolute() || path.as_os_str().as_encoded_bytes().contains(&0) {
        return Err(OpenError::NotAbsolute(path.to_owned()));
    }
    if !path.is_dir() {
        return Err(OpenError::NotDirectory(path.to_owned()));
    }
    Ok(OpenTarget::Folder(path.to_owned()))
}

/// Whether paths reported by `host` exist on this machine.
///
/// A remote session reports paths of its own machine, which opening locally
/// would miss or, worse, resolve to an unrelated local directory.
pub(crate) fn host_is_local(host: &HostConfig) -> bool {
    matches!(host.transport, HostTransport::Local { .. })
}

/// The configured desktop opener.
#[derive(Debug, Clone)]
pub(crate) struct Opener {
    resolution: Arc<CommandResolution>,
    /// How long the opener is watched for an immediate failure. A launcher that
    /// stays in the foreground until the opened application exits is left running.
    observe: Duration,
    /// Time allowed for locating the opener executable.
    resolve_budget: Duration,
}

impl Opener {
    pub(crate) fn new(
        command: Option<&str>,
        darwin: bool,
        resolver: &Arc<BinResolver>,
        observe: Duration,
        resolve_budget: Duration,
    ) -> Self {
        let program = command.unwrap_or(if darwin {
            DARWIN_OPEN_COMMAND
        } else {
            DEFAULT_OPEN_COMMAND
        });
        Self {
            resolution: Arc::new(CommandResolution::new(Arc::clone(resolver), program)),
            observe,
            resolve_budget,
        }
    }

    /// Hands `target` to the opener. Blocks, so callers run it off the UI thread.
    ///
    /// # Errors
    ///
    /// Returns [`OpenError`] when a folder is gone, the opener cannot be found or
    /// started, or it exits unsuccessfully within the observation window.
    pub(crate) fn open(&self, target: &OpenTarget) -> Result<(), OpenError> {
        // A folder is checked again here, as it may have gone since the click.
        let target = match target {
            OpenTarget::Folder(path) => folder_target(path)?,
            url @ OpenTarget::Url(_) => url.clone(),
        };
        let program = self
            .resolution
            .resolve(self.resolve_budget)
            .map_err(OpenError::Resolve)?;
        spawn_observed(program.as_os_str(), &[target.argument()], self.observe)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::test_support::{fixture, make_executable};

    fn resolver() -> Arc<BinResolver> {
        Arc::new(BinResolver::with_discovery("pohunek", || {
            unreachable!("an absolute opener path needs no search path")
        }))
    }

    fn script(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("opener");
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write script");
        make_executable(&path);
        path
    }

    fn opener(program: &Path, observe: Duration) -> Opener {
        Opener::new(
            program.to_str(),
            false,
            &resolver(),
            observe,
            Duration::from_secs(5),
        )
    }

    #[test]
    fn folder_target_requires_an_existing_absolute_directory() {
        let dir = fixture();
        let file = dir.path().join("file");
        fs::write(&file, "x").expect("write");

        assert_eq!(
            folder_target(dir.path()).expect("dir"),
            OpenTarget::Folder(dir.path().to_owned())
        );
        assert!(matches!(
            folder_target(Path::new("relative/dir")),
            Err(OpenError::NotAbsolute(_))
        ));
        assert!(matches!(
            folder_target(&file),
            Err(OpenError::NotDirectory(_))
        ));
        assert!(matches!(
            folder_target(&dir.path().join("missing")),
            Err(OpenError::NotDirectory(_))
        ));
    }

    #[test]
    fn only_a_local_transport_counts_as_local() {
        let local = HostConfig::local("local", PathBuf::from("/run/pohunek.sock"));
        let remote = HostConfig::tcp("peer", "127.0.0.1:18722".parse().expect("addr"));

        assert!(host_is_local(&local));
        assert!(!host_is_local(&remote));
    }

    #[test]
    fn the_target_reaches_the_opener_as_one_argument() {
        let dir = fixture();
        let record = dir.path().join("argv");
        let program = script(
            dir.path(),
            &format!("printf '%s\\n' \"$#\" \"$1\" > {}", record.display()),
        );
        let url = ExternalUrl::parse("https://github.com/o/r/pull/1?a=1&b=$(id)").expect("url");

        opener(&program, Duration::from_secs(5))
            .open(&OpenTarget::Url(url.clone()))
            .expect("open");

        assert_eq!(
            fs::read_to_string(&record).expect("record"),
            format!("1\n{}\n", url.as_str())
        );
    }

    #[test]
    fn a_quick_failure_of_the_opener_is_reported() {
        let dir = fixture();
        let program = script(dir.path(), "exit 3");
        let url = ExternalUrl::parse("https://github.com/o/r").expect("url");

        let error = opener(&program, Duration::from_secs(5))
            .open(&OpenTarget::Url(url))
            .expect_err("failing opener");

        assert!(matches!(
            error,
            OpenError::Start(ObserveError::ExitedEarly { .. })
        ));
    }

    #[test]
    fn a_launcher_that_keeps_running_counts_as_started() {
        let dir = fixture();
        let program = script(dir.path(), "sleep 2");
        let url = ExternalUrl::parse("https://github.com/o/r").expect("url");

        opener(&program, Duration::from_millis(100))
            .open(&OpenTarget::Url(url))
            .expect("a foreground launcher is left running");
    }

    #[test]
    fn a_missing_opener_is_reported_as_unresolved() {
        let missing = Path::new("/nonexistent/opener");
        let url = ExternalUrl::parse("https://github.com/o/r").expect("url");

        let error = opener(missing, Duration::from_millis(100))
            .open(&OpenTarget::Url(url))
            .expect_err("missing opener");

        assert!(matches!(error, OpenError::Resolve(_)), "{error}");
    }

    #[test]
    fn default_opener_depends_on_the_platform() {
        let linux = Opener::new(None, false, &resolver(), Duration::ZERO, Duration::ZERO);
        let darwin = Opener::new(None, true, &resolver(), Duration::ZERO, Duration::ZERO);

        assert!(format!("{linux:?}").contains(DEFAULT_OPEN_COMMAND));
        assert!(format!("{darwin:?}").contains("\"open\""));
    }
}
