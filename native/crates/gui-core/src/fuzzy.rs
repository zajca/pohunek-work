//! Fuzzy matching for launch pickers.
//!
//! A query is split on whitespace and every token must match the candidate as
//! a case-insensitive subsequence, so `wid dev` finds `widgets  ·  dev-box`
//! regardless of word order. Tokens that match contiguously, at the start of
//! the candidate or at word starts rank higher.

// Rust guideline compliant 2026-10-01

/// Score every matched character earns.
const MATCH_SCORE: u32 = 1;
/// Extra score for a character that directly follows the previous match.
const CONSECUTIVE_BONUS: u32 = 4;
/// Extra score for a character that starts a word (after a non-alphanumeric
/// character) or the candidate.
const WORD_START_BONUS: u32 = 6;
/// Extra score when the whole token occurs as one contiguous run; outweighs
/// the scattered-subsequence bonuses so exact fragments rank first.
const CONTIGUOUS_BONUS: u32 = 20;
/// Extra score when a contiguous token run begins the candidate.
const PREFIX_BONUS: u32 = 10;

/// Scores `candidate` against `query`; `None` when any query token does not
/// match. An empty query matches everything with score `0`.
#[must_use]
pub fn fuzzy_score(query: &str, candidate: &str) -> Option<u32> {
    let candidate: Vec<char> = candidate.chars().flat_map(char::to_lowercase).collect();
    let mut total = 0_u32;
    for token in query.split_whitespace() {
        let token: Vec<char> = token.chars().flat_map(char::to_lowercase).collect();
        total = total.saturating_add(token_score(&token, &candidate)?);
    }
    Some(total)
}

fn token_score(token: &[char], candidate: &[char]) -> Option<u32> {
    let subsequence = subsequence_score(token, candidate)?;
    let contiguous = contiguous_position(token, candidate).map_or(0, |position| {
        CONTIGUOUS_BONUS + if position == 0 { PREFIX_BONUS } else { 0 }
    });
    Some(subsequence + contiguous)
}

/// Greedy left-to-right subsequence match; `None` when `token` is not a
/// subsequence of `candidate`.
fn subsequence_score(token: &[char], candidate: &[char]) -> Option<u32> {
    let mut score = 0_u32;
    let mut cursor = 0_usize;
    let mut previous: Option<usize> = None;
    for needle in token {
        let offset = candidate[cursor..].iter().position(|ch| ch == needle)?;
        let index = cursor + offset;
        score += MATCH_SCORE;
        if previous.is_some_and(|prev| prev + 1 == index) {
            score += CONSECUTIVE_BONUS;
        }
        if index == 0 || !candidate[index - 1].is_alphanumeric() {
            score += WORD_START_BONUS;
        }
        previous = Some(index);
        cursor = index + 1;
    }
    Some(score)
}

fn contiguous_position(token: &[char], candidate: &[char]) -> Option<usize> {
    if token.is_empty() {
        return None;
    }
    candidate
        .windows(token.len())
        .position(|window| window == token)
}

/// Indices of the `candidates` that match `query`, best match first. Equal
/// scores keep their original order, and an empty query keeps every index in
/// the original order.
#[must_use]
pub fn fuzzy_rank<'a>(query: &str, candidates: impl IntoIterator<Item = &'a str>) -> Vec<usize> {
    let mut scored: Vec<(usize, u32)> = candidates
        .into_iter()
        .enumerate()
        .filter_map(|(index, candidate)| fuzzy_score(query, candidate).map(|score| (index, score)))
        .collect();
    scored.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
    scored.into_iter().map(|(index, _)| index).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_query_keeps_every_candidate_in_order() {
        assert_eq!(fuzzy_rank("", ["b", "a", "c"]), [0, 1, 2]);
        assert_eq!(fuzzy_rank("   ", ["b", "a"]), [0, 1]);
    }

    #[test]
    fn matching_ignores_case_and_requires_subsequence_order() {
        assert!(fuzzy_score("WDG", "widgets").is_some());
        assert!(fuzzy_score("gdw", "widgets").is_none());
        assert!(fuzzy_score("zzz", "widgets").is_none());
    }

    #[test]
    fn tokens_match_in_any_order() {
        assert!(fuzzy_score("dev wid", "widgets  ·  dev-box").is_some());
        assert!(fuzzy_score("dev nope", "widgets  ·  dev-box").is_none());
    }

    #[test]
    fn contiguous_and_prefix_matches_rank_first() {
        let candidates = ["my-widget-shop", "widgets", "w-i-d-g-e-t"];
        assert_eq!(fuzzy_rank("widget", candidates), [1, 0, 2]);
    }

    #[test]
    fn equal_scores_keep_original_order() {
        assert_eq!(fuzzy_rank("a", ["a1", "a2", "a3"]), [0, 1, 2]);
    }

    #[test]
    fn non_matching_candidates_are_dropped() {
        assert_eq!(fuzzy_rank("api", ["web", "api-gateway", "rapid"]), [1, 2]);
    }
}
