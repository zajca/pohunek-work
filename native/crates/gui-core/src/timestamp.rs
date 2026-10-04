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

#[cfg(test)]
mod tests {
    use super::cmp_rfc3339;
    use std::cmp::Ordering;

    #[test]
    fn a_later_fractional_instant_orders_after_an_earlier_whole_second_one() {
        let whole = "2026-10-01T08:00:05Z";
        let fractional = "2026-10-01T08:00:05.5Z";

        // The raw strings order the wrong way round: '.' (0x2E) < 'Z' (0x5A).
        assert!(fractional < whole);
        assert_eq!(cmp_rfc3339(whole, fractional), Ordering::Less);
        assert_eq!(cmp_rfc3339(fractional, whole), Ordering::Greater);
    }

    #[test]
    fn offsets_are_normalised_to_the_instant() {
        let utc = "2026-10-01T08:00:00Z";
        let plus_two_earlier = "2026-10-01T09:30:00+02:00";

        assert_eq!(cmp_rfc3339(plus_two_earlier, utc), Ordering::Less);
    }

    #[test]
    fn unparseable_stamps_order_before_valid_ones_and_the_order_is_total() {
        let valid = "1970-01-01T00:00:00Z";

        assert_eq!(cmp_rfc3339("garbage", valid), Ordering::Less);
        assert_eq!(cmp_rfc3339(valid, "garbage"), Ordering::Greater);
        assert_eq!(cmp_rfc3339("a", "b"), Ordering::Less);
        assert_eq!(cmp_rfc3339(valid, valid), Ordering::Equal);
    }

    #[test]
    fn equal_instants_with_different_spelling_have_a_stable_order() {
        let left = "2026-10-01T08:00:05Z";
        let right = "2026-10-01T08:00:05.0Z";

        assert_eq!(cmp_rfc3339(left, right), left.cmp(right));
        assert_eq!(cmp_rfc3339(right, left), right.cmp(left));
    }
}
