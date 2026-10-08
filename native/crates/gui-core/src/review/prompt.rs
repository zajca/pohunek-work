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
