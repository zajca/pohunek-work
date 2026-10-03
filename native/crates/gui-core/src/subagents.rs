//! Nesting of a session's observed subagents for display.

// Rust guideline compliant 2026-10-03

use std::collections::HashMap;

use protocol::{AgentKind, SubagentInfo, SubagentLifecycle};

/// One subagent placed in the display tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SubagentNode<'a> {
    pub info: &'a SubagentInfo,
    /// Distance from the root of its tree; a root has depth 0.
    pub depth: usize,
}

/// Running and total subagent counts of one session.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SubagentCounts {
    pub running: usize,
    pub total: usize,
}

/// Counts the running and the observed subagents.
#[must_use]
pub fn subagent_counts(subagents: &[SubagentInfo]) -> SubagentCounts {
    SubagentCounts {
        running: subagents
            .iter()
            .filter(|subagent| subagent.lifecycle == SubagentLifecycle::Running)
            .count(),
        total: subagents.len(),
    }
}

/// Orders `subagents` depth-first so every child follows its parent.
///
/// A subagent is identified by `(provider, id)`; `parent_id` refers to an id of
/// the same provider. The list holds only current and recent subagents, so a
/// subagent whose parent is not in it becomes a root, as does one that names
/// itself. Siblings are ordered by start time, then id. Subagents on a parent
/// cycle are appended as roots, so every input appears exactly once.
#[must_use]
pub fn subagent_tree(subagents: &[SubagentInfo]) -> Vec<SubagentNode<'_>> {
    let index: HashMap<(&AgentKind, &str), usize> = subagents
        .iter()
        .enumerate()
        .map(|(position, subagent)| ((&subagent.provider, subagent.id.as_str()), position))
        .collect();
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); subagents.len()];
    let mut roots = Vec::new();
    for (position, subagent) in subagents.iter().enumerate() {
        let parent = subagent
            .parent_id
            .as_deref()
            .and_then(|parent_id| index.get(&(&subagent.provider, parent_id)))
            .copied()
            .filter(|parent| *parent != position);
        match parent {
            Some(parent) => children[parent].push(position),
            None => roots.push(position),
        }
    }
    let order = |left: &usize, right: &usize| {
        let (left, right) = (&subagents[*left], &subagents[*right]);
        left.started_at_ms
            .cmp(&right.started_at_ms)
            .then_with(|| left.id.cmp(&right.id))
    };
    roots.sort_by(order);
    for siblings in &mut children {
        siblings.sort_by(order);
    }

    let mut placed = vec![false; subagents.len()];
    let mut nodes = Vec::with_capacity(subagents.len());
    for root in roots {
        place_subtree(root, subagents, &children, &mut placed, &mut nodes);
    }
    // Only members of a parent cycle are still unplaced here.
    let mut cyclic: Vec<usize> = (0..subagents.len()).filter(|p| !placed[*p]).collect();
    cyclic.sort_by(order);
    for root in cyclic {
        place_subtree(root, subagents, &children, &mut placed, &mut nodes);
    }
    nodes
}

/// Appends `root` and its not yet placed descendants to `nodes`, depth first.
fn place_subtree<'a>(
    root: usize,
    subagents: &'a [SubagentInfo],
    children: &[Vec<usize>],
    placed: &mut [bool],
    nodes: &mut Vec<SubagentNode<'a>>,
) {
    let mut stack = vec![(root, 0_usize)];
    while let Some((position, depth)) = stack.pop() {
        if std::mem::replace(&mut placed[position], true) {
            continue;
        }
        nodes.push(SubagentNode {
            info: &subagents[position],
            depth,
        });
        stack.extend(
            children[position]
                .iter()
                .rev()
                .map(|child| (*child, depth + 1)),
        );
    }
}

#[cfg(test)]
mod tests {
    use protocol::SubagentRevision;

    use super::*;

    fn subagent(provider: AgentKind, id: &str, parent: Option<&str>, started: u64) -> SubagentInfo {
        SubagentInfo {
            id: id.to_owned(),
            parent_id: parent.map(str::to_owned),
            provider,
            agent_type: None,
            lifecycle: SubagentLifecycle::Running,
            activity: None,
            revision: SubagentRevision::new(1),
            started_at_ms: started,
            updated_at_ms: started,
            finished_at_ms: None,
        }
    }

    fn shape(nodes: &[SubagentNode<'_>]) -> Vec<(String, usize)> {
        nodes
            .iter()
            .map(|node| (node.info.id.clone(), node.depth))
            .collect()
    }

    #[test]
    fn children_follow_their_parent_in_start_order() {
        let list = [
            subagent(AgentKind::Claude, "child-b", Some("root"), 30),
            subagent(AgentKind::Claude, "grandchild", Some("child-a"), 40),
            subagent(AgentKind::Claude, "root", None, 10),
            subagent(AgentKind::Claude, "child-a", Some("root"), 20),
        ];

        assert_eq!(
            shape(&subagent_tree(&list)),
            [
                ("root".to_owned(), 0),
                ("child-a".to_owned(), 1),
                ("grandchild".to_owned(), 2),
                ("child-b".to_owned(), 1),
            ]
        );
    }

    #[test]
    fn a_missing_or_own_parent_makes_a_root() {
        let list = [
            subagent(AgentKind::Claude, "orphan", Some("evicted"), 10),
            subagent(AgentKind::Claude, "selfish", Some("selfish"), 20),
        ];

        assert_eq!(
            shape(&subagent_tree(&list)),
            [("orphan".to_owned(), 0), ("selfish".to_owned(), 0)]
        );
    }

    #[test]
    fn a_parent_cycle_still_lists_every_subagent_once() {
        let list = [
            subagent(AgentKind::Claude, "a", Some("b"), 10),
            subagent(AgentKind::Claude, "b", Some("a"), 20),
            subagent(AgentKind::Claude, "free", None, 5),
        ];

        let nodes = subagent_tree(&list);

        assert_eq!(nodes.len(), 3);
        assert_eq!(nodes[0].info.id, "free");
        let mut ids: Vec<&str> = nodes.iter().map(|node| node.info.id.as_str()).collect();
        ids.sort_unstable();
        assert_eq!(ids, ["a", "b", "free"]);
    }

    #[test]
    fn the_same_id_under_two_providers_is_two_subagents() {
        let list = [
            subagent(AgentKind::Claude, "shared", None, 10),
            subagent(AgentKind::Codex, "shared", None, 20),
            subagent(AgentKind::Codex, "kid", Some("shared"), 30),
        ];

        let nodes = subagent_tree(&list);

        assert_eq!(
            nodes
                .iter()
                .map(|node| (node.info.provider.clone(), node.depth))
                .collect::<Vec<_>>(),
            [
                (AgentKind::Claude, 0),
                (AgentKind::Codex, 0),
                (AgentKind::Codex, 1)
            ]
        );
    }

    #[test]
    fn counts_only_running_subagents_as_running() {
        let mut done = subagent(AgentKind::Claude, "done", None, 10);
        done.lifecycle = SubagentLifecycle::Completed;
        let list = [done, subagent(AgentKind::Claude, "live", None, 20)];

        assert_eq!(
            subagent_counts(&list),
            SubagentCounts {
                running: 1,
                total: 2
            }
        );
    }
}
