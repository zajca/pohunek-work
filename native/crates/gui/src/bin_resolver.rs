//! Resolution of the programs the GUI starts to an absolute executable.
//!
//! An app started from Finder or launchd carries a minimal `PATH`, so a bare
//! `pohunek`, `kitty`, or `notify-send` would not resolve. A configured
//! absolute path is used as is; a bare name is looked up in a search path
//! resolved by the shared `pohunek_platform::shell_env` policy (login-shell
//! discovery on macOS, the process `PATH` elsewhere, then the documented
//! fallback directories).
//!
//! One resolver serves every program name, so the bounded login-shell probe is
//! shared. The resolved search path is cached; a lookup that misses discards it
//! once and discovers again, so an installation done after the GUI started is
//! found without a restart. Discovery runs under the cache lock, so concurrent
//! callers wait for one probe instead of starting their own.

// Rust guideline compliant 2026-10-01
#![forbid(unsafe_code)]

use std::ffi::{OsStr, OsString};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use pohunek_platform::shell_env::{
    login_environment, resolve_executable, resolve_search_path, ExecutableError,
    LoginEnvironmentError, LoginShellSpec, PathPolicy, ResolveError, SearchPath,
    DARWIN_FALLBACK_DIRECTORIES, PRINTENV_EXECUTABLE,
};
use thiserror::Error;

/// Tunables of the login-shell probe.
#[derive(Debug, Clone)]
pub(crate) struct LoginShellSettings {
    pub(crate) timeout: Duration,
    pub(crate) max_output_bytes: usize,
}

/// Reports why a program did not resolve.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub(crate) enum BinError {
    /// The program is unusable. `cause` is why the search path is what it is
    /// (a failed login-shell probe, an unusable inherited `PATH`), when that
    /// explains a miss.
    #[error("executable `{program}` is unusable: {source}{}", cause_suffix(.cause.as_deref()))]
    Executable {
        program: String,
        #[source]
        source: ExecutableError,
        cause: Option<String>,
    },
    #[error("cannot determine an executable search path: {0}")]
    SearchPath(String),
}

fn cause_suffix(cause: Option<&str>) -> String {
    cause.map_or_else(String::new, |cause| format!(" ({cause})"))
}

/// A discovered search path and the reason it fell back, when it did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Discovery {
    pub(crate) path: SearchPath,
    /// Why a higher tier was skipped; shown when a lookup misses.
    pub(crate) cause: Option<String>,
}

type Discover = dyn Fn() -> Result<Discovery, BinError> + Send + Sync;

/// Resolves program names to absolute executables.
pub(crate) struct BinResolver {
    program: OsString,
    discover: Box<Discover>,
    cache: Mutex<Option<Discovery>>,
}

impl fmt::Debug for BinResolver {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BinResolver")
            .field("program", &self.program)
            .finish_non_exhaustive()
    }
}

impl BinResolver {
    /// Builds the resolver that discovers the search path of this host.
    ///
    /// `program` is the name [`Self::resolve`] returns; other names go through
    /// [`Self::resolve_name`].
    pub(crate) fn for_host(program: &str, login_shell: LoginShellSettings) -> Self {
        Self::with_discovery_cause(program, move || discover_host_search_path(&login_shell))
    }

    /// Builds a resolver around an explicit discovery function.
    #[cfg(test)]
    pub(crate) fn with_discovery(
        program: &str,
        discover: impl Fn() -> Result<SearchPath, BinError> + Send + Sync + 'static,
    ) -> Self {
        Self::with_discovery_cause(program, move || {
            discover().map(|path| Discovery { path, cause: None })
        })
    }

    /// Builds a resolver around a discovery function that reports its cause.
    pub(crate) fn with_discovery_cause(
        program: &str,
        discover: impl Fn() -> Result<Discovery, BinError> + Send + Sync + 'static,
    ) -> Self {
        Self {
            program: OsString::from(program),
            discover: Box::new(discover),
            cache: Mutex::new(None),
        }
    }

    /// Returns the absolute path of the primary program.
    ///
    /// Blocks while a search path is discovered, so callers run it off the UI
    /// thread.
    ///
    /// # Errors
    ///
    /// See [`Self::resolve_name`].
    pub(crate) fn resolve(&self) -> Result<PathBuf, BinError> {
        self.resolve_name(&self.program)
    }

