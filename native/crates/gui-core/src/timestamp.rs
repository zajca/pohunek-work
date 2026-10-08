//! Ordering of RFC 3339 timestamp strings.
//!
//! RFC 3339 strings of different shape do not order lexically: the format
//! omits trailing zero fraction digits, so `…:05.5Z` sorts before `…:05Z`
//! although it is the later instant. Timestamps produced by other processes or
//! persisted by earlier runs carry arbitrary precision and offsets, so every
//! ordering decision goes through [`cmp_rfc3339`].

// Rust guideline compliant 2026-10-01

use std::cmp::Ordering;

use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

/// Orders two RFC 3339 timestamp strings by the instant they denote.
///
/// A string that does not parse orders before every valid timestamp, so a
/// corrupt stamp never wins a "latest" selection. Equal instants, and
/// unparseable strings, fall back to the raw string comparison, which keeps
/// the order total and deterministic.
#[must_use]
pub(crate) fn cmp_rfc3339(left: &str, right: &str) -> Ordering {
    let left_instant = OffsetDateTime::parse(left, &Rfc3339).ok();
    let right_instant = OffsetDateTime::parse(right, &Rfc3339).ok();
    left_instant
        .cmp(&right_instant)
        .then_with(|| left.cmp(right))
}
