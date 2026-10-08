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
