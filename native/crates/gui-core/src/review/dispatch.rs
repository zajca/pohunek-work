//! Rendering the review prompt and dispatching a review as a new
//! same-worktree session.

// Rust guideline compliant 2026-10-01

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::path::Path;

use protocol::{SessionInfo, SessionNewParams, SessionNewResult};

use time::OffsetDateTime;

use super::model::{format_rfc3339, Review};
use super::prompt::{render_review_template, ReviewPromptContext, DEFAULT_REVIEW_TEMPLATE};
use super::store::ReviewStore;
use crate::{create_session_with_options, ConnectionOptions, CoreError, HostConfig};

/// Session metadata key recording which review dispatched a session.
pub const REVIEW_SOURCE_KEY: &str = "review.source";
/// Session metadata key recording when a review was dispatched, RFC3339.
pub const REVIEW_DISPATCHED_AT_KEY: &str = "review.dispatched_at";

/// Prefix shared by every `link.*` session metadata key
/// (the core prompt crate's `LINK_*_KEY` constants). Copied verbatim
/// from the source session onto a dispatched review session so the review
/// session stays linked to the same provider item as its source.
const LINK_METADATA_PREFIX: &str = "link.";

/// Renders the review prompt for `review`.
///
/// The template is `prompts/review.tmpl` under the host config directory
/// (`pohunek_paths::config_home()`/`pohunek`) when that file exists, and the
/// built-in default otherwise. The host directory is read directly, bypassing
/// the per-project `ProjectConfigResolver` lookup that `project.action`
/// templates use: review dispatch is a GUI-global feature with no project or
/// repo context at render time.
///
/// `source_description` is a human-readable summary of what was reviewed
/// (e.g. `"session abc123 worktree diff vs main"` or `"PR #42"`), supplied by
/// the caller because deriving it requires data this type does not itself
/// hold (a live `SessionInfo`'s short id/base, or PR metadata).
///
/// # Errors
///
/// Returns [`CoreError::MissingEnv`] when neither `XDG_CONFIG_HOME` nor `HOME`
/// resolves, [`CoreError::ReviewTemplateIo`] when the template file exists but
/// cannot be read, and [`CoreError::UnknownReviewPromptVariables`] when the
/// template references a variable outside
/// `${provider}`/`${branch}`/`${source}`/`${comments}`/`${comment_count}`.
pub fn render_review_prompt(
    review: &Review,
    source_description: &str,
) -> Result<String, CoreError> {
    let config_dir = pohunek_paths::config_home()
        .map_err(|_source| CoreError::MissingEnv {
            var: "XDG_CONFIG_HOME or HOME".to_owned(),
        })?
        .join(pohunek_paths::APP_DIR);
    render_review_prompt_from_config_dir(review, source_description, &config_dir)
}

/// Same as [`render_review_prompt`], but with the host config directory passed
/// in explicitly so the template-resolution paths are testable against a temp
/// directory without mutating process-wide `XDG_CONFIG_HOME`/`HOME`.
fn render_review_prompt_from_config_dir(
    review: &Review,
    source_description: &str,
    config_dir: &Path,
) -> Result<String, CoreError> {
    let template_path = config_dir.join("prompts").join("review.tmpl");
    let template = match std::fs::read_to_string(&template_path) {
        Ok(template) => Cow::Owned(template),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            Cow::Borrowed(DEFAULT_REVIEW_TEMPLATE)
        }
        Err(source) => {
            return Err(CoreError::ReviewTemplateIo {
                path: template_path,
                source,
            })
        }
    };
    render_review_template(
        &template,
        &ReviewPromptContext::new(review, source_description),
    )
}

/// Parameters for [`dispatch_review`] other than the review being dispatched.
///
/// Grouped into one struct (mirroring [`crate::PromptLaunchParams`] and
/// [`crate::ProviderLaunchParams`]) rather than passed as separate
/// arguments, keeping the function signature small.
#[derive(Debug)]
pub struct ReviewDispatchParams<'a> {
    /// Host to dispatch the new session on.
    pub config: &'a HostConfig,
    /// Store the dispatched review is persisted to.
    pub store: &'a ReviewStore,
    /// Current `session.inspect` result for the review's source session.
    pub session_info: &'a SessionInfo,
    /// Agent profile to run the dispatched session as. `Some` overrides
    /// `session_info.agent` with the operator's pick from the Review tab's
    /// dispatch modal agent picker; `None` falls back to
    /// `session_info.agent`, reusing the source session's own profile.
    pub agent: Option<String>,
    /// Output of [`render_review_prompt`], rendered by the caller so a
    /// template error surfaces before any session is created.
    pub rendered_prompt: String,
    /// Initial terminal width in columns for the dispatched session.
    pub cols: u16,
    /// Initial terminal height in rows for the dispatched session.
    pub rows: u16,
    /// Connection options for the `session.new` call.
    pub options: ConnectionOptions,
}