    /// Returns the absolute path of `name`.
    ///
    /// A name containing `/` must be absolute and executable; a bare name is
    /// searched.
    ///
    /// # Errors
    ///
    /// Returns [`BinError`] when the name is invalid, a configured path is not
    /// an executable file, no search path can be built, or the name is found
    /// nowhere even after a fresh discovery.
    pub(crate) fn resolve_name(&self, name: &OsStr) -> Result<PathBuf, BinError> {
        if name.as_encoded_bytes().contains(&b'/') {
            return lookup(
                name,
                &Discovery {
                    path: SearchPath::empty(),
                    cause: None,
                },
            );
        }
        let mut cache = self.cache.lock().expect("bin resolver cache lock");
        if let Some(discovery) = cache.as_ref() {
            match lookup(name, discovery) {
                Err(BinError::Executable {
                    source: ExecutableError::NotFound,
                    ..
                }) => {}
                other => return other,
            }
        }
        let fresh = (self.discover)()?;
        let result = lookup(name, &fresh);
        *cache = Some(fresh);
        result
    }
}

fn lookup(name: &OsStr, discovery: &Discovery) -> Result<PathBuf, BinError> {
    resolve_executable(name, &discovery.path).map_err(|source| BinError::Executable {
        program: name.to_string_lossy().into_owned(),
        cause: matches!(source, ExecutableError::NotFound)
            .then(|| discovery.cause.clone())
            .flatten(),
        source,
    })
}

/// Discovers the search path of this host from the process environment.
///
/// See [`compose_search_path`] for the tiers.
fn discover_host_search_path(login_shell: &LoginShellSettings) -> Result<Discovery, BinError> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    compose_search_path(
        cfg!(target_os = "macos"),
        std::env::var("PATH").map_err(|error| error.to_string()),
        login_shell_spec(login_shell, |name| std::env::var_os(name)),
        home.as_deref(),
    )
}

/// Builds the search path by the documented tier order.
///
/// Every host trusts its explicitly inherited `PATH` first: a GUI started from a
/// shell finds what that shell finds. Entries are sanitized by the same rules
/// as every other tier (absolute, existing, trusted directories; relative and
/// empty entries skipped) and a refused entry is reported in the cause shown on
/// a miss. Elsewhere that is the whole answer (then the fallback directories
/// when the inherited value yields nothing). On macOS a Finder or launchd start
/// carries only the system directories, so the login shell's `PATH` and then
/// the fixed fallback directories follow, deduplicated.
///
/// `darwin` and the inputs are parameters so the macOS composition is tested on
/// every host; `login` is the already built probe or why it cannot be built.
fn compose_search_path(
    darwin: bool,
    inherited_value: Result<String, String>,
    login: Result<LoginShellSpec, LoginEnvironmentError>,
    home: Option<&Path>,
) -> Result<Discovery, BinError> {
    let mut causes: Vec<String> = Vec::new();
    let inherited = match inherited_value
        .and_then(|value| SearchPath::sanitize(&value, true).map_err(|error| error.to_string()))
    {
        Ok(sanitized) => {
            for dropped in &sanitized.untrusted {
                causes.push(format!(
                    "the inherited PATH entry `{}` was refused: {}",
                    dropped.entry, dropped.reason
                ));
            }
            Some(sanitized.path)
        }
        Err(reason) => {
            causes.push(format!("the inherited PATH is unusable: {reason}"));
            None
        }
    };
    if !darwin {
        let discovery = discover_search_path(inherited.as_ref(), None, home, joined(&causes))?;
        return Ok(discovery);
    }
    let rest = match login {
        Ok(spec) => discover_search_path(None, Some(&spec), home, None)?,
        // An unusable `$SHELL` or profile selector cannot start the probe; the
        // fallback directories apply and the cause is shown on a miss.
        Err(error) => discover_search_path(
            None,
            None,
            home,
            Some(format!(
                "the login shell environment is unusable: {error}; searched the fallback directories"
            )),
        )?,
    };
    causes.extend(rest.cause);
    let path = match inherited {
        Some(inherited) => inherited.with_appended(&rest.path),
        None => rest.path,
    };
    Ok(Discovery {
        path,
        cause: joined(&causes),
    })
}

fn joined(causes: &[String]) -> Option<String> {
    (!causes.is_empty()).then(|| causes.join("; "))
}

/// Builds the login-shell probe from the process environment.
///
/// The environment (identity variables, `ZDOTDIR`, `XDG_CONFIG_HOME`, and
/// `$SHELL`) and its validation are the shared
/// [`pohunek_platform::shell_env::login_environment`], the same one the service
/// installer uses. `lookup` is injected for tests.
fn login_shell_spec(
    settings: &LoginShellSettings,
    lookup: impl Fn(&str) -> Option<OsString>,
) -> Result<LoginShellSpec, LoginEnvironmentError> {
    let login = login_environment(lookup)?;
    Ok(LoginShellSpec {
        shell: login.shell,
        printenv: PathBuf::from(PRINTENV_EXECUTABLE),
        environment: login.variables,
        timeout: settings.timeout,
        max_output_bytes: settings.max_output_bytes,
    })
}

