//! Work-item links that `pohunek-work` and the provider launch flows store in
//! session metadata, and the validated URLs derived from them.

// Rust guideline compliant 2026-10-03

use std::fmt::{self, Write as _};

use protocol::SessionInfo;

/// Metadata keys written by the `pohunek-work` plugin.
const PLUGIN_ID_KEY: &str = "work.link.id";
const PLUGIN_PROVIDER_KEY: &str = "work.link.provider";
const PLUGIN_KIND_KEY: &str = "work.link.kind";
const PLUGIN_URL_KEY: &str = "work.link.url";
const PLUGIN_BRANCH_KEY: &str = "work.link.branch";
/// Metadata key naming the action a plugin launch performs.
const ROLE_KEY: &str = "work.role";

/// Metadata keys written by the provider launch flows of the GUI and the CLI.
const LEGACY_ID_KEY: &str = "link.id";
const LEGACY_PROVIDER_KEY: &str = "link.provider";
const LEGACY_KIND_KEY: &str = "link.kind";
const LEGACY_URL_KEY: &str = "link.url";
const LEGACY_BRANCH_KEY: &str = "link.branch";

/// The only URL scheme an external open accepts.
const HTTPS_PREFIX: &str = "https://";

/// Upper bound on an openable URL. Metadata values are capped far below this by
/// the daemon; the bound only keeps an absurd value from reaching an opener.
const MAX_URL_BYTES: usize = 2048;

const GITHUB_HOST: &str = "github.com";
const LINEAR_HOST: &str = "linear.app";

/// Why a metadata value cannot be opened as a URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UrlError {
    /// The value does not start with `https://`.
    NotHttps,
    /// The value holds whitespace or a control character.
    ForbiddenCharacter,
    /// The value is longer than the accepted bound.
    TooLong,
    /// The authority is empty or carries credentials.
    BadAuthority,
}

impl fmt::Display for UrlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::NotHttps => "only https:// links can be opened",
            Self::ForbiddenCharacter => "the link contains whitespace or a control character",
            Self::TooLong => "the link is too long",
            Self::BadAuthority => "the link has no host or carries credentials",
        })
    }
}

impl std::error::Error for UrlError {}

/// Site that serves an [`ExternalUrl`], for button labels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Site {
    GitHub,
    Linear,
    /// Any other host, lower-cased.
    Other(String),
}

impl Site {
    /// Short human label, such as `GitHub` or `Linear`.
    #[must_use]
    pub fn label(&self) -> &str {
        match self {
            Self::GitHub => "GitHub",
            Self::Linear => "Linear",
            Self::Other(host) => host,
        }
    }
}

/// An `https://` URL that is safe to hand to a desktop opener as one argument.
///
/// Metadata can be set by any client, so a value is never trusted: the scheme is
/// fixed (which also keeps a leading `-` from reading as an option), whitespace
/// and control characters are refused, and a host with credentials is refused
/// because it would display as one site and open another.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalUrl(String);

impl ExternalUrl {
    /// Validates `value`.
    ///
    /// # Errors
    ///
    /// Returns [`UrlError`] when the value is not a plain `https://` URL.
    pub fn parse(value: &str) -> Result<Self, UrlError> {
        if value.len() > MAX_URL_BYTES {
            return Err(UrlError::TooLong);
        }
        let rest = value
            .get(..HTTPS_PREFIX.len())
            .filter(|prefix| prefix.eq_ignore_ascii_case(HTTPS_PREFIX))
            .map(|_| &value[HTTPS_PREFIX.len()..])
            .ok_or(UrlError::NotHttps)?;
        if value.chars().any(|c| c.is_control() || c.is_whitespace()) {
            return Err(UrlError::ForbiddenCharacter);
        }
        let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
        if authority.is_empty() || authority.contains('@') || authority.starts_with(':') {
            return Err(UrlError::BadAuthority);
        }
        Ok(Self(value.to_owned()))
    }

    /// The validated URL.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The site the URL points to.
    #[must_use]
    pub fn site(&self) -> Site {
        let host = self.host().to_ascii_lowercase();
        match host.strip_prefix("www.").unwrap_or(&host) {
            GITHUB_HOST => Site::GitHub,
            LINEAR_HOST => Site::Linear,
            _ => Site::Other(host),
        }
    }

    /// Branch page of the repository when this is a GitHub pull-request URL.
    ///
    /// Returns `None` for any other URL and for an empty `branch`.
    #[must_use]
    pub fn github_branch_url(&self, branch: &str) -> Option<Self> {
        if branch.is_empty() || self.site() != Site::GitHub {
            return None;
        }
        let path = self.path_segments();
        let [owner, repo, "pull", number, ..] = path.as_slice() else {
            return None;
        };
        if owner.is_empty() || repo.is_empty() || number.is_empty() {
            return None;
        }
        Self::parse(&format!(
            "{HTTPS_PREFIX}{GITHUB_HOST}/{owner}/{repo}/tree/{}",
            percent_encode_path(branch)
        ))
        .ok()
    }

