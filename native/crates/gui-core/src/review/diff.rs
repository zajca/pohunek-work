//! Unified-diff parsing shared by `session.diff` and `gh pr diff` output.

// Rust guideline compliant 2026-07-19

/// One parsed unified diff: the ordered list of files it touches.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DiffModel {
    /// Files touched by the diff, in the order they appear in the source text.
    pub files: Vec<DiffFile>,
}

/// One file's diff: its path, change kind, and hunks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffFile {
    /// Current path (the pre-image path for a deleted file).
    pub path: String,
    /// How this file changed.
    pub status: DiffFileStatus,
    /// Hunks of changed lines. Empty for a pure rename, a mode-only change,
    /// or a binary file.
    pub hunks: Vec<DiffHunk>,
}

/// How one file changed between the diff's two sides.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffFileStatus {
    /// Content changed (including a mode-only change, which has no hunks).
    Modified,
    /// The file exists only on the new side (including an untracked file
    /// diffed against `/dev/null`).
    Added,
    /// The file exists only on the old side.
    Deleted,
    /// The file moved from `old_path` to [`DiffFile::path`].
    Renamed {
        /// Path before the rename.
        old_path: String,
    },
    /// Git reported this file as binary (`Binary files ... differ`); no
    /// textual hunks are available.
    ///
    /// Literal `GIT binary patch` payload (emitted only with `git diff
    /// --binary`) is not parsed: neither `session.diff` (plain `git diff
    /// --no-color`, no `--binary`) nor `gh pr diff` requests it, so it is
    /// never expected on either supported source. If it ever appeared, the
    /// patch body lines match no recognized line prefix and are silently
    /// skipped, leaving the file binary with zero hunks — graceful
    /// degradation, not a panic.
    Binary,
}

/// One `@@ ... @@` hunk and its lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffHunk {
    /// Full hunk header line, including the optional trailing section heading.
    pub header: String,
    /// Lines in this hunk, in source order.
    pub lines: Vec<DiffLine>,
}

/// One line inside a hunk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffLine {
    /// Whether this line is context, an addition, or a removal.
    pub kind: DiffLineKind,
    /// Line number on the old side, or `None` for an added line.
    pub old_line: Option<u32>,
    /// Line number on the new side, or `None` for a removed line.
    pub new_line: Option<u32>,
    /// Line text with the leading `+`/`-`/` ` marker stripped.
    pub text: String,
    /// Whether a following `\ No newline at end of file` marker applied to
    /// this line.
    pub no_newline_at_eof: bool,
}

/// Kind of one hunk line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffLineKind {
    /// Unchanged line shown for context.
    Context,
    /// Line present only on the new side.
    Add,
    /// Line present only on the old side.
    Remove,
}

/// Parses unified-diff text into a [`DiffModel`].
///
/// Accepts identically shaped text from `session.diff`'s daemon-generated
/// `git diff`/`git diff --no-index` output and from `gh pr diff` — both emit
/// the same unified-diff format, so this is the single parser for both
/// sources. Handles renamed, added (including untracked-as-added via
/// `--- /dev/null`), deleted, binary, and mode-change-only files, plus a
/// `\ No newline at end of file` marker.
///
/// Never panics. The daemon promises `session.diff` truncation only cuts at a
/// *file* boundary, but this parser also serves `gh pr diff`, which makes no
/// such promise, so it is defensive either way: a hunk cut short mid-file
/// simply yields whatever lines were present before the cut (each line access
/// is bounds-checked, never indexed unconditionally), and every file
/// preceding the cut is kept in full.
#[must_use]
pub fn parse_unified_diff(text: &str) -> DiffModel {
    let lines: Vec<&str> = text.lines().collect();
    let mut files = Vec::new();
    let mut index = 0;

    while index < lines.len() {
        if !lines[index].starts_with("diff --git ") {
            index += 1;
            continue;
        }
        let diff_git_line = lines[index];
        index += 1;
        let (mut old_path, mut new_path) = parse_diff_git_line(diff_git_line).unwrap_or_default();
        let (is_rename, is_binary) =
            parse_file_header(&lines, &mut index, &mut old_path, &mut new_path);
        let hunks = parse_hunks(&lines, &mut index);

        let status = diff_file_status(&old_path, &new_path, is_rename, is_binary);
        let path = canonical_path(&old_path, &new_path);
        if !path.is_empty() {
            files.push(DiffFile {
                path,
                status,
                hunks,
            });
        }
    }

    DiffModel { files }
}

/// Consumes one file segment's header lines (index/mode/rename/`---`/`+++`/
/// binary), stopping at the first hunk header or the next file. Updates
/// `old_path`/`new_path` in place as more specific lines override the
/// `diff --git` line's fallback values. Returns `(is_rename, is_binary)`.
fn parse_file_header(
    lines: &[&str],
    index: &mut usize,
    old_path: &mut String,
    new_path: &mut String,
) -> (bool, bool) {
    let mut is_rename = false;
    let mut is_binary = false;
    while *index < lines.len() {
        let line = lines[*index];
        if line.starts_with("diff --git ") || line.starts_with("@@ ") {
            break;
        }
        *index += 1;
        if let Some(path) = line.strip_prefix("rename from ") {
            path.clone_into(old_path);
            is_rename = true;
        } else if let Some(path) = line.strip_prefix("rename to ") {
            path.clone_into(new_path);
            is_rename = true;
        } else if let Some(path) = line.strip_prefix("--- ") {
            *old_path = strip_ab_prefix(path, "a/");
        } else if let Some(path) = line.strip_prefix("+++ ") {
            *new_path = strip_ab_prefix(path, "b/");
        } else if let Some(rest) = line
            .strip_prefix("Binary files ")
            .and_then(|rest| rest.strip_suffix(" differ"))
        {
            is_binary = true;
            if let Some((left, right)) = rest.split_once(" and ") {
                *old_path = strip_ab_prefix(left, "a/");
                *new_path = strip_ab_prefix(right, "b/");
            }
        }
    }
    (is_rename, is_binary)
}