/// Dispatches `review` as a new session in its source session's SAME
/// worktree, then marks the review dispatched and persists it.
///
/// `params.session_info` must be the *current* `session.inspect` result for
/// the review's source session — its `worktree_path` supplies the new
/// session's `cwd`, with no local path guessing. The dispatched session's
/// agent profile is `params.agent` when given (the operator's pick from the
/// dispatch modal), otherwise `session_info.agent` — reusing the source
/// session's own profile by default, but overridable.
///
/// This intentionally omits `project`/`repo`/`branch` from the `session.new`
/// call: those would make the daemon mint a *new* worktree binding, which is
/// impossible while the source session's worktree still exists (git refuses
/// a second checkout of the same branch — NEXT.md D.6 decision 2). `cwd`
/// alone launches the new session in place, reusing the existing checkout.
///
/// `link.*` metadata keys present on `params.session_info` are copied
/// verbatim onto the new session, alongside `review.source` (this review's
/// id) and `review.dispatched_at` (RFC3339 now).
///
/// # Errors
///
/// Returns [`CoreError::ReviewSessionMissingWorktree`] when `session_info` has
/// no bound worktree. Returns the `session.new` error unchanged when the
/// daemon refuses — `review` and its on-disk draft are left untouched, since
/// this function only mutates `review`/persists it *after* `session.new`
/// succeeds. Returns [`CoreError::ReviewStore`] when the successful dispatch
/// cannot be persisted; the daemon session already exists at that point, but
/// the atomic store write means the on-disk review file is unaffected by the
/// failed save (still the pre-dispatch draft), never a half-written file.
pub async fn dispatch_review(
    review: &mut Review,
    params: ReviewDispatchParams<'_>,
) -> Result<SessionNewResult, CoreError> {
    let ReviewDispatchParams {
        config,
        store,
        session_info,
        agent,
        rendered_prompt,
        cols,
        rows,
        options,
    } = params;
    let Some(worktree_path) = session_info.worktree_path.clone() else {
        return Err(CoreError::ReviewSessionMissingWorktree {
            session_id: session_info.id.clone(),
        });
    };

    let metadata = review_session_metadata(
        &session_info.metadata,
        review.id.as_str(),
        OffsetDateTime::now_utc(),
    );

    let new_params = SessionNewParams {
        agent: agent.unwrap_or_else(|| session_info.agent.clone()),
        name: None,
        cwd: Some(worktree_path),
        cols,
        rows,
        project: None,
        repo: None,
        branch: None,
        base_branch: None,
        input: Some(rendered_prompt),
        metadata,
    };

    let created = create_session_with_options(config, new_params, options).await?;

    review.mark_dispatched(created.session.id.clone());
    store.save(review)?;

    Ok(created)
}

/// Builds the dispatched session's metadata: the source session's `link.*`
/// keys plus `review.source` and `review.dispatched_at` (`now`, RFC3339).
fn review_session_metadata(
    source: &BTreeMap<String, String>,
    review_id: &str,
    now: OffsetDateTime,
) -> BTreeMap<String, String> {
    let mut metadata = copied_link_metadata(source);
    metadata.insert(REVIEW_SOURCE_KEY.to_owned(), review_id.to_owned());
    metadata.insert(REVIEW_DISPATCHED_AT_KEY.to_owned(), format_rfc3339(now));
    metadata
}