    fn host(&self) -> &str {
        let rest = &self.0[HTTPS_PREFIX.len()..];
        let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
        authority.split(':').next().unwrap_or_default()
    }

    fn path_segments(&self) -> Vec<&str> {
        let rest = &self.0[HTTPS_PREFIX.len()..];
        let without_suffix = rest.split(['?', '#']).next().unwrap_or_default();
        without_suffix.split('/').skip(1).collect()
    }
}

impl fmt::Display for ExternalUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Percent-encodes everything but unreserved characters and `/`.
fn percent_encode_path(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/') {
            encoded.push(char::from(byte));
        } else {
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

/// Work item a session is linked to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkLink {
    /// Provider as stored, such as `linear` or `github`.
    pub provider: Option<String>,
    /// Item kind as stored, such as `issue` or `pull_request`.
    pub kind: Option<String>,
    /// Provider item identifier, such as `KBC-123` or `owner/repo#42`.
    pub id: String,
    /// Item URL, when stored and openable.
    pub url: Option<ExternalUrl>,
    /// Branch the session works on, when stored.
    pub branch: Option<String>,
    /// Plugin action that launched the session, such as `implement` or `review`.
    pub role: Option<String>,
}

impl WorkLink {
    /// Branch page on GitHub, derived from a pull-request link.
    #[must_use]
    pub fn branch_url(&self) -> Option<ExternalUrl> {
        self.url
            .as_ref()?
            .github_branch_url(self.branch.as_deref()?)
    }
}