/// Resolves the policy tiers; `prior_cause` explains a tier the caller already
/// skipped.
fn discover_search_path(
    configured: Option<&SearchPath>,
    login_shell: Option<&LoginShellSpec>,
    home: Option<&Path>,
    prior_cause: Option<String>,
) -> Result<Discovery, BinError> {
    let resolution = resolve_search_path(&PathPolicy {
        configured,
        login_shell,
        fallback_directories: DARWIN_FALLBACK_DIRECTORIES,
        home,
    })
    .map_err(|error: ResolveError| BinError::SearchPath(error.to_string()))?;
    let cause = resolution
        .login_shell_failure
        .as_ref()
        .map(|failure| {
            format!(
                "login shell PATH discovery failed: {failure}; searched the fallback directories"
            )
        })
        .or(prior_cause);
    Ok(Discovery {
        path: resolution.path,
        cause,
    })
}

#[cfg(test)]
mod integration_tests {
    use std::fs;

    use pohunek_platform::shell_env::{LOGIN_SHELL_OUTPUT, LOGIN_SHELL_TIMEOUT};

    use super::*;

    fn fake_shell(dir: &Path, profile: &str) -> PathBuf {
        let path = dir.join("fake-shell");
        fs::write(
            &path,
            format!("#!/bin/sh\n{profile}\nexport PATH\nexec /bin/sh -c \"$3\"\n"),
        )
        .expect("write shell");
        crate::test_support::make_executable(&path);
        path
    }

    fn executable(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, "#!/bin/sh\nexit 0\n").expect("write executable");
        crate::test_support::make_executable(&path);
        path
    }

    fn resolver(
        shell: &Path,
        selectors: Vec<(&'static str, OsString)>,
        program: &str,
    ) -> BinResolver {
        let mut variables = vec![("SHELL", shell.as_os_str().to_owned())];
        variables.extend(selectors);
        BinResolver::with_discovery_cause(program, move || {
            let settings = LoginShellSettings {
                timeout: LOGIN_SHELL_TIMEOUT,
                max_output_bytes: LOGIN_SHELL_OUTPUT,
            };
            let login = login_shell_spec(&settings, |name| {
                variables
                    .iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| value.clone())
            });
            compose_search_path(true, Ok("/usr/bin:/bin".to_owned()), login, None)
        })
    }

    #[test]
    fn login_shell_profile_uses_forwarded_shell_identity_to_resolve_program() {
        let _watchdog = crate::test_support::watchdog();
        let dir = crate::test_support::fixture();
        let prefix = dir.path().join("by-shell/bin");
        fs::create_dir_all(&prefix).expect("prefix");
        let program = executable(&prefix, "profile-shell-tool");
        let shell = fake_shell(
            dir.path(),
            &format!("[ \"$SHELL\" = \"$0\" ] && PATH='{}'", prefix.display()),
        );

        assert_eq!(
            resolver(&shell, vec![], "profile-shell-tool")
                .resolve()
                .expect("resolve through login shell"),
            program
        );
    }

    #[test]
    fn login_shell_profile_uses_forwarded_zdotdir_and_xdg_config_home() {
        let _watchdog = crate::test_support::watchdog();
        let dir = crate::test_support::fixture();
        let zsh_prefix = dir.path().join("zdot-prefix");
        let fish_prefix = dir.path().join("xdg-prefix");
        fs::create_dir_all(&zsh_prefix).expect("zsh prefix");
        fs::create_dir_all(&fish_prefix).expect("fish prefix");
        let zsh_program = executable(&zsh_prefix, "profile-zdot-tool");
        let fish_program = executable(&fish_prefix, "profile-xdg-tool");
        let zdotdir = dir.path().join("zdotdir");
        let xdg = dir.path().join("xdg");
        fs::create_dir_all(&zdotdir).expect("zdotdir");
        fs::create_dir_all(&xdg).expect("xdg");
        fs::write(zdotdir.join("path"), zsh_prefix.display().to_string()).expect("zsh profile");
        fs::write(xdg.join("path"), fish_prefix.display().to_string()).expect("xdg profile");
        let shell = fake_shell(
            dir.path(),
            "[ -n \"$ZDOTDIR\" ] && PATH=\"$(/bin/cat \"$ZDOTDIR/path\")\"\n[ -n \"$XDG_CONFIG_HOME\" ] && PATH=\"$PATH:$(/bin/cat \"$XDG_CONFIG_HOME/path\")\"",
        );
        let resolver = resolver(
            &shell,
            vec![
                ("ZDOTDIR", zdotdir.into_os_string()),
                ("XDG_CONFIG_HOME", xdg.into_os_string()),
            ],
            "profile-zdot-tool",
        );

        assert_eq!(
            resolver.resolve().expect("resolve ZDOTDIR tool"),
            zsh_program
        );
        assert_eq!(
            resolver
                .resolve_name(OsStr::new("profile-xdg-tool"))
                .expect("resolve XDG_CONFIG_HOME tool"),
            fish_program
        );
    }
}