fn copied_link_metadata(source: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    source
        .iter()
        .filter(|(key, _)| key.starts_with(LINK_METADATA_PREFIX))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{
        render_review_prompt_from_config_dir, review_session_metadata, REVIEW_DISPATCHED_AT_KEY,
        REVIEW_SOURCE_KEY,
    };
    use crate::review::model::{Review, ReviewComment, ReviewSide, ReviewSource};
    use crate::{CoreError, HostId};
    use protocol::SessionId;
    use time::macros::datetime;

    /// Random, owner-private fixture root; removed when the guard drops.
    fn fixture_root() -> tempfile::TempDir {
        pohunek_test_support::tempdir_with_prefix("pgc-rd").expect("private fixture root")
    }

    fn sample_review() -> Review {
        let mut review = Review::new(
            ReviewSource::Session {
                host_id: HostId::new("host-1"),
                session_id: SessionId("s-1".to_owned()),
            },
            "project-1",
            "feature/diff-review",
        );
        review.add_comment(ReviewComment::new(
            "src/lib.rs",
            ReviewSide::New,
            10,
            "fix this",
        ));
        review.add_comment(ReviewComment::new(
            "src/lib.rs",
            ReviewSide::Old,
            20,
            "remove dead code",
        ));
        review
    }

    #[test]
    fn render_review_prompt_succeeds_when_the_template_file_exists() {
        let root = fixture_root();
        let config_dir = root.path().join("config");
        let prompts_dir = config_dir.join("prompts");
        std::fs::create_dir_all(&prompts_dir).expect("create prompts dir");
        std::fs::write(
            prompts_dir.join("review.tmpl"),
            "Review of ${source} on branch ${branch} (${comment_count} comments):\n${comments}\n",
        )
        .expect("write review.tmpl");
        let review = sample_review();

        let rendered = render_review_prompt_from_config_dir(&review, "PR #42", &config_dir)
            .expect("render review prompt with a present template");

        assert_eq!(
            rendered,
            "Review of PR #42 on branch feature/diff-review (2 comments):\n\
             src/lib.rs:10 (new): fix this\n\nsrc/lib.rs:20 (old): remove dead code\n"
        );
    }

    #[test]
    fn render_review_prompt_falls_back_to_the_built_in_template_when_none_is_installed() {
        let root = fixture_root();
        let config_dir = root.path().join("config");
        let review = sample_review();

        let rendered = render_review_prompt_from_config_dir(&review, "PR #42", &config_dir)
            .expect("built-in template renders");

        assert!(
            rendered.contains("branch `feature/diff-review`"),
            "{rendered}"
        );
        assert!(
            rendered.contains("src/lib.rs:20 (old): remove dead code"),
            "{rendered}"
        );
    }

    #[test]
    fn render_review_prompt_reports_an_unreadable_template() {
        let root = fixture_root();
        let config_dir = root.path().join("config");
        // A directory at the template path is neither absent nor readable.
        std::fs::create_dir_all(config_dir.join("prompts").join("review.tmpl"))
            .expect("create directory in place of the template");

        let err = render_review_prompt_from_config_dir(&sample_review(), "PR #42", &config_dir)
            .expect_err("unreadable template must error");

        assert!(matches!(err, CoreError::ReviewTemplateIo { .. }), "{err:?}");
    }

    #[test]
    fn render_review_prompt_rejects_unknown_variables_in_an_installed_template() {
        let root = fixture_root();
        let config_dir = root.path().join("config");
        let prompts_dir = config_dir.join("prompts");
        std::fs::create_dir_all(&prompts_dir).expect("create prompts dir");
        std::fs::write(prompts_dir.join("review.tmpl"), "${nope}").expect("write review.tmpl");

        let err = render_review_prompt_from_config_dir(&sample_review(), "PR #42", &config_dir)
            .expect_err("unknown variable rejected");

        assert!(
            matches!(err, CoreError::UnknownReviewPromptVariables(_)),
            "{err:?}"
        );
    }

    #[test]
    fn review_session_metadata_copies_links_and_stamps_the_given_instant() {
        let source = BTreeMap::from([
            ("link.provider".to_owned(), "github".to_owned()),
            ("unrelated".to_owned(), "dropped".to_owned()),
        ]);

        let metadata =
            review_session_metadata(&source, "review-1", datetime!(2026-10-01 08:00:00 UTC));

        assert_eq!(
            metadata,
            BTreeMap::from([
                ("link.provider".to_owned(), "github".to_owned()),
                (REVIEW_SOURCE_KEY.to_owned(), "review-1".to_owned()),
                (
                    REVIEW_DISPATCHED_AT_KEY.to_owned(),
                    "2026-10-01T08:00:00Z".to_owned()
                ),
            ])
        );
    }
}