/// Reads the work-item link of `session`.
///
/// The `work.link.*` keys of the plugin win as a set; only when the plugin
/// stored no id are the `link.*` keys of the provider launch flows read. The
/// namespaces are never mixed field by field, so an id is never paired with the
/// URL of another item. Returns `None` for a session without a link id.
#[must_use]
pub fn work_link(session: &SessionInfo) -> Option<WorkLink> {
    let value = |key: &str| {
        session
            .metadata
            .get(key)
            .map(String::as_str)
            .filter(|value| !value.is_empty())
    };
    let (id, provider, kind, url, branch) = if let Some(id) = value(PLUGIN_ID_KEY) {
        (
            id,
            value(PLUGIN_PROVIDER_KEY),
            value(PLUGIN_KIND_KEY),
            value(PLUGIN_URL_KEY),
            value(PLUGIN_BRANCH_KEY),
        )
    } else {
        (
            value(LEGACY_ID_KEY)?,
            value(LEGACY_PROVIDER_KEY),
            value(LEGACY_KIND_KEY),
            value(LEGACY_URL_KEY),
            value(LEGACY_BRANCH_KEY),
        )
    };
    Some(WorkLink {
        provider: provider.map(str::to_owned),
        kind: kind.map(str::to_owned),
        id: id.to_owned(),
        url: url.and_then(|url| ExternalUrl::parse(url).ok()),
        branch: branch.map(str::to_owned),
        role: value(ROLE_KEY).map(str::to_owned),
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    use protocol::SessionId;

    use super::*;

    fn session_with(metadata: &[(&str, &str)]) -> SessionInfo {
        let mut session = SessionInfo {
            name: None,
            id: SessionId("s-1".to_owned()),
            external: Some(false),
            capabilities: protocol::SessionCapabilities {
                resume: true,
                fork: true,
            },
            agent: "claude".to_owned(),
            agent_base: protocol::AgentKind::Claude,
            cwd: PathBuf::from("/work"),
            cwd_source: None,
            pid: 1,
            cols: 80,
            rows: 24,
            state: protocol::SessionState::Running,
            state_source: protocol::StateSource::Process,
            activity: None,
            subagents: Vec::new(),
            native_session_id: None,
            native_session_path: None,
            active_agent: None,
            active_agent_base: None,
            active_agent_pid: None,
            active_agent_session_id: None,
            active_agent_session_path: None,
            project_id: None,
            project_label: None,
            is_linked_worktree: None,
            repo: None,
            branch: None,
            worktree_path: None,
            warnings: Vec::new(),
            metadata: BTreeMap::new(),
            created_at: "2026-10-03T00:00:00Z".to_owned(),
            updated_at: "2026-10-03T00:00:00Z".to_owned(),
            exit_code: None,
            runtime: None,
        };
        session.metadata = metadata
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect::<BTreeMap<_, _>>();
        session
    }

    #[test]
    fn plugin_keys_win_as_a_set() {
        let session = session_with(&[
            ("work.link.id", "KBC-1"),
            ("work.link.provider", "linear"),
            ("work.link.url", "https://linear.app/keboola/issue/KBC-1"),
            ("link.id", "42"),
            ("link.url", "https://github.com/o/r/pull/42"),
            ("link.branch", "legacy-branch"),
            ("work.role", "implement"),
        ]);

        let link = work_link(&session).expect("link");

        assert_eq!(link.id, "KBC-1");
        assert_eq!(link.url.expect("url").site(), Site::Linear);
        assert_eq!(link.branch, None, "legacy branch must not be mixed in");
        assert_eq!(link.role.as_deref(), Some("implement"));
    }

    #[test]
    fn legacy_keys_are_read_when_the_plugin_stored_no_id() {
        let session = session_with(&[
            ("link.id", "42"),
            ("link.provider", "github"),
            ("link.kind", "pull_request"),
            ("link.url", "https://github.com/o/r/pull/42"),
            ("link.branch", "feat/x"),
        ]);

        let link = work_link(&session).expect("link");

        assert_eq!(link.id, "42");
        assert_eq!(link.kind.as_deref(), Some("pull_request"));
        assert_eq!(link.branch.as_deref(), Some("feat/x"));
    }

    #[test]
    fn a_link_without_url_or_branch_still_exists() {
        let session = session_with(&[("work.link.id", "KBC-9")]);

        let link = work_link(&session).expect("link");

        assert_eq!(link.url, None);
        assert_eq!(link.branch, None);
        assert_eq!(link.branch_url(), None);
    }

    #[test]
    fn no_id_means_no_link() {
        let session = session_with(&[("work.link.url", "https://github.com/o/r/pull/1")]);

        assert_eq!(work_link(&session), None);
    }

    #[test]
    fn an_unsafe_url_is_dropped_but_the_link_stays() {
        let session = session_with(&[
            ("work.link.id", "KBC-9"),
            ("work.link.url", "javascript:alert(1)"),
        ]);

        let link = work_link(&session).expect("link");

        assert_eq!(link.id, "KBC-9");
        assert_eq!(link.url, None);
    }

    #[test]
    fn url_allowlist() {
        for accepted in [
            "https://github.com/o/r/pull/1",
            "HTTPS://linear.app/team/issue/A-1",
            "https://example.com:8443/x?y=1#z",
        ] {
            assert!(ExternalUrl::parse(accepted).is_ok(), "{accepted}");
        }
        for (rejected, why) in [
            ("http://github.com/o", UrlError::NotHttps),
            ("-https://github.com", UrlError::NotHttps),
            ("file:///etc/passwd", UrlError::NotHttps),
            ("", UrlError::NotHttps),
            ("https://", UrlError::BadAuthority),
            ("https:///path", UrlError::BadAuthority),
            ("https://github.com@evil.example/x", UrlError::BadAuthority),
            ("https://user:pw@host/x", UrlError::BadAuthority),
            ("https://github.com/a b", UrlError::ForbiddenCharacter),
            ("https://github.com/a\nb", UrlError::ForbiddenCharacter),
            ("https://github.com/a\u{0}b", UrlError::ForbiddenCharacter),
        ] {
            assert_eq!(ExternalUrl::parse(rejected), Err(why), "{rejected:?}");
        }
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL_BYTES));
        assert_eq!(ExternalUrl::parse(&long), Err(UrlError::TooLong));
    }

    #[test]
    fn site_follows_the_host_not_the_provider() {
        let url = ExternalUrl::parse("https://www.GitHub.com/o/r/pull/1").expect("url");

        assert_eq!(url.site(), Site::GitHub);
        assert_eq!(
            ExternalUrl::parse("https://github.com.evil.example/x")
                .expect("url")
                .site(),
            Site::Other("github.com.evil.example".to_owned())
        );
    }

    #[test]
    fn branch_url_derives_only_from_a_github_pull_request() {
        let pull =
            ExternalUrl::parse("https://github.com/keboola/pohunek/pull/42/files").expect("url");

        assert_eq!(
            pull.github_branch_url("zajca/KBC-1/fix thing#2")
                .expect("branch url")
                .as_str(),
            "https://github.com/keboola/pohunek/tree/zajca/KBC-1/fix%20thing%232"
        );
        assert_eq!(pull.github_branch_url(""), None);
        for other in [
            "https://github.com/keboola/pohunek",
            "https://github.com/keboola/pohunek/issues/3",
            "https://linear.app/t/issue/A-1",
            "https://github.com.evil.example/o/r/pull/1",
        ] {
            let url = ExternalUrl::parse(other).expect("url");
            assert_eq!(url.github_branch_url("main"), None, "{other}");
        }
    }
}
