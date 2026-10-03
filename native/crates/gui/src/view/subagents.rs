//! Tree of the subagents a session has spawned.

// Rust guideline compliant 2026-10-03

use std::time::{SystemTime, UNIX_EPOCH};

use iced::widget::{column, row, space, text};
use iced::{Center, Element};
use pohunek_gui_core::{subagent_counts, subagent_tree, SubagentNode};
use protocol::{AgentActivity, SubagentInfo, SubagentLifecycle};

use crate::message::Message;

use super::{agent_kind_label, card, muted_style, selectable_text, status_pill, PillTone};

/// Horizontal indent per nesting level.
const INDENT_PER_LEVEL: f32 = 18.0;

const MILLIS_PER_SECOND: u64 = 1000;
const SECONDS_PER_MINUTE: u64 = 60;
const SECONDS_PER_HOUR: u64 = 3600;

/// Subagents of a session: a summary line and one nested row per subagent.
pub(crate) fn subagent_view(subagents: &[SubagentInfo]) -> Element<'static, Message> {
    let counts = subagent_counts(subagents);
    let mut content = column![text(format!(
        "Subagents · {} running · {} recent",
        counts.running, counts.total
    ))
    .size(14)]
    .spacing(4);
    if subagents.is_empty() {
        content = content.push(text("No observed subagents.").size(12).style(muted_style));
    } else {
        let now_ms = now_millis();
        for node in subagent_tree(subagents) {
            content = content.push(subagent_row(&node, now_ms));
        }
    }
    card(content)
}

fn subagent_row(node: &SubagentNode<'_>, now_ms: u64) -> Element<'static, Message> {
    let info = node.info;
    let depth = u16::try_from(node.depth).map_or(f32::MAX, f32::from);
    let mut meta = agent_kind_label(&info.provider);
    if let Some(activity) = info
        .activity
        .filter(|_| info.lifecycle == SubagentLifecycle::Running)
    {
        meta.push_str("  ·  ");
        meta.push_str(activity_label(activity));
    }
    meta.push_str("  ·  ");
    meta.push_str(&elapsed_label(info, now_ms));
    row![
        space().width(depth * INDENT_PER_LEVEL),
        status_pill(
            lifecycle_label(info.lifecycle),
            lifecycle_tone(info.lifecycle)
        ),
        text(
            info.agent_type
                .clone()
                .unwrap_or_else(|| "agent".to_owned())
        )
        .size(13),
        selectable_text(meta).size(12),
        selectable_text(info.id.clone()).size(11),
    ]
    .spacing(8)
    .align_y(Center)
    .into()
}

const fn lifecycle_label(lifecycle: SubagentLifecycle) -> &'static str {
    match lifecycle {
        SubagentLifecycle::Running => "working",
        SubagentLifecycle::Completed => "completed",
        SubagentLifecycle::Failed => "failed",
        SubagentLifecycle::Cancelled => "cancelled",
        SubagentLifecycle::Lost => "lost",
    }
}

const fn lifecycle_tone(lifecycle: SubagentLifecycle) -> PillTone {
    match lifecycle {
        SubagentLifecycle::Running => PillTone::Success,
        SubagentLifecycle::Completed => PillTone::Neutral,
        SubagentLifecycle::Failed => PillTone::Danger,
        SubagentLifecycle::Cancelled | SubagentLifecycle::Lost => PillTone::Warning,
    }
}

const fn activity_label(activity: AgentActivity) -> &'static str {
    match activity {
        AgentActivity::Idle => "ready",
        AgentActivity::Working => "busy",
        AgentActivity::Blocked => "waiting for input",
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

/// Run time of a finished subagent, or age of a running one.
fn elapsed_label(info: &SubagentInfo, now_ms: u64) -> String {
    let end = match info.lifecycle {
        SubagentLifecycle::Running => now_ms,
        _ => info.finished_at_ms.unwrap_or(info.updated_at_ms),
    };
    let label = duration_label(end.saturating_sub(info.started_at_ms));
    if info.lifecycle == SubagentLifecycle::Running {
        format!("running {label}")
    } else {
        format!("took {label}")
    }
}

/// Coarse duration such as `12s`, `4m` or `2h 5m`.
fn duration_label(millis: u64) -> String {
    let seconds = millis / MILLIS_PER_SECOND;
    if seconds < SECONDS_PER_MINUTE {
        format!("{seconds}s")
    } else if seconds < SECONDS_PER_HOUR {
        format!("{}m", seconds / SECONDS_PER_MINUTE)
    } else {
        format!(
            "{}h {}m",
            seconds / SECONDS_PER_HOUR,
            seconds % SECONDS_PER_HOUR / SECONDS_PER_MINUTE
        )
    }
}

#[cfg(test)]
mod tests {
    use protocol::{AgentKind, SubagentRevision};

    use super::*;

    fn info(lifecycle: SubagentLifecycle, finished: Option<u64>) -> SubagentInfo {
        SubagentInfo {
            id: "a".to_owned(),
            parent_id: None,
            provider: AgentKind::Claude,
            agent_type: None,
            lifecycle,
            activity: None,
            revision: SubagentRevision::new(1),
            started_at_ms: 10_000,
            updated_at_ms: 20_000,
            finished_at_ms: finished,
        }
    }

    #[test]
    fn durations_are_coarse() {
        assert_eq!(duration_label(12_999), "12s");
        assert_eq!(duration_label(4 * 60_000 + 59_000), "4m");
        assert_eq!(duration_label((2 * 3600 + 5 * 60) * 1000), "2h 5m");
    }

    #[test]
    fn a_running_subagent_ages_against_now() {
        let running = info(SubagentLifecycle::Running, None);

        assert_eq!(elapsed_label(&running, 70_000), "running 1m");
    }

    #[test]
    fn a_finished_subagent_reports_its_run_time() {
        let done = info(SubagentLifecycle::Completed, Some(15_000));
        let lost = info(SubagentLifecycle::Lost, None);

        assert_eq!(elapsed_label(&done, 999_999), "took 5s");
        assert_eq!(elapsed_label(&lost, 999_999), "took 10s");
    }
}
