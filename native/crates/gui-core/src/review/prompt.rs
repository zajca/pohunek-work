//! Review prompt templating.
//!
//! A review prompt is rendered from a `${var}` template and a fixed context of
//! five variables: `provider` (always `review`), `branch`, `source`,
//! `comments` and `comment_count`. The renderer is independent of the core
//! prompt crate, which only knows provider work items.

// Rust guideline compliant 2026-10-03

use std::collections::{BTreeMap, BTreeSet};

use super::model::{Review, ReviewComment};
use crate::CoreError;

/// Template used when the host config directory holds no `prompts/review.tmpl`.
pub(super) const DEFAULT_REVIEW_TEMPLATE: &str = include_str!("review.tmpl");

/// Value of the `${provider}` variable.
const REVIEW_PROVIDER: &str = "review";

/// Variable context of a review prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ReviewPromptContext {
    pub(super) branch: String,
    pub(super) source: String,
    /// Pre-rendered `path:line (side): text` blocks; empty when there are none.
    pub(super) comments: String,
    pub(super) comment_count: usize,
}

impl ReviewPromptContext {
    /// Builds the context for `review`, described to the agent as
    /// `source_description`.
    pub(super) fn new(review: &Review, source_description: &str) -> Self {
        Self {
            branch: review.branch.clone(),
            source: source_description.to_owned(),
            comments: review
                .comments
                .iter()
                .map(render_comment_block)
                .collect::<Vec<_>>()
                .join("\n\n"),
            comment_count: review.comments.len(),
        }
    }

    fn variables(&self) -> Result<BTreeMap<&'static str, String>, CoreError> {
        let required = |field: &'static str, value: &str| {
            if value.is_empty() {
                Err(CoreError::MissingReviewPromptField { field })
            } else {
                Ok(value.to_owned())
            }
        };
        Ok(BTreeMap::from([
            ("provider", REVIEW_PROVIDER.to_owned()),
            ("branch", required("branch", &self.branch)?),
            ("source", required("source", &self.source)?),
            ("comments", self.comments.clone()),
            ("comment_count", self.comment_count.to_string()),
        ]))
    }
}

pub(super) fn render_comment_block(comment: &ReviewComment) -> String {
    format!(
        "{}:{} ({}): {}",
        comment.path,
        comment.line,
        comment.side.as_str(),
        comment.text
    )
}

/// Renders `template` against `context`.
///
/// Substitution is single-pass: a context value containing `${name}` is copied
/// literally and never expanded again.
///
/// # Errors
///
/// Returns [`CoreError::MissingReviewPromptField`] when `branch` or `source` is
/// empty and [`CoreError::UnknownReviewPromptVariables`] when the template
/// references a variable outside the context.
pub(super) fn render_review_template(
    template: &str,
    context: &ReviewPromptContext,
) -> Result<String, CoreError> {
    let variables = context.variables()?;
    let unknown: Vec<String> = placeholders(template)
        .into_iter()
        .filter(|name| !variables.contains_key(name.as_str()))
        .collect();
    if !unknown.is_empty() {
        return Err(CoreError::UnknownReviewPromptVariables(unknown));
    }
    Ok(substitute(template, &variables))
}

/// One piece of a template.
enum Segment<'a> {
    Text(&'a str),
    Variable(&'a str),
}

/// Splits `template` into literal text and `${name}` references with a valid
/// variable name; malformed references stay literal.
fn segments(template: &str) -> Vec<Segment<'_>> {
    let mut parts = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find("${") {
        let after_start = &rest[start + 2..];
        let Some(end) = after_start.find('}') else {
            break;
        };
        let name = &after_start[..end];
        if is_variable_name(name) {
            parts.push(Segment::Text(&rest[..start]));
            parts.push(Segment::Variable(name));
        } else {
            parts.push(Segment::Text(&rest[..=start + 2 + end]));
        }
        rest = &after_start[end + 1..];
    }
    parts.push(Segment::Text(rest));
    parts
}