/// Consumes one file segment's `@@ ... @@` hunks and their +/-/context lines,
/// stopping at the next file. Never panics on a hunk cut short mid-file: a
/// trailing hunk with fewer lines than its header claims is still returned
/// with whatever lines were present.
fn parse_hunks(lines: &[&str], index: &mut usize) -> Vec<DiffHunk> {
    let mut hunks = Vec::new();
    let mut current: Option<(DiffHunk, u32, u32)> = None;
    while *index < lines.len() {
        let line = lines[*index];
        if line.starts_with("diff --git ") {
            break;
        }
        *index += 1;
        if let Some(header) = line.strip_prefix("@@ ") {
            if let Some((hunk, ..)) = current.take() {
                hunks.push(hunk);
            }
            let (old_start, new_start) = parse_hunk_start(header).unwrap_or((0, 0));
            current = Some((
                DiffHunk {
                    header: line.to_owned(),
                    lines: Vec::new(),
                },
                old_start,
                new_start,
            ));
            continue;
        }
        let Some((hunk, old_cursor, new_cursor)) = current.as_mut() else {
            // Stray line before any hunk header in this file (shouldn't
            // happen for well-formed input); ignore rather than panic.
            continue;
        };
        if line.starts_with('\\') {
            if let Some(last) = hunk.lines.last_mut() {
                last.no_newline_at_eof = true;
            }
            continue;
        }
        push_hunk_line(hunk, line, old_cursor, new_cursor);
    }
    if let Some((hunk, ..)) = current.take() {
        hunks.push(hunk);
    }
    hunks
}

/// Classifies and appends one hunk body line, advancing the old/new line
/// cursors that track its position on each side.
fn push_hunk_line(hunk: &mut DiffHunk, line: &str, old_cursor: &mut u32, new_cursor: &mut u32) {
    let (kind, body) = if let Some(body) = line.strip_prefix('+') {
        (DiffLineKind::Add, body)
    } else if let Some(body) = line.strip_prefix('-') {
        (DiffLineKind::Remove, body)
    } else if let Some(body) = line.strip_prefix(' ') {
        (DiffLineKind::Context, body)
    } else if line.is_empty() {
        (DiffLineKind::Context, line)
    } else {
        return;
    };
    let (old_line, new_line) = match kind {
        DiffLineKind::Add => {
            let value = *new_cursor;
            *new_cursor += 1;
            (None, Some(value))
        }
        DiffLineKind::Remove => {
            let value = *old_cursor;
            *old_cursor += 1;
            (Some(value), None)
        }
        DiffLineKind::Context => {
            let old_value = *old_cursor;
            let new_value = *new_cursor;
            *old_cursor += 1;
            *new_cursor += 1;
            (Some(old_value), Some(new_value))
        }
    };
    hunk.lines.push(DiffLine {
        kind,
        old_line,
        new_line,
        text: body.to_owned(),
        no_newline_at_eof: false,
    });
}

/// Extracts the fallback `(old_path, new_path)` pair from a `diff --git a/X
/// b/Y` line. Overridden by `--- `/`+++ `/rename/binary lines when present;
/// this is only the fallback for the rare segment that has none of those
/// (e.g. a mode-only change).
fn parse_diff_git_line(line: &str) -> Option<(String, String)> {
    let rest = line.strip_prefix("diff --git ")?;
    let rest = rest.strip_prefix("a/").unwrap_or(rest);
    // Paths are not `diff --git`-escaped for spaces, so this is a heuristic:
    // find the last " b/" separator. A path literally containing " b/" would
    // mis-split here, same ambiguity every line-based diff parser accepts.
    let split_at = rest.rfind(" b/")?;
    Some((rest[..split_at].to_owned(), rest[split_at + 3..].to_owned()))
}

fn strip_ab_prefix(path: &str, prefix: &str) -> String {
    path.strip_prefix(prefix).unwrap_or(path).to_owned()
}

/// Parses the old/new start line numbers from a hunk header's text after the
/// leading `"@@ "`, e.g. `"-12,7 +12,9 @@ fn foo() {"`.
fn parse_hunk_start(header_rest: &str) -> Option<(u32, u32)> {
    let rest = header_rest.strip_prefix('-')?;
    let (old_part, rest) = rest.split_once(' ')?;
    let rest = rest.strip_prefix('+')?;
    let new_part = rest.split_whitespace().next()?;
    Some((parse_range_start(old_part)?, parse_range_start(new_part)?))
}

fn parse_range_start(part: &str) -> Option<u32> {
    part.split(',').next()?.parse().ok()
}

fn diff_file_status(
    old_path: &str,
    new_path: &str,
    is_rename: bool,
    is_binary: bool,
) -> DiffFileStatus {
    if is_rename && old_path != new_path {
        return DiffFileStatus::Renamed {
            old_path: old_path.to_owned(),
        };
    }
    if is_binary {
        return DiffFileStatus::Binary;
    }
    if old_path == "/dev/null" {
        return DiffFileStatus::Added;
    }
    if new_path == "/dev/null" {
        return DiffFileStatus::Deleted;
    }
    DiffFileStatus::Modified
}

fn canonical_path(old_path: &str, new_path: &str) -> String {
    if !new_path.is_empty() && new_path != "/dev/null" {
        new_path.to_owned()
    } else if !old_path.is_empty() {
        old_path.to_owned()
    } else {
        String::new()
    }
}