fn placeholders(template: &str) -> BTreeSet<String> {
    segments(template)
        .into_iter()
        .filter_map(|segment| match segment {
            Segment::Variable(name) => Some(name.to_owned()),
            Segment::Text(_) => None,
        })
        .collect()
}

fn substitute(template: &str, variables: &BTreeMap<&'static str, String>) -> String {
    segments(template)
        .into_iter()
        .map(|segment| match segment {
            Segment::Text(text) => text,
            Segment::Variable(name) => variables.get(name).map_or("", String::as_str),
        })
        .collect()
}

fn is_variable_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::{
        render_comment_block, render_review_template, ReviewPromptContext, DEFAULT_REVIEW_TEMPLATE,
    };
    use crate::review::model::{ReviewComment, ReviewSide};
    use crate::CoreError;

    fn context() -> ReviewPromptContext {
        ReviewPromptContext {
            branch: "feature/diff-review".to_owned(),
            source: "PR #42".to_owned(),
            comments: "src/lib.rs:10 (new): fix this\nsrc/lib.rs:20 (old): remove dead code"
                .to_owned(),
            comment_count: 2,
        }
    }

    #[test]
    fn comment_block_matches_the_documented_format() {
        let comment = ReviewComment::new("src/lib.rs", ReviewSide::New, 10, "fix this");
        assert_eq!(
            render_comment_block(&comment),
            "src/lib.rs:10 (new): fix this"
        );
    }

    #[test]
    fn golden_render_substitutes_every_variable() {
        let rendered = render_review_template(
            "Review of ${source} on branch ${branch} (${comment_count} comments, ${provider}):\n${comments}\n",
            &context(),
        )
        .expect("render");

        assert_eq!(
            rendered,
            "Review of PR #42 on branch feature/diff-review (2 comments, review):\n\
             src/lib.rs:10 (new): fix this\nsrc/lib.rs:20 (old): remove dead code\n"
        );
    }

    #[test]
    fn empty_comments_render_as_empty_string() {
        let mut ctx = context();
        ctx.comments.clear();
        ctx.comment_count = 0;

        let rendered = render_review_template("[${comments}]", &ctx).expect("render");

        assert_eq!(rendered, "[]");
    }

    #[test]
    fn values_containing_placeholders_are_not_expanded_again() {
        let mut ctx = context();
        ctx.comments = "literal ${branch}".to_owned();

        let rendered = render_review_template("${comments}", &ctx).expect("render");

        assert_eq!(rendered, "literal ${branch}");
    }

    #[test]
    fn unknown_variables_are_rejected() {
        let err = render_review_template("${nope} ${branch} ${other}", &context())
            .expect_err("unknown variables rejected");

        assert!(matches!(
            err,
            CoreError::UnknownReviewPromptVariables(names) if names == vec!["nope", "other"]
        ));
    }

    #[test]
    fn malformed_references_stay_literal() {
        let rendered = render_review_template("${} ${1x} ${a-b} ${branch} ${open", &context())
            .expect("render");

        assert_eq!(rendered, "${} ${1x} ${a-b} feature/diff-review ${open");
    }

    #[test]
    fn missing_branch_and_source_are_rejected() {
        let mut ctx = context();
        ctx.branch.clear();
        assert!(matches!(
            render_review_template("${branch}", &ctx),
            Err(CoreError::MissingReviewPromptField { field: "branch" })
        ));

        let mut ctx = context();
        ctx.source.clear();
        assert!(matches!(
            render_review_template("${source}", &ctx),
            Err(CoreError::MissingReviewPromptField { field: "source" })
        ));
    }

    #[test]
    fn default_template_renders_against_its_own_context() {
        let rendered = render_review_template(DEFAULT_REVIEW_TEMPLATE, &context())
            .expect("default template only uses known variables");

        assert!(
            rendered.contains("review of branch `feature/diff-review`"),
            "{rendered}"
        );
        assert!(rendered.contains("PR #42"), "{rendered}");
        assert!(rendered.contains("fix this"), "{rendered}");
        assert!(rendered.contains("Review comments (2)"), "{rendered}");
    }
}
