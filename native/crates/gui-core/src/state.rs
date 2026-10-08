//! Headless workspace state machine and derived views for `gui-core`.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::PathBuf;

use base64::prelude::{Engine as _, BASE64_STANDARD};
use protocol::{
    AgentActivity, Event, HostGovernanceStatus, NotificationId, NotificationKind,
    NotificationKindPolicy, NotificationPolicy, NotificationRecord, NotificationSeverity,
    NotificationStatus, OutputOffset, ProjectActionResult, ProjectActionsResult, ProjectInfo,
    ProjectPromptResult, ProjectShowResult, RuntimeState, SessionId, SessionInfo,
    SessionRuntimeIdentity, SessionScreenResult, SessionState, SessionWaitResult, StateSource,
    SubagentStateEvent,
};

use crate::providers;
use crate::subagents::{subagent_counts, SubagentCounts};
use crate::timestamp::cmp_rfc3339;
use crate::work_link::{work_link, WorkLink};
use crate::{
    parse_unified_diff, CoreError, DiffModel, DomainEvent, HealthSummary, HostId,
    ObservationCapabilities, PromptPreview, Review, ReviewComment, ReviewSide, ReviewSource,
    ReviewStatus, ReviewStore, Selection, SessionLinkProvider,
};

/// Prompt/action browse and preview state for one host.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PromptState {
    pub actions_by_project: BTreeMap<String, ProjectActionsResult>,
    pub resolved_prompt: Option<ProjectPromptResult>,
    pub resolved_action: Option<ProjectActionResult>,
    pub preview: Option<PromptPreview>,
}

/// Active provider browser panel.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ProviderPanel {
    /// Linear issues.
    #[default]
    Linear,
    /// GitHub issues and pull requests.
    GitHub,
}

/// Provider browser state owned by gui-core.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProviderState {
    pub active_panel: ProviderPanel,
    pub linear: LinearProviderState,
    pub github: GitHubProviderState,
}

/// Monotonic id for one provider request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProviderRequestId(u64);

impl ProviderRequestId {
    /// Borrow the numeric request id.
    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }
}

/// Monotonic identifier for one safe-governance inspection request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct GovernanceRequestId(u64);

impl GovernanceRequestId {
    /// Borrow the numeric request id.
    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }
}

/// Failure to allocate a new governance-inspection request identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GovernanceRequestError {
    /// Every `u64` request identifier has already been allocated.
    RequestIdExhausted,
}

impl fmt::Display for GovernanceRequestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RequestIdExhausted => write!(f, "governance request identifier space exhausted"),
        }
    }
}

impl std::error::Error for GovernanceRequestError {}

/// Read-only governance inspection state for one configured GUI host.
///
/// The GUI host selector identifies a daemon route; the [`HostGovernanceStatus`]
/// contained in [`Self::Loaded`] carries the distinct protocol-level stable host
/// identity returned by that daemon.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum GovernanceState {
    /// No inspection has been requested yet.
    #[default]
    NotLoaded,
    /// A read-only inspection request is in flight.
    Loading { request_id: GovernanceRequestId },
    /// The daemon returned a safe governance snapshot.
    Loaded(HostGovernanceStatus),
    /// The read-only inspection request failed.
    Error(String),
}

/// Provider operation used to reject stale async completions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderOperation {
    /// Linear assigned issue fetch.
    LinearIssues,
    /// GitHub pull request list fetch.
    GitHubPullRequests,
    /// GitHub issue list fetch.
    GitHubIssues,
    /// GitHub PR status fetch.
    GitHubPullRequestStatus,
    /// Provider launch action.
    Launch,
}

/// Linear provider browser state.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LinearProviderState {
    /// Name of the picked predefined filter; `None` until one is chosen.
    pub selected_filter: Option<String>,
    pub search: String,
    pub issues: Vec<providers::linear::LinearIssue>,
    pub selected_issue_id: Option<String>,
    pub active_request: Option<ProviderRequestId>,
    pub last_error: Option<String>,
}

/// GitHub provider browser state.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GitHubProviderState {
    pub scope: Option<GitHubProviderScope>,
    /// Name of the picked predefined pull request filter; `None` until chosen.
    pub selected_filter: Option<String>,
    pub search: String,
    pub pull_requests: Vec<providers::github::GitHubPullRequest>,
    pub issues: Vec<providers::github::GitHubIssue>,
    pub selected_pull_request: Option<u64>,
    pub selected_issue: Option<u64>,
    pub pull_requests_request: Option<ProviderRequestId>,
    pub issues_request: Option<ProviderRequestId>,
    pub pull_request_status_request: Option<ProviderRequestId>,
    pub pull_request_statuses:
        BTreeMap<GitHubPullRequestStatusKey, providers::github::PullRequestStatus>,
    pub last_error: Option<String>,
}

/// GitHub repository scope for provider data loaded through `gh`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct GitHubProviderScope {
    pub project_id: String,
    pub repo_root: PathBuf,
}

impl GitHubProviderScope {
    /// Construct a GitHub provider scope from the selected project identity.
    #[must_use]
    pub fn new(project_id: impl Into<String>, repo_root: impl Into<PathBuf>) -> Self {
        Self {
            project_id: project_id.into(),
            repo_root: repo_root.into(),
        }
    }

    /// Construct a GitHub provider scope from a daemon project record.
    #[must_use]
    pub fn from_project(project: &ProjectInfo) -> Self {
        Self::new(project.id.clone(), project.repo_root.clone())
    }
}

/// Cache key for GitHub PR status loaded for a specific repository scope.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct GitHubPullRequestStatusKey {
    pub scope: GitHubProviderScope,
    pub url: String,
}

impl GitHubPullRequestStatusKey {
    /// Construct a PR status cache key.
    #[must_use]
    pub fn new(scope: GitHubProviderScope, url: impl Into<String>) -> Self {
        Self {
            scope,
            url: url.into(),
        }
    }
}

/// Keyboard selection target in the combined GitHub provider list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitHubProviderSelection {
    /// A pull request row.
    PullRequest(u64),
    /// An issue row.
    Issue(u64),
}

/// Diff fetch/parse status for the Review tab (`docs/design/track-d-ui-brief.md`
/// §3.9, UI-brief §5 loading/empty/error states).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum ReviewDiffStatus {
    /// No review opened yet for this host.
    #[default]
    Idle,
    /// A `session.diff`/`gh pr diff` fetch is in flight.
    Fetching,
    /// Diff fetched and parsed; the change set has at least one file.
    Loaded {
        model: DiffModel,
        /// Base ref the diff was actually computed against.
        base: String,
        /// Whether the daemon/`gh` truncated the diff at a file boundary.
        truncated: bool,
    },
    /// Diff fetched and parsed, but the change set touched no files.
    Empty { base: String },
    /// The fetch failed; `String` is the error message to display.
    Error(String),
}

/// Identifies one selectable diff line: a file/hunk/line triple into
/// [`ReviewDiffStatus::Loaded`]'s model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReviewLineTarget {
    pub file_index: usize,
    pub hunk_index: usize,
    pub line_index: usize,
}

/// Inline comment editor state: which line it targets and its draft text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewCommentEditor {
    pub path: String,
    pub side: ReviewSide,
    pub line: u32,
    pub draft_text: String,
    /// `Some(index)` into `Review::comments` when editing an existing
    /// comment in place; `None` when composing a new one.
    pub editing_index: Option<usize>,
}

/// "Dispatch as session…" modal state.
///
/// `agent` is the operator's current pick from the modal's agent picker,
/// seeded from the source session's own profile when the modal opens
/// (see [`Workspace::open_review_dispatch_modal`]) and changed via
/// [`Workspace::set_review_dispatch_agent`]. It flows into
/// [`crate::ReviewDispatchParams::agent`] at confirm time, overriding
/// `session_info.agent` for the dispatched session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewDispatchModal {
    /// Rendered prompt preview, or the render error message
    /// (`render_review_prompt` failure, e.g. an unreadable `review.tmpl`).
    pub prompt_preview: Result<String, String>,
    /// Wire agent name the dispatched session will run: the source
    /// session's profile by default, or the operator's picked override.
    pub agent: String,
    /// Whether the source session's agent is currently `Working`.
    pub source_working: bool,
    /// Set after a failed dispatch attempt; the draft stays untouched and
    /// the modal stays open showing this message.
    pub dispatch_error: Option<String>,
}

/// Review tab state owned by gui-core: diff fetch status, the active draft
/// review, file/line selection, and modal state.
///
/// One active review per host at a time, matching how
/// [`GitHubProviderState`]/[`LinearProviderState`] scope to a single active
/// browse target rather than per-session slots — opening a review from a
/// different session or pull request replaces this state.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReviewTabState {
    pub diff: ReviewDiffStatus,
    pub active_review: Option<Review>,
    pub selected_file: Option<usize>,
    pub selected_line: Option<ReviewLineTarget>,
    pub comment_editor: Option<ReviewCommentEditor>,
    pub dispatch: Option<ReviewDispatchModal>,
    /// Request id of the in-flight diff fetch, guarding a stale completion
    /// (same pattern as the Linear/GitHub provider fetch requests).
    pub diff_request: Option<ProviderRequestId>,
}

/// Parsed `agent_state` event payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentStateEvent {
    pub session_id: SessionId,
    pub activity: AgentActivity,
    pub source: StateSource,
    pub raw: Event,
}

/// Protocol events surfaced by a host subscription.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostEvent {
    AgentState(AgentStateEvent),
    SubagentState(SubagentStateEvent),
    SessionCreated(SessionInfo),
    SessionUpdated(SessionInfo),
    SessionStopped(SessionInfo),
    SessionRemoved(SessionInfo),
    /// The replacement daemon adopted the same PTY runtime generation.
    RuntimeReconnected(SessionInfo),
    /// The worker-backed PTY runtime is no longer available.
    RuntimeLost(SessionInfo),
    /// More than one worker claims the logical session.
    RuntimeConflict(SessionInfo),
    /// Explicit provider-native recovery created a different PTY generation.
    NativeRecovered(SessionInfo),
    /// A durable notification record was created on the host.
    NotificationCreated(NotificationRecord),
    /// A durable notification record changed lifecycle status or content.
    NotificationUpdated(NotificationRecord),
    /// A durable notification record was hard-deleted on the host.
    NotificationDeleted(NotificationId),
    Other(Event),
}

/// Relationship between the current PTY generation and the previous one seen
/// by the GUI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeContinuity {
    /// The daemon reconnected to the exact same worker/runtime generation.
    Reconnected,
    /// Explicit recovery replaced the PTY with a new runtime generation.
    Recovered,
}

/// Per-host connection state for the headless workspace model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnState {
    Connecting,
    Connected,
    Disconnected,
    Unreachable,
}

/// OS notification requested by core state transitions.
///
/// Raised from durable `notification_created` events whose severity warrants an
/// immediate desktop notification (see [`notification_raises_intent`]). The
/// monotonic `id` lets the shell consume new intents with a cursor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationIntent {
    pub id: u64,
    pub host_id: HostId,
    /// Durable notification that raised this intent, so the shell can open its
    /// inbox detail on click.
    pub notification_id: Option<NotificationId>,
    /// Linked session, when the source notification is bound to one.
    pub session_id: Option<SessionId>,
    pub title: String,
    pub body: String,
}

/// In-app notification requested by core state transitions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Toast {
    pub id: u64,
    pub host_id: HostId,
    pub session_id: SessionId,
    pub message: String,
}

/// Filter for the inbox notification-list selectors.
///
/// Every `Some` field must match; `None` fields do not constrain the result.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NotificationFilter {
    pub host_id: Option<HostId>,
    pub status: Option<NotificationStatus>,
    pub severity: Option<NotificationSeverity>,
    pub kind: Option<NotificationKind>,
    pub provider: Option<String>,
}

impl NotificationFilter {
    /// Whether `record` passes the non-host constraints of this filter.
    ///
    /// The host constraint is applied by the caller, which already iterates
    /// hosts and can skip whole hosts without inspecting their records.
    fn matches(&self, record: &NotificationRecord) -> bool {
        if self.status.is_some_and(|status| status != record.status) {
            return false;
        }
        if self
            .severity
            .is_some_and(|severity| severity != record.severity)
        {
            return false;
        }
        if self.kind.is_some_and(|kind| kind != record.kind) {
            return false;
        }
        if self
            .provider
            .as_ref()
            .is_some_and(|provider| provider != &record.source.provider)
        {
            return false;
        }
        true
    }
}

/// One notification row for the inbox list, tagged with its owning host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationRow {
    pub host_id: HostId,
    pub record: NotificationRecord,
}

/// Coarse activity-feed scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum NotificationScope {
    /// Recent non-archived activity, regardless of read state.
    #[default]
    Recent,
    /// Only activity the operator has not opened yet.
    Unread,
    /// Only archived notifications.
    Archived,
}

impl NotificationScope {
    /// Whether `record` is visible under this scope.
    #[must_use]
    pub fn matches(self, record: &NotificationRecord) -> bool {
        match self {
            Self::Recent => !matches!(
                record.status,
                NotificationStatus::Archived | NotificationStatus::Deleted
            ),
            Self::Unread => record.status == NotificationStatus::Unread,
            Self::Archived => record.status == NotificationStatus::Archived,
        }
    }
}

fn notification_kind_enabled_mut(
    policy: &mut NotificationKindPolicy,
    kind: NotificationKind,
) -> &mut bool {
    match kind {
        NotificationKind::AgentBlocked => &mut policy.agent_blocked,
        NotificationKind::ApprovalRequired => &mut policy.approval_required,
        NotificationKind::TurnCompleted => &mut policy.turn_completed,
        NotificationKind::SessionFinished => &mut policy.session_finished,
        NotificationKind::Error => &mut policy.error,
        NotificationKind::System => &mut policy.system,
    }
}

/// GUI-facing state for one daemon host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostView {
    pub conn: ConnState,
    pub health: Option<HealthSummary>,
    pub sessions: BTreeMap<String, SessionInfo>,
    pub projects: BTreeMap<String, ProjectInfo>,
    pub project_details: BTreeMap<String, ProjectShowResult>,
    pub prompt: PromptState,
    pub provider: ProviderState,
    /// Diff review tab state: fetch status, active draft, selection, modals.
    pub review: ReviewTabState,
    /// Durable notification records for this host, keyed by notification id.
    pub notifications: BTreeMap<String, NotificationRecord>,
    pub last_agent_state: Option<AgentStateEvent>,
    pub last_error: Option<String>,
    /// Agent and profile names known to the daemon, seeded from `host.inspect`.
    ///
    /// See [`crate::HostSnapshot::supported_agents`] for its compatibility
    /// contract. Launch decisions must use `runtimes`.
    pub supported_agents: Vec<String>,
    /// Full host runtime inventory used for capability-honest launch choices.
    pub runtimes: Vec<protocol::AgentRuntime>,
    /// Provider names reported by the host's runtime inventory.
    pub notification_providers: Vec<String>,
    pub observation_capabilities: ObservationCapabilities,
    /// Safe stable-identity and governance information for this daemon route.
    pub governance: GovernanceState,
}

/// Provider-neutral terminal observation retained for one GUI session pane.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionObservation {
    /// Most recently loaded terminal screen snapshot.
    pub screen: Option<SessionScreenResult>,
    /// UTF-8-lossy output accumulated from contiguous output pages.
    pub output_text: String,
    /// Runtime identity associated with the accumulated output.
    pub output_runtime: Option<SessionRuntimeIdentity>,
    /// Cursor to use for the next output page.
    pub output_cursor: Option<OutputOffset>,
    /// Retention gap reported by the most recent output response.
    pub output_gap: Option<(OutputOffset, OutputOffset)>,
    /// Most recently completed session wait.
    pub wait: Option<SessionWaitResult>,
}

impl HostView {
    /// Returns whether `agent` is launchable according to the host inventory.
    #[must_use]
    pub fn agent_is_launchable(&self, agent: &str) -> bool {
        self.runtimes
            .iter()
            .any(|runtime| runtime.agent == agent && crate::runtime_is_launchable(runtime))
    }

    /// Returns whether `agent` is a launchable non-shell assistant runtime.
    #[must_use]
    pub fn agent_is_assistant_capable(&self, agent: &str) -> bool {
        self.runtimes
            .iter()
            .any(|runtime| runtime.agent == agent && crate::runtime_is_assistant_capable(runtime))
    }

    /// Returns launchable agent names in host inventory order.
    #[must_use]
    pub fn launchable_agents(&self) -> Vec<String> {
        self.runtimes
            .iter()
            .filter(|runtime| crate::runtime_is_launchable(runtime))
            .map(|runtime| runtime.agent.clone())
            .collect()
    }

    /// Returns launchable assistant runtime names in host inventory order.
    #[must_use]
    pub fn launchable_assistant_agents(&self) -> Vec<String> {
        self.runtimes
            .iter()
            .filter(|runtime| crate::runtime_is_assistant_capable(runtime))
            .map(|runtime| runtime.agent.clone())
            .collect()
    }

    fn connecting() -> Self {
        Self {
            conn: ConnState::Connecting,
            health: None,
            sessions: BTreeMap::new(),
            projects: BTreeMap::new(),
            project_details: BTreeMap::new(),
            prompt: PromptState::default(),
            provider: ProviderState::default(),
            review: ReviewTabState::default(),
            notifications: BTreeMap::new(),
            last_agent_state: None,
            last_error: None,
            supported_agents: Vec::new(),
            runtimes: Vec::new(),
            notification_providers: Vec::new(),
            observation_capabilities: ObservationCapabilities::default(),
            governance: GovernanceState::default(),
        }
    }
}

/// Headless workspace model owned by `gui-core`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Workspace {
    pub hosts: BTreeMap<HostId, HostView>,
    host_labels: BTreeMap<HostId, String>,
    pub selection: Option<Selection>,
    pub notification_intents: Vec<NotificationIntent>,
    pub toasts: Vec<Toast>,
    session_observations: BTreeMap<(HostId, String), SessionObservation>,
    notification_policies: BTreeMap<HostId, NotificationPolicy>,
    runtime_continuity: BTreeMap<(HostId, String), RuntimeContinuity>,
    reconnecting_hosts: BTreeSet<HostId>,
    next_intent_id: u64,
    next_provider_request_id: u64,
    next_governance_request_id: u64,
}

impl Workspace {
    /// Replaces the human-readable host names shown instead of route ids.
    ///
    /// `hosts` lists every configured route id; those without a label keep
    /// showing their id. The stored names are pairwise distinct and never equal
    /// such an id: a label that is shared, or equals an id that stays visible,
    /// gets a short suffix of its route id, and any collision left after that is
    /// numbered.
    pub fn set_host_labels(&mut self, hosts: &[HostId], labels: &BTreeMap<HostId, String>) {
        let mut seen: BTreeSet<String> = hosts
            .iter()
            .filter(|host_id| !labels.contains_key(*host_id))
            .map(ToString::to_string)
            .collect();
        let mut occurrences: BTreeMap<&str, usize> = BTreeMap::new();
        for label in labels.values() {
            *occurrences.entry(label.as_str()).or_default() += 1;
        }
        let mut resolved = BTreeMap::new();
        for (host_id, label) in labels {
            let clashes = occurrences[label.as_str()] > 1 || seen.contains(label);
            let mut unique = if clashes {
                format!("{label} ({})", route_id_suffix(host_id))
            } else {
                label.clone()
            };
            if !seen.insert(unique.clone()) {
                let base = unique.clone();
                unique = (2..=u32::MAX)
                    .map(|number| format!("{base} #{number}"))
                    .find(|candidate| seen.insert(candidate.clone()))
                    .unwrap_or(base);
            }
            resolved.insert(host_id.clone(), unique);
        }
        self.host_labels = resolved;
    }

    /// Name to show for `host_id`: its human-readable label, else the route id.
    #[must_use]
    pub fn host_label(&self, host_id: &HostId) -> String {
        self.host_labels
            .get(host_id)
            .cloned()
            .unwrap_or_else(|| host_id.to_string())
    }

    /// Returns the safe governance state for the configured daemon route.
    ///
    /// `host_id` is the GUI's route selector, not the protocol stable host id
    /// within a loaded [`HostGovernanceStatus`].
    #[must_use]
    pub fn governance(&self, host_id: &HostId) -> Option<&GovernanceState> {
        self.hosts.get(host_id).map(|host| &host.governance)
    }

    /// Start a safe governance inspection and return its staleness guard.
    ///
    /// # Errors
    ///
    /// Returns [`GovernanceRequestError::RequestIdExhausted`] without changing
    /// the existing host state when the request-id space is exhausted. This
    /// prevents an old response from becoming valid again through id reuse.
    pub fn begin_governance_request(
        &mut self,
        host_id: HostId,
    ) -> Result<GovernanceRequestId, GovernanceRequestError> {
        let next = self
            .next_governance_request_id
            .checked_add(1)
            .ok_or(GovernanceRequestError::RequestIdExhausted)?;
        self.next_governance_request_id = next;
        let request_id = GovernanceRequestId(next);
        let host = self
            .hosts
            .entry(host_id)
            .or_insert_with(HostView::connecting);
        host.governance = GovernanceState::Loading { request_id };
        Ok(request_id)
    }

    /// Returns cached provider-neutral terminal observation for a session.
    #[must_use]
    pub fn session_observation(
        &self,
        host_id: &HostId,
        session_id: &SessionId,
    ) -> Option<&SessionObservation> {
        self.session_observations
            .get(&(host_id.clone(), session_id.0.clone()))
    }

    /// Returns the current provider-keyed notification policy for a host.
    #[must_use]
    pub fn notification_policy(&self, host_id: &HostId) -> Option<&NotificationPolicy> {
        self.notification_policies.get(host_id)
    }

    /// Updates one base or provider-specific notification kind in cached state.
    pub fn set_notification_policy_kind(
        &mut self,
        host_id: &HostId,
        provider: Option<&str>,
        kind: NotificationKind,
        enabled: bool,
    ) -> bool {
        let Some(policy) = self.notification_policies.get_mut(host_id) else {
            return false;
        };
        let kind_policy = match provider {
            Some(provider) => policy
                .providers
                .entry(provider.to_owned())
                .or_insert_with(|| policy.enabled.clone()),
            None => &mut policy.enabled,
        };
        *notification_kind_enabled_mut(kind_policy, kind) = enabled;
        true
    }

    /// Return how the current runtime relates to the prior observed generation.
    #[must_use]
    pub fn runtime_continuity(
        &self,
        host_id: &HostId,
        session_id: &SessionId,
    ) -> Option<RuntimeContinuity> {
        self.runtime_continuity
            .get(&(host_id.clone(), session_id.0.clone()))
            .copied()
    }

    fn next_provider_request_id(&mut self) -> ProviderRequestId {
        self.next_provider_request_id = self.next_provider_request_id.saturating_add(1);
        ProviderRequestId(self.next_provider_request_id)
    }

    /// Mark a Linear issue fetch as the current request for `host_id`.
    pub fn begin_linear_issues_request(&mut self, host_id: HostId) -> ProviderRequestId {
        let request_id = self.next_provider_request_id();
        let host = self
            .hosts
            .entry(host_id)
            .or_insert_with(HostView::connecting);
        host.provider.linear.active_request = Some(request_id);
        host.provider.linear.last_error = None;
        request_id
    }

    /// Mark a GitHub pull request list fetch as the current request for `host_id`.
    pub fn begin_github_pull_requests_request(&mut self, host_id: HostId) -> ProviderRequestId {
        let request_id = self.next_provider_request_id();
        let host = self
            .hosts
            .entry(host_id)
            .or_insert_with(HostView::connecting);
        host.provider.github.pull_requests_request = Some(request_id);
        host.provider.github.last_error = None;
        request_id
    }

    /// Mark a GitHub issue list fetch as the current request for `host_id`.
    pub fn begin_github_issues_request(&mut self, host_id: HostId) -> ProviderRequestId {
        let request_id = self.next_provider_request_id();
        let host = self
            .hosts
            .entry(host_id)
            .or_insert_with(HostView::connecting);
        host.provider.github.issues_request = Some(request_id);
        host.provider.github.last_error = None;
        request_id
    }

    /// Mark a GitHub pull request status fetch as the current request for `host_id`.
    pub fn begin_github_pull_request_status_request(
        &mut self,
        host_id: HostId,
    ) -> ProviderRequestId {
        let request_id = self.next_provider_request_id();
        let host = self
            .hosts
            .entry(host_id)
            .or_insert_with(HostView::connecting);
        host.provider.github.pull_request_status_request = Some(request_id);
        host.provider.github.last_error = None;
        request_id
    }

    /// Invalidate pending GitHub provider requests for `host_id`.
    pub fn invalidate_github_provider_requests(&mut self, host_id: &HostId) {
        if let Some(host) = self.hosts.get_mut(host_id) {
            host.provider.github.pull_requests_request = None;
            host.provider.github.issues_request = None;
            host.provider.github.pull_request_status_request = None;
        }
    }

    fn selected_github_scope(&self, host_id: &HostId) -> Option<GitHubProviderScope> {
        let Selection::Session {
            host_id: selected_host,
            session_id,
        } = self.selection.as_ref()?;
        if selected_host != host_id {
            return None;
        }
        let host = self.hosts.get(host_id)?;
        let project_id = host.sessions.get(&session_id.0)?.project_id.as_ref()?;
        host.projects
            .get(project_id)
            .map(GitHubProviderScope::from_project)
    }

    /// Reduce one domain event (async daemon/provider I/O result) into state.
    #[expect(
        clippy::too_many_lines,
        reason = "workspace updates are centralized so GUI transitions stay deterministic and testable"
    )]
    pub fn apply(&mut self, event: DomainEvent) {
        match event {
            DomainEvent::HostConnecting { host_id } => {
                if self
                    .hosts
                    .get(&host_id)
                    .is_some_and(|host| !host.sessions.is_empty())
                {
                    self.reconnecting_hosts.insert(host_id.clone());
                }
                self.hosts
                    .entry(host_id)
                    .and_modify(|host| {
                        host.conn = ConnState::Connecting;
                        host.last_error = None;
                    })
                    .or_insert_with(HostView::connecting);
            }
            DomainEvent::HostSnapshotLoaded { snapshot } => {
                let host_id = snapshot.host_id.clone();
                let prior_sessions = self
                    .hosts
                    .get(&host_id)
                    .map_or_else(BTreeMap::new, |host| host.sessions.clone());
                let reconnecting = self.reconnecting_hosts.remove(&host_id);
                let sessions: BTreeMap<String, SessionInfo> = snapshot
                    .sessions
                    .iter()
                    .cloned()
                    .map(|session| (session.id.0.clone(), session))
                    .collect();
                for (session_id, session) in &sessions {
                    let Some(previous) = prior_sessions.get(session_id) else {
                        continue;
                    };
                    let key = (host_id.clone(), session_id.clone());
                    if runtime_generation_changed(previous, session) {
                        self.session_observations.remove(&key);
                        self.runtime_continuity
                            .insert(key, RuntimeContinuity::Recovered);
                    } else if reconnecting && same_runtime_generation(previous, session) {
                        self.runtime_continuity
                            .insert(key, RuntimeContinuity::Reconnected);
                    }
                }
                let projects = snapshot
                    .projects
                    .iter()
                    .cloned()
                    .map(|project| (project.id.clone(), project))
                    .collect();
                let previous_details = self
                    .hosts
                    .get(&host_id)
                    .map_or_else(BTreeMap::new, |host| host.project_details.clone());
                let previous_prompt = self
                    .hosts
                    .get(&host_id)
                    .map_or_else(PromptState::default, |host| host.prompt.clone());
                let previous_provider = self
                    .hosts
                    .get(&host_id)
                    .map_or_else(ProviderState::default, |host| host.provider.clone());
                let previous_review = self
                    .hosts
                    .get(&host_id)
                    .map_or_else(ReviewTabState::default, |host| host.review.clone());
                let previous_governance = self
                    .hosts
                    .get(&host_id)
                    .map_or_else(GovernanceState::default, |host| host.governance.clone());
                // Notifications reconcile by merge, not wholesale replacement: the
                // seed query returns a bounded recent window, so previously
                // received records are preserved and missed records are folded in
                // (deduped by id). Seeding never raises OS intents.
                let mut notifications = self
                    .hosts
                    .get(&host_id)
                    .map_or_else(BTreeMap::new, |host| host.notifications.clone());
                for record in snapshot.notifications {
                    upsert_notification(&mut notifications, record);
                }
                self.hosts.insert(
                    snapshot.host_id,
                    HostView {
                        conn: ConnState::Connected,
                        health: Some(snapshot.health),
                        sessions,
                        projects,
                        project_details: previous_details,
                        prompt: previous_prompt,
                        provider: previous_provider,
                        review: previous_review,
                        notifications,
                        last_agent_state: None,
                        last_error: snapshot.project_error,
                        supported_agents: snapshot.supported_agents,
                        runtimes: snapshot.runtimes,
                        notification_providers: snapshot.notification_providers,
                        observation_capabilities: snapshot.observation_capabilities,
                        governance: previous_governance,
                    },
                );
            }
            DomainEvent::GovernanceLoaded {
                host_id,
                request_id,
                result,
            } => {
                let Some(host) = self.host_mut_if_known(&host_id, "governance inspection result")
                else {
                    return;
                };
                if host.governance != (GovernanceState::Loading { request_id }) {
                    return;
                }
                host.governance = match result {
                    Ok(status) => GovernanceState::Loaded(status),
                    Err(error) => GovernanceState::Error(error),
                };
            }
            DomainEvent::HostSubscribed { host_id } => {
                self.hosts
                    .entry(host_id)
                    .and_modify(|host| {
                        host.conn = ConnState::Connected;
                        host.last_error = None;
                    })
                    .or_insert_with(|| HostView {
                        conn: ConnState::Connected,
                        ..HostView::connecting()
                    });
            }
            DomainEvent::HostEvent { host_id, event } => {
                let observation_invalidation = self
                    .hosts
                    .get(&host_id)
                    .and_then(|host| observation_invalidation_for_host_event(host, &event));
                let Some(host) = self.hosts.get_mut(&host_id) else {
                    trace_ignored_unknown_host(&host_id, "host event");
                    return;
                };
                host.conn = ConnState::Connected;
                host.last_error = None;
                apply_host_event(
                    host,
                    &host_id,
                    event,
                    &mut self.notification_intents,
                    &mut self.toasts,
                    &mut self.next_intent_id,
                    &mut self.runtime_continuity,
                );
                if let Some(session_id) = observation_invalidation {
                    self.session_observations.remove(&(host_id, session_id));
                }
            }
            DomainEvent::HostDisconnected { host_id, error } => {
                let Some(host) = self.host_mut_if_known(&host_id, "host disconnected") else {
                    return;
                };
                host.conn = ConnState::Disconnected;
                host.last_error = Some(error);
            }
            DomainEvent::HostUnreachable { host_id, error } => {
                let Some(host) = self.host_mut_if_known(&host_id, "host unreachable") else {
                    return;
                };
                host.conn = ConnState::Unreachable;
                host.last_error = Some(error);
            }
            DomainEvent::SessionCreated { host_id, session }
            | DomainEvent::SessionInspected { host_id, session } => {
                let key = (host_id.clone(), session.id.0.clone());
                let runtime_changed = self
                    .hosts
                    .get(&host_id)
                    .and_then(|host| host.sessions.get(&session.id.0))
                    .is_some_and(|previous| runtime_generation_changed(previous, &session));
                let Some(host) = self.host_mut_if_known(&host_id, "session result") else {
                    return;
                };
                host.sessions.insert(session.id.0.clone(), session);
                if runtime_changed {
                    self.session_observations.remove(&key);
                }
            }
            DomainEvent::SessionResumed { host_id, result } => {
                let key = (host_id.clone(), result.session.id.0.clone());
                let runtime_changed = self
                    .hosts
                    .get(&host_id)
                    .and_then(|host| host.sessions.get(&result.session.id.0))
                    .is_some_and(|previous| runtime_generation_changed(previous, &result.session));
                let Some(host) = self.host_mut_if_known(&host_id, "session resume result") else {
                    return;
                };
                let session = result.session;
                host.sessions.insert(session.id.0.clone(), session);
                if runtime_changed {
                    self.session_observations.remove(&key);
                }
            }
            DomainEvent::SessionForked { host_id, result } => {
                let Some(host) = self.host_mut_if_known(&host_id, "session fork result") else {
                    return;
                };
                let session = result.session;
                host.sessions.insert(session.id.0.clone(), session);
            }
            DomainEvent::SessionScreenLoaded { host_id, result } => {
                let key = (host_id, result.session_id.0.clone());
                let observation = self.session_observations.entry(key).or_default();
                if observation.output_runtime.as_ref() != Some(&result.runtime) {
                    observation.output_text.clear();
                    observation.output_runtime = None;
                    observation.output_cursor = None;
                    observation.output_gap = None;
                }
                observation.screen = Some(result);
            }
            DomainEvent::SessionOutputLoaded { host_id, result } => {
                let key = (host_id, result.session_id().0.clone());
                let observation = self.session_observations.entry(key).or_default();
                if observation.output_runtime.as_ref() != Some(result.runtime()) {
                    observation.output_text.clear();
                    observation.output_gap = None;
                    if observation
                        .screen
                        .as_ref()
                        .is_some_and(|screen| &screen.runtime != result.runtime())
                    {
                        observation.screen = None;
                    }
                }
                if let Some(gap) = result.gap() {
                    observation.output_text.clear();
                    observation.output_gap = Some((gap.start_offset(), gap.end_offset()));
                }
                if let Ok(bytes) = BASE64_STANDARD.decode(result.data_base64()) {
                    observation
                        .output_text
                        .push_str(&String::from_utf8_lossy(&bytes));
                }
                observation.output_runtime = Some(result.runtime().clone());
                observation.output_cursor = Some(result.next_offset());
            }
            DomainEvent::SessionObservationRuntimeChanged {
                host_id,
                session_id,
                ..
            } => {
                self.session_observations.remove(&(host_id, session_id.0));
            }
            DomainEvent::SessionWaitCompleted { host_id, result } => {
                let session_id = result.session.id.clone();
                let key = (host_id.clone(), session_id.0.clone());
                let runtime_changed = self
                    .hosts
                    .get(&host_id)
                    .and_then(|host| host.sessions.get(&session_id.0))
                    .is_some_and(|previous| runtime_generation_changed(previous, &result.session));
                if let Some(host) = self.hosts.get_mut(&host_id) {
                    host.sessions
                        .insert(session_id.0.clone(), result.session.clone());
                }
                if runtime_changed {
                    self.session_observations.remove(&key);
                }
                self.session_observations
                    .entry((host_id, session_id.0))
                    .or_default()
                    .wait = Some(result);
            }
            DomainEvent::NotificationPolicyLoaded { host_id, result } => {
                self.notification_policies.insert(host_id, result.policy);
            }
            DomainEvent::SessionStopCompleted {
                host_id,
                session_id,
                result,
            } => {
                if !result.stopped {
                    return;
                }
                let Some(host) = self.host_mut_if_known(&host_id, "session stop result") else {
                    return;
                };
                if let Some(session) = host.sessions.get_mut(&session_id.0) {
                    session.state = SessionState::Stopped;
                    session.activity = None;
                }
            }
            DomainEvent::SessionRemoveCompleted {
                host_id,
                session_id,
                result,
            } => {
                if !result.removed {
                    return;
                }
                let Some(host) = self.host_mut_if_known(&host_id, "session remove result") else {
                    return;
                };
                let session_key = session_id.0;
                host.sessions.remove(&session_key);
                self.runtime_continuity
                    .remove(&(host_id.clone(), session_key.clone()));
                self.session_observations.remove(&(host_id, session_key));
            }
            DomainEvent::SessionMetadataUpdated { host_id, result } => {
                let Some(host) = self.host_mut_if_known(&host_id, "session metadata result") else {
                    return;
                };
                host.sessions
                    .insert(result.session.id.0.clone(), result.session);
            }
            DomainEvent::SessionRenamed { host_id, result } => {
                let Some(host) = self.host_mut_if_known(&host_id, "session renamed result") else {
                    return;
                };
                host.sessions
                    .insert(result.session.id.0.clone(), result.session);
            }
            DomainEvent::ProjectListLoaded { host_id, projects } => {
                let Some(host) = self.host_mut_if_known(&host_id, "project list result") else {
                    return;
                };
                host.projects = projects
                    .iter()
                    .cloned()
                    .map(|project| (project.id.clone(), project))
                    .collect();
                host.project_details
                    .retain(|id, _details| host.projects.contains_key(id));
            }
            DomainEvent::ProjectAdded { host_id, project }
            | DomainEvent::ProjectRenamed { host_id, project } => {
                let Some(host) = self.host_mut_if_known(&host_id, "project change result") else {
                    return;
                };
                host.projects.insert(project.id.clone(), project);
            }
            DomainEvent::ProjectShown { host_id, result } => {
                let Some(host) = self.host_mut_if_known(&host_id, "project shown result") else {
                    return;
                };
                host.projects
                    .insert(result.project.id.clone(), result.project.clone());
                host.project_details
                    .insert(result.project.id.clone(), result);
            }
            DomainEvent::ProjectRemoved {
                host_id,
                reference,
                result,
            } => {
                if !result.removed {
                    return;
                }
                if let Some(host) = self.hosts.get_mut(&host_id) {
                    let removed_ids = host
                        .projects
                        .iter()
                        .filter(|(id, project)| *id == &reference || project.label == reference)
                        .map(|(id, _project)| id.clone())
                        .collect::<Vec<_>>();
                    for id in removed_ids {
                        host.projects.remove(&id);
                        host.project_details.remove(&id);
                    }
                }
            }
            DomainEvent::WorktreeRemoved {
                host_id,
                project_id,
                path,
                result,
            } => {
                if !result.removed {
                    return;
                }
                // Drop the removed worktree from the cached project detail so the
                // row disappears immediately, without waiting for a refresh.
                if let Some(details) = self
                    .hosts
                    .get_mut(&host_id)
                    .and_then(|host| host.project_details.get_mut(&project_id))
                {
                    details.worktrees.retain(|worktree| worktree.path != path);
                }
            }
            DomainEvent::ProjectActionsLoaded {
                host_id,
                reference,
                result,
            } => {
                let Some(host) = self.host_mut_if_known(&host_id, "project actions result") else {
                    return;
                };
                host.prompt.actions_by_project.insert(reference, result);
                host.last_error = None;
            }
            DomainEvent::ProjectPromptResolved { host_id, prompt } => {
                let Some(host) = self.host_mut_if_known(&host_id, "project prompt result") else {
                    return;
                };
                host.prompt.resolved_prompt = Some(prompt);
                host.prompt.preview = None;
                host.last_error = None;
            }
            DomainEvent::ProjectActionResolved { host_id, action } => {
                let Some(host) = self.host_mut_if_known(&host_id, "project action result") else {
                    return;
                };
                host.prompt.resolved_action = Some(action);
                host.prompt.preview = None;
                host.last_error = None;
            }
            DomainEvent::PromptPreviewRendered { host_id, preview } => {
                let Some(host) = self.host_mut_if_known(&host_id, "prompt preview result") else {
                    return;
                };
                host.prompt.preview = Some(preview);
                host.last_error = None;
            }
            DomainEvent::LinearProviderIssuesLoaded {
                host_id,
                request_id,
                filter_name,
                search,
                issues,
            } => {
                let trace_host_id = host_id.clone();
                let Some(host) = self.host_mut_if_known(&host_id, "linear issues result") else {
                    return;
                };
                if host.provider.linear.active_request != Some(request_id) {
                    trace_ignored_provider_result(
                        &trace_host_id,
                        SessionLinkProvider::Linear,
                        ProviderOperation::LinearIssues,
                        request_id,
                        "stale_request",
                    );
                    return;
                }
                if host.provider.linear.selected_filter != filter_name
                    || host.provider.linear.search != search
                {
                    trace_ignored_provider_result(
                        &trace_host_id,
                        SessionLinkProvider::Linear,
                        ProviderOperation::LinearIssues,
                        request_id,
                        "filter_changed",
                    );
                    return;
                }
                host.provider.linear.active_request = None;
                host.provider.linear.issues = issues;
                host.provider.linear.selected_issue_id = None;
                host.provider.linear.last_error = None;
            }
            DomainEvent::GitHubProviderPullRequestsLoaded {
                host_id,
                request_id,
                scope,
                pull_requests,
            } => {
                if self
                    .selected_github_scope(&host_id)
                    .as_ref()
                    .is_some_and(|current| current != &scope)
                {
                    trace_ignored_provider_result(
                        &host_id,
                        SessionLinkProvider::GitHub,
                        ProviderOperation::GitHubPullRequests,
                        request_id,
                        "selection_changed",
                    );
                    return;
                }
                let trace_host_id = host_id.clone();
                let Some(host) = self.host_mut_if_known(&host_id, "github pull requests result")
                else {
                    return;
                };
                if host.provider.github.pull_requests_request != Some(request_id) {
                    trace_ignored_provider_result(
                        &trace_host_id,
                        SessionLinkProvider::GitHub,
                        ProviderOperation::GitHubPullRequests,
                        request_id,
                        "stale_request",
                    );
                    return;
                }
                host.provider.github.pull_requests_request = None;
                if host.provider.github.scope.as_ref() != Some(&scope) {
                    host.provider.github.issues.clear();
                    host.provider.github.selected_issue = None;
                }
                host.provider.github.scope = Some(scope);
                host.provider.github.pull_requests = pull_requests;
                host.provider.github.selected_pull_request = None;
                host.provider.github.last_error = None;
            }
            DomainEvent::GitHubProviderIssuesLoaded {
                host_id,
                request_id,
                scope,
                issues,
            } => {
                if self
                    .selected_github_scope(&host_id)
                    .as_ref()
                    .is_some_and(|current| current != &scope)
                {
                    trace_ignored_provider_result(
                        &host_id,
                        SessionLinkProvider::GitHub,
                        ProviderOperation::GitHubIssues,
                        request_id,
                        "selection_changed",
                    );
                    return;
                }
                let trace_host_id = host_id.clone();
                let Some(host) = self.host_mut_if_known(&host_id, "github issues result") else {
                    return;
                };
                if host.provider.github.issues_request != Some(request_id) {
                    trace_ignored_provider_result(
                        &trace_host_id,
                        SessionLinkProvider::GitHub,
                        ProviderOperation::GitHubIssues,
                        request_id,
                        "stale_request",
                    );
                    return;
                }
                host.provider.github.issues_request = None;
                if host.provider.github.scope.as_ref() != Some(&scope) {
                    host.provider.github.pull_requests.clear();
                    host.provider.github.selected_pull_request = None;
                }
                host.provider.github.scope = Some(scope);
                host.provider.github.issues = issues;
                host.provider.github.selected_issue = None;
                host.provider.github.last_error = None;
            }
            DomainEvent::GitHubProviderPullRequestStatusLoaded {
                host_id,
                request_id,
                status_key,
                status,
            } => {
                if self
                    .selected_github_scope(&host_id)
                    .as_ref()
                    .is_some_and(|current| current != &status_key.scope)
                {
                    trace_ignored_provider_result(
                        &host_id,
                        SessionLinkProvider::GitHub,
                        ProviderOperation::GitHubPullRequestStatus,
                        request_id,
                        "selection_changed",
                    );
                    return;
                }
                let trace_host_id = host_id.clone();
                let Some(host) =
                    self.host_mut_if_known(&host_id, "github pull request status result")
                else {
                    return;
                };
                if host.provider.github.pull_request_status_request != Some(request_id) {
                    trace_ignored_provider_result(
                        &trace_host_id,
                        SessionLinkProvider::GitHub,
                        ProviderOperation::GitHubPullRequestStatus,
                        request_id,
                        "stale_request",
                    );
                    return;
                }
                host.provider.github.pull_request_status_request = None;
                host.provider
                    .github
                    .pull_request_statuses
                    .insert(status_key, status);
                host.provider.github.last_error = None;
            }
            DomainEvent::ProviderOperationFailed {
                host_id,
                provider,
                operation,
                request_id,
                error,
            } => {
                let Some(host) = self.host_mut_if_known(&host_id, "provider operation failure")
                else {
                    return;
                };
                if !apply_provider_request_failure(&host_id, host, provider, operation, request_id)
                {
                    return;
                }
                match provider {
                    SessionLinkProvider::Linear => host.provider.linear.last_error = Some(error),
                    SessionLinkProvider::GitHub => host.provider.github.last_error = Some(error),
                }
            }
            DomainEvent::HostOperationFailed { host_id, error } => {
                let Some(host) = self.host_mut_if_known(&host_id, "host operation failure") else {
                    return;
                };
                host.last_error = Some(error);
            }
            DomainEvent::NotificationUpdateCompleted { host_id, result } => {
                let host = self
                    .hosts
                    .entry(host_id)
                    .or_insert_with(HostView::connecting);
                upsert_notification(&mut host.notifications, result.record);
            }
            DomainEvent::NotificationDeleteCompleted { host_id, result } => {
                if !result.deleted {
                    return;
                }
                let host = self
                    .hosts
                    .entry(host_id)
                    .or_insert_with(HostView::connecting);
                remove_notification(&mut host.notifications, &result.id);
            }
            DomainEvent::ReviewDiffLoaded {
                host_id,
                request_id,
                diff_text,
                base,
                truncated,
            } => {
                let Some(host) = self.host_mut_if_known(&host_id, "review diff result") else {
                    return;
                };
                if host.review.diff_request != Some(request_id) {
                    // A stale completion: the operator opened a different
                    // review (or closed this one) before this fetch landed.
                    return;
                }
                host.review.diff_request = None;
                let model = parse_unified_diff(&diff_text);
                host.review.diff = if model.files.is_empty() {
                    ReviewDiffStatus::Empty { base }
                } else {
                    ReviewDiffStatus::Loaded {
                        model,
                        base,
                        truncated,
                    }
                };
            }
            DomainEvent::ReviewDiffFailed {
                host_id,
                request_id,
                error,
            } => {
                let Some(host) = self.host_mut_if_known(&host_id, "review diff failure") else {
                    return;
                };
                if host.review.diff_request != Some(request_id) {
                    return;
                }
                host.review.diff_request = None;
                host.review.diff = ReviewDiffStatus::Error(error);
            }
            DomainEvent::ReviewDispatched {
                host_id,
                review,
                result,
            } => {
                let Some(host) = self.host_mut_if_known(&host_id, "review dispatch result") else {
                    return;
                };
                let session = result.session;
                host.sessions.insert(session.id.0.clone(), session);
                host.review.active_review = Some(review);
                host.review.dispatch = None;
            }
            DomainEvent::ReviewDispatchFailed { host_id, error } => {
                let Some(host) = self.host_mut_if_known(&host_id, "review dispatch failure") else {
                    return;
                };
                if let Some(dispatch) = &mut host.review.dispatch {
                    dispatch.dispatch_error = Some(error);
                }
            }
        }
    }

    fn host_mut_if_known(
        &mut self,
        host_id: &HostId,
        reason: &'static str,
    ) -> Option<&mut HostView> {
        let Some(host) = self.hosts.get_mut(host_id) else {
            trace_ignored_unknown_host(host_id, reason);
            return None;
        };
        Some(host)
    }

    fn host_for_ui(&mut self, host_id: HostId) -> &mut HostView {
        self.hosts
            .entry(host_id)
            .or_insert_with(HostView::connecting)
    }

    /// Switch the active provider browser panel for `host_id`.
    pub fn set_active_panel(&mut self, host_id: HostId, panel: ProviderPanel) {
        let host = self.host_for_ui(host_id);
        host.provider.active_panel = panel;
    }

    /// Pick the named Linear filter for `host_id`, dropping any in-flight
    /// issues request so a stale response cannot land under the new filter.
    pub fn select_linear_filter(&mut self, host_id: HostId, name: String) {
        let host = self.host_for_ui(host_id);
        host.provider.linear.selected_filter = Some(name);
        host.provider.linear.active_request = None;
    }

    /// Update the Linear search box text for `host_id`, dropping any
    /// in-flight issues request so a stale response cannot land under the new
    /// search.
    pub fn set_linear_search(&mut self, host_id: HostId, value: String) {
        let host = self.host_for_ui(host_id);
        host.provider.linear.search = value;
        host.provider.linear.active_request = None;
    }

    /// Select a Linear issue in the provider browser for `host_id`.
    pub fn select_linear_issue(&mut self, host_id: HostId, issue_id: String) {
        let host = self.host_for_ui(host_id);
        host.provider.linear.selected_issue_id = Some(issue_id);
    }

    /// Select the next visible Linear issue for `host_id`.
    pub fn select_next_linear_issue(&mut self, host_id: &HostId) -> Option<String> {
        self.select_linear_issue_by_keyboard(host_id, SelectionDirection::Next)
    }

    /// Select the previous visible Linear issue for `host_id`.
    pub fn select_previous_linear_issue(&mut self, host_id: &HostId) -> Option<String> {
        self.select_linear_issue_by_keyboard(host_id, SelectionDirection::Previous)
    }

    fn select_linear_issue_by_keyboard(
        &mut self,
        host_id: &HostId,
        direction: SelectionDirection,
    ) -> Option<String> {
        let host = self.hosts.get_mut(host_id)?;
        let state = &mut host.provider.linear;
        let visible = visible_linear_issue_ids(state);
        let current = state.selected_issue_id.as_deref();
        let current_index = visible
            .iter()
            .position(|issue_id| Some(issue_id.as_str()) == current);
        let selected_index = move_selection(current_index, visible.len(), direction)?;
        let selected_id = visible[selected_index].clone();
        state.selected_issue_id = Some(selected_id.clone());
        Some(selected_id)
    }

    /// Pick the named GitHub pull request filter for `host_id`, dropping any
    /// in-flight pull requests request so a stale response cannot land under
    /// the new filter.
    pub fn select_github_filter(&mut self, host_id: HostId, name: String) {
        let host = self.host_for_ui(host_id);
        host.provider.github.selected_filter = Some(name);
        host.provider.github.pull_requests_request = None;
    }

    /// Update the GitHub search box text for `host_id`.
    pub fn set_github_search(&mut self, host_id: HostId, value: String) {
        let host = self.host_for_ui(host_id);
        host.provider.github.search = value;
    }

    /// Select a GitHub pull request in the provider browser for `host_id`.
    pub fn select_github_pull_request(&mut self, host_id: HostId, number: u64) {
        let host = self.host_for_ui(host_id);
        host.provider.github.selected_pull_request = Some(number);
        host.provider.github.selected_issue = None;
    }

    /// Select the next visible GitHub pull request for `host_id`.
    pub fn select_next_github_pull_request(&mut self, host_id: &HostId) -> Option<u64> {
        self.select_github_pull_request_by_keyboard(host_id, SelectionDirection::Next)
    }

    /// Select the previous visible GitHub pull request for `host_id`.
    pub fn select_previous_github_pull_request(&mut self, host_id: &HostId) -> Option<u64> {
        self.select_github_pull_request_by_keyboard(host_id, SelectionDirection::Previous)
    }

    fn select_github_pull_request_by_keyboard(
        &mut self,
        host_id: &HostId,
        direction: SelectionDirection,
    ) -> Option<u64> {
        let host = self.hosts.get_mut(host_id)?;
        let state = &mut host.provider.github;
        let visible = visible_github_pull_request_numbers(state);
        let current_index = visible
            .iter()
            .position(|number| Some(*number) == state.selected_pull_request);
        let selected_index = move_selection(current_index, visible.len(), direction)?;
        let selected_number = visible[selected_index];
        state.selected_pull_request = Some(selected_number);
        Some(selected_number)
    }

    /// Select a GitHub issue in the provider browser for `host_id`.
    pub fn select_github_issue(&mut self, host_id: HostId, number: u64) {
        let host = self.host_for_ui(host_id);
        host.provider.github.selected_issue = Some(number);
        host.provider.github.selected_pull_request = None;
    }

    /// Select the next visible GitHub issue for `host_id`.
    pub fn select_next_github_issue(&mut self, host_id: &HostId) -> Option<u64> {
        self.select_github_issue_by_keyboard(host_id, SelectionDirection::Next)
    }

    /// Select the previous visible GitHub issue for `host_id`.
    pub fn select_previous_github_issue(&mut self, host_id: &HostId) -> Option<u64> {
        self.select_github_issue_by_keyboard(host_id, SelectionDirection::Previous)
    }

    fn select_github_issue_by_keyboard(
        &mut self,
        host_id: &HostId,
        direction: SelectionDirection,
    ) -> Option<u64> {
        let host = self.hosts.get_mut(host_id)?;
        let state = &mut host.provider.github;
        let visible = visible_github_issue_numbers(state);
        let current_index = visible
            .iter()
            .position(|number| Some(*number) == state.selected_issue);
        let selected_index = move_selection(current_index, visible.len(), direction)?;
        let selected_number = visible[selected_index];
        state.selected_issue = Some(selected_number);
        state.selected_pull_request = None;
        Some(selected_number)
    }

    /// Select the next visible GitHub provider row for `host_id`.
    pub fn select_next_github_item(&mut self, host_id: &HostId) -> Option<GitHubProviderSelection> {
        self.select_github_item_by_keyboard(host_id, SelectionDirection::Next)
    }

    /// Select the previous visible GitHub provider row for `host_id`.
    pub fn select_previous_github_item(
        &mut self,
        host_id: &HostId,
    ) -> Option<GitHubProviderSelection> {
        self.select_github_item_by_keyboard(host_id, SelectionDirection::Previous)
    }

    fn select_github_item_by_keyboard(
        &mut self,
        host_id: &HostId,
        direction: SelectionDirection,
    ) -> Option<GitHubProviderSelection> {
        let host = self.hosts.get_mut(host_id)?;
        let state = &mut host.provider.github;
        let visible = visible_github_provider_selections(state);
        let current = match (state.selected_pull_request, state.selected_issue) {
            (Some(number), _) => Some(GitHubProviderSelection::PullRequest(number)),
            (None, Some(number)) => Some(GitHubProviderSelection::Issue(number)),
            (None, None) => None,
        };
        let current_index = visible
            .iter()
            .position(|selection| Some(*selection) == current);
        let selected_index = move_selection(current_index, visible.len(), direction)?;
        let selection = visible[selected_index];
        match selection {
            GitHubProviderSelection::PullRequest(number) => {
                state.selected_pull_request = Some(number);
                state.selected_issue = None;
            }
            GitHubProviderSelection::Issue(number) => {
                state.selected_pull_request = None;
                state.selected_issue = Some(number);
            }
        }
        Some(selection)
    }

    /// Opens (or replaces) `host_id`'s Review tab for a session's worktree
    /// diff and marks the fetch pending. Returns the request id the caller's
    /// async diff fetch must complete with via [`DomainEvent::ReviewDiffLoaded`]
    /// or [`DomainEvent::ReviewDiffFailed`].
    ///
    /// Resumes the most-recently-updated `Draft` review in `store` for this
    /// exact source (same host + session id), comments and all, instead of
    /// minting a fresh one — otherwise a persisted draft would become an
    /// unreachable orphan the moment the operator navigated away and back
    /// (reviews are expected to survive a GUI restart). Mints a new
    /// [`Review`] only when no matching draft exists on disk.
    pub fn begin_review_from_session(
        &mut self,
        host_id: HostId,
        store: &ReviewStore,
        session: &SessionInfo,
        project: impl Into<String>,
    ) -> ProviderRequestId {
        let request_id = self.next_provider_request_id();
        let source = ReviewSource::Session {
            host_id: host_id.clone(),
            session_id: session.id.clone(),
        };
        let review = resume_or_new_review(
            store,
            &source,
            project,
            session.branch.clone().unwrap_or_default(),
        );
        let host = self.host_for_ui(host_id);
        host.review = ReviewTabState {
            diff: ReviewDiffStatus::Fetching,
            active_review: Some(review),
            diff_request: Some(request_id),
            ..ReviewTabState::default()
        };
        request_id
    }

    /// Opens (or replaces) `host_id`'s Review tab for a GitHub pull request
    /// diff. See [`Self::begin_review_from_session`] for the resume
    /// rationale (same host + PR number here), which applies identically.
    pub fn begin_review_from_pull_request(
        &mut self,
        host_id: HostId,
        store: &ReviewStore,
        pr_number: u64,
        project: impl Into<String>,
        branch: impl Into<String>,
    ) -> ProviderRequestId {
        let request_id = self.next_provider_request_id();
        let source = ReviewSource::PullRequest {
            host_id: host_id.clone(),
            pr_number,
        };
        let review = resume_or_new_review(store, &source, project, branch);
        let host = self.host_for_ui(host_id);
        host.review = ReviewTabState {
            diff: ReviewDiffStatus::Fetching,
            active_review: Some(review),
            diff_request: Some(request_id),
            ..ReviewTabState::default()
        };
        request_id
    }

    /// Re-marks `host_id`'s Review tab diff fetch pending without disturbing
    /// the active draft review (its comments, dispatch state, file/line
    /// selection). Returns `None` (no-op) when there is no active review to
    /// refresh.
    pub fn begin_review_diff_refresh(&mut self, host_id: &HostId) -> Option<ProviderRequestId> {
        self.hosts.get(host_id)?.review.active_review.as_ref()?;
        let request_id = self.next_provider_request_id();
        let host = self.hosts.get_mut(host_id)?;
        host.review.diff = ReviewDiffStatus::Fetching;
        host.review.diff_request = Some(request_id);
        Some(request_id)
    }

    /// Selects a file in the Review tab's file list, clearing any line
    /// selection (mirrors clicking a file row rather than a specific line).
    pub fn select_review_file(&mut self, host_id: &HostId, file_index: usize) {
        let Some(host) = self.hosts.get_mut(host_id) else {
            return;
        };
        host.review.selected_file = Some(file_index);
        host.review.selected_line = None;
    }

    /// Selects one diff line directly (mouse click on a line).
    pub fn select_review_line(&mut self, host_id: &HostId, target: ReviewLineTarget) {
        let Some(host) = self.hosts.get_mut(host_id) else {
            return;
        };
        host.review.selected_file = Some(target.file_index);
        host.review.selected_line = Some(target);
    }

    /// Moves the Review tab's line cursor to the next selectable line,
    /// flowing from one file's lines into the next file's lines at the
    /// boundary (`docs/design/track-d-ui-brief.md` §3.9's "files → hunks →
    /// lines" browsing, folded into one continuous keyboard traversal).
    pub fn select_next_review_line(&mut self, host_id: &HostId) -> Option<ReviewLineTarget> {
        self.select_review_line_by_keyboard(host_id, SelectionDirection::Next)
    }

    /// Moves the Review tab's line cursor to the previous selectable line.
    pub fn select_previous_review_line(&mut self, host_id: &HostId) -> Option<ReviewLineTarget> {
        self.select_review_line_by_keyboard(host_id, SelectionDirection::Previous)
    }

    fn select_review_line_by_keyboard(
        &mut self,
        host_id: &HostId,
        direction: SelectionDirection,
    ) -> Option<ReviewLineTarget> {
        let host = self.hosts.get_mut(host_id)?;
        let ReviewDiffStatus::Loaded { model, .. } = &host.review.diff else {
            return None;
        };
        let targets = flattened_review_line_targets(model);
        let current_index = host
            .review
            .selected_line
            .and_then(|current| targets.iter().position(|target| *target == current));
        let selected_index = move_selection(current_index, targets.len(), direction)?;
        let target = targets[selected_index];
        host.review.selected_file = Some(target.file_index);
        host.review.selected_line = Some(target);
        Some(target)
    }

    /// Opens the inline comment editor for the currently selected line with a
    /// blank draft. Returns `false` (no-op) when no line is selected or the
    /// diff is not loaded.
    pub fn begin_review_comment(&mut self, host_id: &HostId) -> bool {
        let Some(host) = self.hosts.get_mut(host_id) else {
            return false;
        };
        let ReviewDiffStatus::Loaded { model, .. } = &host.review.diff else {
            return false;
        };
        let Some(target) = host.review.selected_line else {
            return false;
        };
        let Some((path, side, line)) = review_line_anchor(model, target) else {
            return false;
        };
        host.review.comment_editor = Some(ReviewCommentEditor {
            path,
            side,
            line,
            draft_text: String::new(),
            editing_index: None,
        });
        true
    }

    /// Opens the inline comment editor pre-filled to edit an existing
    /// comment on the active review. Returns `false` (no-op) when there is no
    /// active review or `index` is out of range.
    pub fn begin_edit_review_comment(&mut self, host_id: &HostId, index: usize) -> bool {
        let Some(host) = self.hosts.get_mut(host_id) else {
            return false;
        };
        let Some(review) = &host.review.active_review else {
            return false;
        };
        let Some(comment) = review.comments.get(index) else {
            return false;
        };
        host.review.comment_editor = Some(ReviewCommentEditor {
            path: comment.path.clone(),
            side: comment.side,
            line: comment.line,
            draft_text: comment.text.clone(),
            editing_index: Some(index),
        });
        true
    }

    /// Updates the open comment editor's draft text. No-op without an open
    /// editor.
    pub fn update_review_comment_draft(&mut self, host_id: &HostId, text: String) {
        let Some(host) = self.hosts.get_mut(host_id) else {
            return;
        };
        let Some(editor) = &mut host.review.comment_editor else {
            return;
        };
        editor.draft_text = text;
    }

    /// Closes the comment editor without saving.
    pub fn cancel_review_comment_editor(&mut self, host_id: &HostId) {
        let Some(host) = self.hosts.get_mut(host_id) else {
            return;
        };
        host.review.comment_editor = None;
    }

    /// Saves the open comment editor: appends a new comment, or edits the one
    /// at `editing_index` in place, persists the review via `store`, and
    /// closes the editor. No-op returning `Ok(())` when no editor is open or
    /// there is no active review (idempotent under a double-submit).
    ///
    /// # Errors
    ///
    /// Returns [`CoreError::ReviewStore`] when persisting fails; the
    /// in-memory review still reflects the added/edited comment (only the
    /// disk write failed), so the next successful save includes it.
    pub fn save_review_comment(
        &mut self,
        host_id: &HostId,
        store: &ReviewStore,
    ) -> Result<(), CoreError> {
        let Some(host) = self.hosts.get_mut(host_id) else {
            return Ok(());
        };
        let Some(editor) = host.review.comment_editor.take() else {
            return Ok(());
        };
        let Some(review) = &mut host.review.active_review else {
            return Ok(());
        };
        if let Some(index) = editor.editing_index {
            review.edit_comment(index, editor.draft_text);
        } else {
            review.add_comment(ReviewComment::new(
                editor.path,
                editor.side,
                editor.line,
                editor.draft_text,
            ));
        }
        store.save(review)?;
        Ok(())
    }

    /// Removes the comment at `index` from the active review and persists.
    ///
    /// # Errors
    ///
    /// Returns [`CoreError::ReviewStore`] when persisting fails.
    pub fn remove_review_comment(
        &mut self,
        host_id: &HostId,
        store: &ReviewStore,
        index: usize,
    ) -> Result<(), CoreError> {
        let Some(host) = self.hosts.get_mut(host_id) else {
            return Ok(());
        };
        let Some(review) = &mut host.review.active_review else {
            return Ok(());
        };
        review.remove_comment(index);
        store.save(review)?;
        Ok(())
    }

    /// Opens the "Dispatch as session…" modal for the active review, seeded
    /// with a prompt preview render outcome, the resolved agent label, and
    /// whether the source session is currently working.
    pub fn open_review_dispatch_modal(
        &mut self,
        host_id: &HostId,
        prompt_preview: Result<String, String>,
        agent: String,
        source_working: bool,
    ) {
        let Some(host) = self.hosts.get_mut(host_id) else {
            return;
        };
        host.review.dispatch = Some(ReviewDispatchModal {
            prompt_preview,
            agent,
            source_working,
            dispatch_error: None,
        });
    }

    /// Closes the dispatch modal without dispatching.
    pub fn close_review_dispatch_modal(&mut self, host_id: &HostId) {
        let Some(host) = self.hosts.get_mut(host_id) else {
            return;
        };
        host.review.dispatch = None;
    }

    /// Sets the dispatch modal's agent picker to `agent`, overriding the
    /// source session's profile for the dispatched session. No-op without an
    /// open dispatch modal.
    pub fn set_review_dispatch_agent(&mut self, host_id: &HostId, agent: String) {
        let Some(host) = self.hosts.get_mut(host_id) else {
            return;
        };
        let Some(dispatch) = &mut host.review.dispatch else {
            return;
        };
        dispatch.agent = agent;
    }

    /// Select a session in the detail pane.
    pub fn select_session(&mut self, host_id: HostId, session_id: SessionId) {
        self.invalidate_github_provider_requests(&host_id);
        self.selection = Some(Selection::Session {
            host_id,
            session_id,
        });
    }

    /// Selects the session linked to a notification, when that session is
    /// still live.
    ///
    /// Returns `true` and updates [`Workspace::selection`] when a live linked
    /// session was found; returns `false` and leaves the selection untouched
    /// otherwise. The inbox modal is the only route to notification detail, so
    /// there is no selection-based fallback to fall back to here — callers
    /// (the modal's "Open session" action) only invoke this once the session
    /// is known live from the same [`HostView`] data.
    pub fn select_notification_session(
        &mut self,
        host_id: &HostId,
        notification_id: &NotificationId,
    ) -> bool {
        let linked_session = self.hosts.get(host_id).and_then(|host| {
            let record = host.notifications.get(&notification_id.0)?;
            let session_id = record.session_id.as_ref()?;
            host.sessions
                .contains_key(&session_id.0)
                .then(|| session_id.clone())
        });
        let Some(session_id) = linked_session else {
            return false;
        };
        self.invalidate_github_provider_requests(host_id);
        self.selection = Some(Selection::Session {
            host_id: host_id.clone(),
            session_id,
        });
        true
    }

    /// Total unread notifications across all hosts.
    #[must_use]
    pub fn unread_notification_count(&self) -> usize {
        self.hosts.values().map(host_unread_count).sum()
    }

    /// Unread notifications for a single host.
    #[must_use]
    pub fn host_unread_notification_count(&self, host_id: &HostId) -> usize {
        self.hosts.get(host_id).map_or(0, host_unread_count)
    }

    /// Notifications matching `filter`, newest first.
    ///
    /// Ordering is by the stable `(created_at desc, id)` identity, never by the
    /// volatile lifecycle status, so marking a record read does not reshuffle
    /// rows under the operator's cursor.
    #[must_use]
    pub fn notifications(&self, filter: &NotificationFilter) -> Vec<NotificationRow> {
        let mut rows = Vec::new();
        for (host_id, host) in &self.hosts {
            if filter
                .host_id
                .as_ref()
                .is_some_and(|wanted| wanted != host_id)
            {
                continue;
            }
            for record in host.notifications.values() {
                if filter.matches(record) {
                    rows.push(NotificationRow {
                        host_id: host_id.clone(),
                        record: record.clone(),
                    });
                }
            }
        }
        rows.sort_by(|left, right| {
            cmp_rfc3339(&right.record.created_at, &left.record.created_at)
                .then_with(|| left.record.id.0.cmp(&right.record.id.0))
        });
        rows
    }

    /// Notification rows for the activity modal.
    ///
    /// `scope` narrows by lifecycle, `filter` narrows by host as with
    /// [`Workspace::notifications`], and the stable newest-first ordering is
    /// preserved. Read state never moves a row under the operator's cursor.
    #[must_use]
    pub fn inbox_rows(
        &self,
        scope: NotificationScope,
        filter: &NotificationFilter,
    ) -> Vec<NotificationRow> {
        self.notifications(filter)
            .into_iter()
            .filter(|row| scope.matches(&row.record))
            .collect()
    }

    /// Look up one notification record by host and id.
    #[must_use]
    pub fn notification(
        &self,
        host_id: &HostId,
        id: &NotificationId,
    ) -> Option<&NotificationRecord> {
        self.hosts.get(host_id)?.notifications.get(&id.0)
    }

    /// Return one session's durable activity, newest first.
    #[must_use]
    pub fn session_activity(
        &self,
        host_id: &HostId,
        session_id: &SessionId,
    ) -> Vec<NotificationRecord> {
        let Some(host) = self.hosts.get(host_id) else {
            return Vec::new();
        };
        let mut records: Vec<NotificationRecord> = host
            .notifications
            .values()
            .filter(|record| {
                record.session_id.as_ref() == Some(session_id)
                    && record.status != NotificationStatus::Deleted
            })
            .cloned()
            .collect();
        records.sort_by(|left, right| {
            cmp_rfc3339(&right.created_at, &left.created_at)
                .then_with(|| left.id.0.cmp(&right.id.0))
        });
        records
    }

    /// Build the prioritized native-GUI session list.
    ///
    /// Rows are grouped by operator urgency, then ordered by project label,
    /// session name (or id), host, and session id. Activity changes may move a
    /// row between groups, but never reorder unrelated rows inside one group.
    #[must_use]
    pub fn session_rows(&self) -> Vec<SessionRow> {
        self.session_rows_filtered(None)
    }

    /// Build [`Workspace::session_rows`] restricted to `filter`'s project.
    ///
    /// `None` keeps every row, including sessions without a project.
    #[must_use]
    pub fn session_rows_filtered(&self, filter: Option<&ProjectRef>) -> Vec<SessionRow> {
        let mut rows = Vec::new();
        for (host_id, host) in &self.hosts {
            for session in host.sessions.values() {
                let project = session.project_id.as_ref().map(|project_id| ProjectRef {
                    host_id: host_id.clone(),
                    project_id: project_id.clone(),
                });
                if filter.is_some_and(|wanted| project.as_ref() != Some(wanted)) {
                    continue;
                }
                let attention = active_session_attention(host, session);
                let access = session_access(session);
                rows.push(SessionRow {
                    host_id: host_id.clone(),
                    host_label: self.host_label(host_id),
                    session_id: session.id.clone(),
                    name: session.name.clone(),
                    project_label: session.project_id.as_deref().map(|project_id| {
                        session
                            .project_label
                            .clone()
                            .unwrap_or_else(|| project_display_label(host, project_id))
                    }),
                    project,
                    agent: session.agent.clone(),
                    activity: session.activity,
                    state: session.state,
                    branch: session.branch.clone(),
                    worktree_path: session.worktree_path.clone(),
                    updated_at: session.updated_at.clone(),
                    group: session_group(session, access, attention.is_some()),
                    attention,
                    access,
                    can_stop: session_can_stop(session),
                    can_remove: session_can_remove(session),
                    subagents: subagent_counts(&session.subagents),
                    link: work_link(session),
                });
            }
        }
        rows.sort_by(|left, right| {
            left.group
                .cmp(&right.group)
                .then_with(|| left.project_label.cmp(&right.project_label))
                .then_with(|| left.display_name().cmp(right.display_name()))
                .then_with(|| left.host_id.cmp(&right.host_id))
                .then_with(|| left.session_id.0.cmp(&right.session_id.0))
        });
        rows
    }

    /// Known projects of every host, for launch pickers.
    ///
    /// Sorted by label, then host id, then project id.
    #[must_use]
    pub fn project_choices(&self) -> Vec<ProjectChoice> {
        let mut choices: Vec<ProjectChoice> = self
            .hosts
            .iter()
            .flat_map(|(host_id, host)| {
                host.projects.values().map(move |info| ProjectChoice {
                    project: ProjectRef {
                        host_id: host_id.clone(),
                        project_id: info.id.clone(),
                    },
                    label: info.label.clone(),
                    host_label: self.host_label(host_id),
                    host_connected: host.conn == ConnState::Connected,
                    known: true,
                    session_count: host
                        .sessions
                        .values()
                        .filter(|session| session.project_id.as_deref() == Some(info.id.as_str()))
                        .count(),
                })
            })
            .collect();
        sort_project_choices(&mut choices);
        choices
    }

    /// Projects that currently have at least one session, for the filter row.
    ///
    /// Includes project ids no [`ProjectInfo`] describes (`known == false`).
    /// Sorted like [`Workspace::project_choices`].
    #[must_use]
    pub fn session_project_filters(&self) -> Vec<ProjectChoice> {
        let mut choices = Vec::new();
        for (host_id, host) in &self.hosts {
            let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
            for project_id in host
                .sessions
                .values()
                .filter_map(|session| session.project_id.as_deref())
            {
                *counts.entry(project_id).or_default() += 1;
            }
            for (project_id, session_count) in counts {
                choices.push(ProjectChoice {
                    project: ProjectRef {
                        host_id: host_id.clone(),
                        project_id: project_id.to_owned(),
                    },
                    label: project_display_label(host, project_id),
                    host_label: self.host_label(host_id),
                    host_connected: host.conn == ConnState::Connected,
                    known: host.projects.contains_key(project_id),
                    session_count,
                });
            }
        }
        sort_project_choices(&mut choices);
        choices
    }
}

/// Label of `project_id` on `host`, falling back to the id itself when the
/// host has no matching [`ProjectInfo`].
fn project_display_label(host: &HostView, project_id: &str) -> String {
    host.projects
        .get(project_id)
        .map_or_else(|| project_id.to_owned(), |info| info.label.clone())
}

/// Display labels for `choices`, in the same order.
///
/// A label is qualified with its host when `always_host` is set or another
/// choice shares the label, and additionally with the project id when another
/// choice shares both label and host (the daemon allows duplicate labels).
#[must_use]
pub fn project_choice_labels(choices: &[ProjectChoice], always_host: bool) -> Vec<String> {
    const SEPARATOR: &str = "  ·  ";
    let mut by_label: BTreeMap<&str, usize> = BTreeMap::new();
    let mut by_host_label: BTreeMap<(&HostId, &str), usize> = BTreeMap::new();
    for choice in choices {
        *by_label.entry(choice.label.as_str()).or_default() += 1;
        *by_host_label
            .entry((&choice.project.host_id, choice.label.as_str()))
            .or_default() += 1;
    }
    choices
        .iter()
        .map(|choice| {
            let mut label = choice.label.clone();
            if always_host || by_label[choice.label.as_str()] > 1 {
                label.push_str(SEPARATOR);
                label.push_str(&choice.host_label);
            }
            if by_host_label[&(&choice.project.host_id, choice.label.as_str())] > 1 {
                label.push_str(SEPARATOR);
                label.push_str(&choice.project.project_id);
            }
            label
        })
        .collect()
}

/// Number of trailing route-id characters that tell hosts with equal labels apart.
const ROUTE_ID_SUFFIX_CHARS: usize = 4;

fn route_id_suffix(host_id: &HostId) -> String {
    let chars: Vec<char> = host_id.as_str().chars().collect();
    let start = chars.len().saturating_sub(ROUTE_ID_SUFFIX_CHARS);
    chars[start..].iter().collect()
}

fn sort_project_choices(choices: &mut [ProjectChoice]) {
    choices.sort_by(|left, right| {
        left.label
            .cmp(&right.label)
            .then_with(|| left.project.cmp(&right.project))
    });
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SelectionDirection {
    Next,
    Previous,
}

fn move_selection(
    current_index: Option<usize>,
    visible_len: usize,
    direction: SelectionDirection,
) -> Option<usize> {
    if visible_len == 0 {
        return None;
    }
    Some(match (current_index, direction) {
        (None, SelectionDirection::Next) => 0,
        (None | Some(0), SelectionDirection::Previous) => visible_len - 1,
        (Some(index), SelectionDirection::Next) => (index + 1) % visible_len,
        (Some(index), SelectionDirection::Previous) => index - 1,
    })
}

/// Resumes the most-recently-updated `Draft` review in `store` whose
/// `source` matches exactly, or mints a fresh one when none does.
///
/// Comparing `ReviewSource` by `PartialEq` is an exact identity check
/// already (host id together with session id for `Session`, host id together
/// with PR number for `PullRequest`), so no separate lookup key is needed. A
/// corrupt review file surfaces via `ReviewStore::load_all`'s `Err` entries,
/// which this silently skips: it simply cannot match anything, the same as
/// an unrelated review would, never mistaking a broken file for "no draft
/// exists" in a way that could shadow a real one. Surfacing the corrupt-file
/// condition itself remains `ReviewStore`'s own concern, not this resume
/// lookup's.
fn resume_or_new_review(
    store: &ReviewStore,
    source: &ReviewSource,
    project: impl Into<String>,
    branch: impl Into<String>,
) -> Review {
    let existing = latest_draft_for(source, store.load_all().into_iter().filter_map(Result::ok));
    existing.unwrap_or_else(|| Review::new(source.clone(), project, branch))
}

/// Picks the draft of `source` with the latest `updated_at` instant; equal
/// instants resolve to the largest review id, independent of iteration order.
fn latest_draft_for(
    source: &ReviewSource,
    reviews: impl IntoIterator<Item = Review>,
) -> Option<Review> {
    reviews
        .into_iter()
        .filter(|review| &review.source == source && review.status == ReviewStatus::Draft)
        .max_by(|left, right| {
            cmp_rfc3339(&left.updated_at, &right.updated_at).then_with(|| left.id.cmp(&right.id))
        })
}

/// Flattens every selectable line across every file/hunk of `model`, in
/// source order, so the Review tab's keyboard nav can move through one
/// continuous list spanning "files → hunks → lines".
fn flattened_review_line_targets(model: &DiffModel) -> Vec<ReviewLineTarget> {
    let mut targets = Vec::new();
    for (file_index, file) in model.files.iter().enumerate() {
        for (hunk_index, hunk) in file.hunks.iter().enumerate() {
            for line_index in 0..hunk.lines.len() {
                targets.push(ReviewLineTarget {
                    file_index,
                    hunk_index,
                    line_index,
                });
            }
        }
    }
    targets
}

/// Resolves the `path`/`side`/`line` a new comment on `target` should anchor
/// to: the new-side line number when the line has one (an added or context
/// line), otherwise the old-side line number (a removed line has no new-side
/// counterpart). Returns `None` when `target` does not resolve to a line in
/// `model` (stale selection against a since-changed diff).
fn review_line_anchor(
    model: &DiffModel,
    target: ReviewLineTarget,
) -> Option<(String, ReviewSide, u32)> {
    let file = model.files.get(target.file_index)?;
    let hunk = file.hunks.get(target.hunk_index)?;
    let line = hunk.lines.get(target.line_index)?;
    let (side, number) = match (line.new_line, line.old_line) {
        (Some(new_line), _) => (ReviewSide::New, new_line),
        (None, Some(old_line)) => (ReviewSide::Old, old_line),
        (None, None) => return None,
    };
    Some((file.path.clone(), side, number))
}

fn visible_linear_issue_ids(state: &LinearProviderState) -> Vec<String> {
    state
        .issues
        .iter()
        .filter(|issue| linear_issue_matches_search(issue, &state.search))
        .map(|issue| issue.prompt_item_id().to_owned())
        .collect()
}

fn linear_issue_matches_search(issue: &providers::linear::LinearIssue, search: &str) -> bool {
    let search = search.trim().to_lowercase();
    search.is_empty()
        || issue.title.to_lowercase().contains(&search)
        || issue.identifier.to_lowercase().contains(&search)
        || issue.prompt_item_id().to_lowercase().contains(&search)
        || issue.branch.to_lowercase().contains(&search)
}

fn visible_github_pull_request_numbers(state: &GitHubProviderState) -> Vec<u64> {
    state
        .pull_requests
        .iter()
        .filter(|pull_request| github_pull_request_matches_search(pull_request, &state.search))
        .map(|pull_request| pull_request.number)
        .collect()
}

fn github_pull_request_matches_search(
    pull_request: &providers::github::GitHubPullRequest,
    search: &str,
) -> bool {
    let search = search.trim().to_lowercase();
    search.is_empty()
        || pull_request.title.to_lowercase().contains(&search)
        || pull_request.number.to_string().contains(&search)
        || pull_request.head_ref_name.to_lowercase().contains(&search)
}

fn visible_github_issue_numbers(state: &GitHubProviderState) -> Vec<u64> {
    state
        .issues
        .iter()
        .filter(|issue| github_issue_matches_search(issue, &state.search))
        .map(|issue| issue.number)
        .collect()
}

fn visible_github_provider_selections(state: &GitHubProviderState) -> Vec<GitHubProviderSelection> {
    let pull_requests = state
        .pull_requests
        .iter()
        .filter(|pull_request| github_pull_request_matches_search(pull_request, &state.search))
        .map(|pull_request| GitHubProviderSelection::PullRequest(pull_request.number));
    let issues = state
        .issues
        .iter()
        .filter(|issue| github_issue_matches_search(issue, &state.search))
        .map(|issue| GitHubProviderSelection::Issue(issue.number));
    pull_requests.chain(issues).collect()
}

fn github_issue_matches_search(issue: &providers::github::GitHubIssue, search: &str) -> bool {
    let search = search.trim().to_lowercase();
    search.is_empty()
        || issue.title.to_lowercase().contains(&search)
        || issue.number.to_string().contains(&search)
}

fn apply_provider_request_failure(
    host_id: &HostId,
    host: &mut HostView,
    provider: SessionLinkProvider,
    operation: ProviderOperation,
    request_id: Option<ProviderRequestId>,
) -> bool {
    let Some(request_id) = request_id else {
        return true;
    };
    match (provider, operation) {
        (SessionLinkProvider::Linear, ProviderOperation::LinearIssues) => {
            if host.provider.linear.active_request != Some(request_id) {
                trace_ignored_provider_failure(
                    host_id,
                    provider,
                    operation,
                    request_id,
                    "stale_request",
                );
                return false;
            }
            host.provider.linear.active_request = None;
            true
        }
        (SessionLinkProvider::GitHub, ProviderOperation::GitHubPullRequests) => {
            if host.provider.github.pull_requests_request != Some(request_id) {
                trace_ignored_provider_failure(
                    host_id,
                    provider,
                    operation,
                    request_id,
                    "stale_request",
                );
                return false;
            }
            host.provider.github.pull_requests_request = None;
            true
        }
        (SessionLinkProvider::GitHub, ProviderOperation::GitHubIssues) => {
            if host.provider.github.issues_request != Some(request_id) {
                trace_ignored_provider_failure(
                    host_id,
                    provider,
                    operation,
                    request_id,
                    "stale_request",
                );
                return false;
            }
            host.provider.github.issues_request = None;
            true
        }
        (SessionLinkProvider::GitHub, ProviderOperation::GitHubPullRequestStatus) => {
            if host.provider.github.pull_request_status_request != Some(request_id) {
                trace_ignored_provider_failure(
                    host_id,
                    provider,
                    operation,
                    request_id,
                    "stale_request",
                );
                return false;
            }
            host.provider.github.pull_request_status_request = None;
            true
        }
        (_, ProviderOperation::Launch) => true,
        _ => false,
    }
}

fn trace_ignored_unknown_host(host_id: &HostId, reason: &'static str) {
    tracing::event!(
        name: "gui.host.result.ignored",
        tracing::Level::DEBUG,
        host_id = %host_id,
        reason,
        "ignoring result for unknown host"
    );
}

fn trace_ignored_provider_result(
    host_id: &HostId,
    provider: SessionLinkProvider,
    operation: ProviderOperation,
    request_id: ProviderRequestId,
    reason: &'static str,
) {
    tracing::event!(
        name: "gui.provider.result.ignored",
        tracing::Level::DEBUG,
        host_id = %host_id,
        provider = ?provider,
        operation = ?operation,
        request_id = request_id.get(),
        reason,
        "ignoring provider result"
    );
}

fn trace_ignored_provider_failure(
    host_id: &HostId,
    provider: SessionLinkProvider,
    operation: ProviderOperation,
    request_id: ProviderRequestId,
    reason: &'static str,
) {
    tracing::event!(
        name: "gui.provider.failure.ignored",
        tracing::Level::DEBUG,
        host_id = %host_id,
        provider = ?provider,
        operation = ?operation,
        request_id = request_id.get(),
        reason,
        "ignoring provider failure"
    );
}

fn session_access(session: &SessionInfo) -> SessionAccess {
    if session.external == Some(true) {
        return SessionAccess::Unavailable;
    }

    if session.state.is_terminal() {
        return if session_can_resume(session) {
            SessionAccess::Resume
        } else {
            SessionAccess::Unavailable
        };
    }

    match session.runtime.as_ref().map(|runtime| runtime.state) {
        None | Some(RuntimeState::Live) if session.state == SessionState::Running => {
            SessionAccess::Attach
        }
        None | Some(RuntimeState::Starting | RuntimeState::Reconnecting) => SessionAccess::Pending,
        Some(RuntimeState::Lost) if session_can_resume(session) => SessionAccess::Resume,
        Some(
            RuntimeState::Terminal
            | RuntimeState::Lost
            | RuntimeState::Conflict
            | RuntimeState::Incompatible
            | RuntimeState::Live,
        ) => SessionAccess::Unavailable,
    }
}

fn session_can_resume(session: &SessionInfo) -> bool {
    session.capabilities.resume
        && (session
            .native_session_id
            .as_deref()
            .is_some_and(|value| !value.is_empty())
            || session
                .native_session_path
                .as_deref()
                .is_some_and(|value| !value.is_empty()))
}

/// Stop affordance for one session row.
///
/// The rule lives on [`SessionInfo`] so the GUI and the daemon's retention
/// sweep cannot drift apart.
fn session_can_stop(session: &SessionInfo) -> bool {
    session.can_stop()
}

/// Remove affordance for one session row.
///
/// Shares [`SessionInfo::can_remove`] with the daemon's retention sweep.
fn session_can_remove(session: &SessionInfo) -> bool {
    session.can_remove()
}

fn session_group(session: &SessionInfo, access: SessionAccess, needs_you: bool) -> SessionGroup {
    if needs_you {
        return SessionGroup::NeedsYou;
    }
    if session.state == SessionState::Starting
        || session.activity == Some(AgentActivity::Working)
        || access == SessionAccess::Pending
    {
        return SessionGroup::Running;
    }
    if access == SessionAccess::Attach
        && matches!(session.activity, None | Some(AgentActivity::Idle))
    {
        return SessionGroup::Ready;
    }
    SessionGroup::Unavailable
}

/// Session-list group in display priority order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SessionGroup {
    /// A session currently waiting for operator input, approval, or failure review.
    NeedsYou,
    /// An attachable live session that is not currently working.
    Ready,
    /// A session that is working, starting, or reconnecting.
    Running,
    /// A terminal, external, conflicting, incompatible, or otherwise unusable session.
    Unavailable,
}

/// Operator access currently available for one session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionAccess {
    /// Attach to the existing live PTY now.
    Attach,
    /// Recover from native metadata, then attach to the new PTY.
    Resume,
    /// Wait for startup or daemon-to-worker reconnection to finish.
    Pending,
    /// No safe open operation is currently available.
    Unavailable,
}

/// Identifies one project on one host.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProjectRef {
    pub host_id: HostId,
    pub project_id: String,
}

/// One project offered by a launch picker or the session filter row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectChoice {
    pub project: ProjectRef,
    /// Project label, or the project id when the host has no such project.
    pub label: String,
    /// Display name of the owning host.
    pub host_label: String,
    /// Whether the owning host is currently connected.
    pub host_connected: bool,
    /// `false` when only sessions reference the project and the host lists no
    /// matching [`ProjectInfo`].
    pub known: bool,
    /// Sessions currently assigned to the project.
    pub session_count: usize,
}

/// Derived row for the prioritized session list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRow {
    pub host_id: HostId,
    /// Display name of the owning host.
    pub host_label: String,
    pub session_id: SessionId,
    /// Owner-set display name, or `None` to show the session id.
    pub name: Option<String>,
    /// Owning project, or `None` for a session without git identity.
    pub project: Option<ProjectRef>,
    /// Project display label: the session's own label, else the host's label
    /// for the project, else the project id. `None` only without a project.
    pub project_label: Option<String>,
    pub agent: String,
    pub activity: Option<AgentActivity>,
    pub state: SessionState,
    pub branch: Option<String>,
    /// Bound worktree path, when the session was launched in one.
    pub worktree_path: Option<PathBuf>,
    /// Last update timestamp in the daemon's wire timestamp format.
    pub updated_at: String,
    pub group: SessionGroup,
    /// Current live owner-attention signal, distinct from unread history.
    pub attention: Option<SessionAttention>,
    pub access: SessionAccess,
    /// Whether a direct stop request is safe for this runtime state.
    pub can_stop: bool,
    /// Whether removal can safely stop or discard the current logical session.
    pub can_remove: bool,
    /// Running and observed subagent counts.
    pub subagents: SubagentCounts,
    /// Work item the session is linked to, when it carries a link.
    pub link: Option<WorkLink>,
}

impl SessionRow {
    /// Owner-set name, or the session id when none was set.
    #[must_use]
    pub fn display_name(&self) -> &str {
        self.name.as_deref().unwrap_or(&self.session_id.0)
    }
}

/// Current owner-attention signal displayed directly on a session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionAttention {
    /// Attention category used for the compact session-row label.
    pub kind: NotificationKind,
    /// Most relevant current notification title or detector fallback.
    pub title: String,
}

fn active_session_attention(host: &HostView, session: &SessionInfo) -> Option<SessionAttention> {
    let blocked = session.activity == Some(AgentActivity::Blocked);
    let failed = session.state == SessionState::Failed;
    let record = host
        .notifications
        .values()
        .filter(|record| {
            record.session_id.as_ref() == Some(&session.id)
                && matches!(
                    record.status,
                    NotificationStatus::Unread | NotificationStatus::Read
                )
                && (record.kind == NotificationKind::ApprovalRequired
                    || blocked && record.kind == NotificationKind::AgentBlocked
                    || failed
                        && (record.kind == NotificationKind::Error
                            || record.severity == NotificationSeverity::Error))
        })
        .max_by(|left, right| {
            cmp_rfc3339(&left.created_at, &right.created_at)
                .then_with(|| right.id.0.cmp(&left.id.0))
        });
    record.map_or_else(
        || {
            if blocked {
                Some(SessionAttention {
                    kind: NotificationKind::AgentBlocked,
                    title: "Waiting for input".to_owned(),
                })
            } else if failed {
                Some(SessionAttention {
                    kind: NotificationKind::Error,
                    title: "Session failed".to_owned(),
                })
            } else {
                None
            }
        },
        |record| {
            Some(SessionAttention {
                kind: record.kind,
                title: record.title.clone(),
            })
        },
    )
}

fn apply_host_event(
    host: &mut HostView,
    host_id: &HostId,
    event: HostEvent,
    notifications: &mut Vec<NotificationIntent>,
    toasts: &mut Vec<Toast>,
    next_intent_id: &mut u64,
    runtime_continuity: &mut BTreeMap<(HostId, String), RuntimeContinuity>,
) {
    match event {
        HostEvent::AgentState(state) => {
            if let Some(session) = host.sessions.get_mut(&state.session_id.0) {
                session.activity = Some(state.activity);
                session.state_source = state.source;
            }
            host.last_agent_state = Some(state);
        }
        HostEvent::SubagentState(state) => {
            if let Some(session) = host.sessions.get_mut(&state.session_id.0) {
                let runtime_matches = state.runtime.as_ref().is_some_and(|event_runtime| {
                    session.runtime.as_ref().is_some_and(|session_runtime| {
                        session_runtime.worker_instance_id.as_deref()
                            == Some(event_runtime.worker_instance_id())
                            && session_runtime.runtime_generation
                                == event_runtime.runtime_generation()
                    })
                });
                if !runtime_matches {
                    return;
                }
                match session.subagents.iter_mut().find(|subagent| {
                    subagent.provider == state.subagent.provider && subagent.id == state.subagent.id
                }) {
                    Some(current) if current.revision < state.subagent.revision => {
                        *current = state.subagent;
                    }
                    None => session.subagents.push(state.subagent),
                    Some(_) => {}
                }
            }
        }
        HostEvent::SessionCreated(session)
        | HostEvent::SessionUpdated(session)
        | HostEvent::SessionStopped(session) => {
            if host
                .sessions
                .get(&session.id.0)
                .is_some_and(|previous| runtime_generation_changed(previous, &session))
            {
                runtime_continuity.insert(
                    (host_id.clone(), session.id.0.clone()),
                    RuntimeContinuity::Recovered,
                );
            }
            host.sessions.insert(session.id.0.clone(), session);
        }
        HostEvent::SessionRemoved(session) => {
            host.sessions.remove(&session.id.0);
            runtime_continuity.remove(&(host_id.clone(), session.id.0));
        }
        HostEvent::RuntimeReconnected(session) => {
            runtime_continuity.insert(
                (host_id.clone(), session.id.0.clone()),
                RuntimeContinuity::Reconnected,
            );
            host.sessions.insert(session.id.0.clone(), session);
        }
        HostEvent::NativeRecovered(session) => {
            runtime_continuity.insert(
                (host_id.clone(), session.id.0.clone()),
                RuntimeContinuity::Recovered,
            );
            host.sessions.insert(session.id.0.clone(), session);
        }
        HostEvent::RuntimeLost(session) | HostEvent::RuntimeConflict(session) => {
            host.sessions.insert(session.id.0.clone(), session);
        }
        HostEvent::NotificationCreated(record) => {
            // A freshly created durable notification is the single source of OS
            // notifications: the daemon projector emits a durable `agent_blocked`
            // for a blocked session, which replaces the removed transient path.
            push_notification_effects(&record, host_id, notifications, toasts, next_intent_id);
            upsert_notification(&mut host.notifications, record);
        }
        HostEvent::NotificationUpdated(record) => {
            // Lifecycle/content changes (read, ack, archive, supersede) update the
            // stored record but never re-raise an OS intent.
            upsert_notification(&mut host.notifications, record);
        }
        HostEvent::NotificationDeleted(id) => {
            remove_notification(&mut host.notifications, &id);
        }
        HostEvent::Other(_) => {}
    }
}

fn observation_invalidation_for_host_event(host: &HostView, event: &HostEvent) -> Option<String> {
    let session = match event {
        HostEvent::SessionCreated(session)
        | HostEvent::SessionUpdated(session)
        | HostEvent::SessionStopped(session)
        | HostEvent::RuntimeReconnected(session)
        | HostEvent::NativeRecovered(session)
        | HostEvent::RuntimeLost(session)
        | HostEvent::RuntimeConflict(session) => session,
        HostEvent::SessionRemoved(session) => return Some(session.id.0.clone()),
        HostEvent::AgentState(_)
        | HostEvent::SubagentState(_)
        | HostEvent::NotificationCreated(_)
        | HostEvent::NotificationUpdated(_)
        | HostEvent::NotificationDeleted(_)
        | HostEvent::Other(_) => return None,
    };
    host.sessions
        .get(&session.id.0)
        .is_some_and(|previous| runtime_generation_changed(previous, session))
        .then(|| session.id.0.clone())
}

fn session_worker_instance_identity(
    session: &SessionInfo,
) -> Option<(&str, protocol::RuntimeGeneration)> {
    session.runtime.as_ref().and_then(|runtime| {
        runtime
            .worker_instance_id
            .as_deref()
            .map(|worker_instance_id| (worker_instance_id, runtime.runtime_generation))
    })
}

fn same_runtime_generation(previous: &SessionInfo, current: &SessionInfo) -> bool {
    session_worker_instance_identity(previous)
        .zip(session_worker_instance_identity(current))
        .is_some_and(|(previous_identity, current_identity)| previous_identity == current_identity)
}

fn runtime_generation_changed(previous: &SessionInfo, current: &SessionInfo) -> bool {
    session_worker_instance_identity(previous) != session_worker_instance_identity(current)
}

/// Store or replace a notification record, dropping it when the daemon reports a
/// deleted lifecycle status so a hard-removed record cannot linger in the inbox.
fn upsert_notification(
    store: &mut BTreeMap<String, NotificationRecord>,
    record: NotificationRecord,
) {
    if record.status == NotificationStatus::Deleted {
        store.remove(&record.id.0);
    } else {
        store.insert(record.id.0.clone(), record);
    }
}

/// Remove a notification record by id.
fn remove_notification(store: &mut BTreeMap<String, NotificationRecord>, id: &NotificationId) {
    store.remove(&id.0);
}

/// Count unread notifications held by one host.
fn host_unread_count(host: &HostView) -> usize {
    host.notifications
        .values()
        .filter(|record| record.status == NotificationStatus::Unread)
        .count()
}

/// Whether a freshly created notification warrants a desktop OS notification.
///
/// Only durable action-required and error notifications interrupt the operator;
/// informational, success, and warning records land in the inbox silently.
fn notification_raises_intent(record: &NotificationRecord) -> bool {
    matches!(
        record.severity,
        NotificationSeverity::ActionRequired | NotificationSeverity::Error
    )
}

/// Append the OS intent (and, when session-linked, the in-app toast) for a newly
/// created notification that warrants an interrupt.
fn push_notification_effects(
    record: &NotificationRecord,
    host_id: &HostId,
    notifications: &mut Vec<NotificationIntent>,
    toasts: &mut Vec<Toast>,
    next_intent_id: &mut u64,
) {
    if !notification_raises_intent(record) {
        return;
    }
    let id = *next_intent_id;
    *next_intent_id += 1;
    notifications.push(NotificationIntent {
        id,
        host_id: host_id.clone(),
        notification_id: Some(record.id.clone()),
        session_id: record.session_id.clone(),
        title: record.title.clone(),
        body: record.body.clone(),
    });
    if let Some(session_id) = record.session_id.clone() {
        toasts.push(Toast {
            id,
            host_id: host_id.clone(),
            session_id,
            message: record.body.clone(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, activity: Option<AgentActivity>) -> SessionInfo {
        SessionInfo {
            name: None,
            id: SessionId(id.to_owned()),
            external: Some(false),
            capabilities: protocol::SessionCapabilities {
                resume: true,
                fork: true,
            },
            agent: "codex".to_owned(),
            agent_base: protocol::RuntimeRef::codex(),
            cwd: PathBuf::from("/repo"),
            cwd_source: Some(protocol::CwdSource::Launch),
            pid: 42,
            cols: 80,
            rows: 24,
            state: protocol::SessionState::Running,
            state_source: StateSource::Process,
            activity,
            subagents: Vec::new(),
            native_session_id: None,
            native_session_path: None,
            active_agent: None,
            active_agent_base: None,
            active_agent_pid: None,
            active_agent_session_id: None,
            active_agent_session_path: None,
            project_id: None,
            project_label: None,
            is_linked_worktree: None,
            repo: None,
            branch: None,
            worktree_path: None,
            warnings: Vec::new(),
            metadata: BTreeMap::new(),
            created_at: "2026-01-01T00:00:00Z".to_owned(),
            updated_at: "2026-01-01T00:00:00Z".to_owned(),
            exit_code: None,
            runtime: None,
        }
    }

    /// Random, owner-private fixture root; removed when the guard drops.
    fn review_resume_root() -> tempfile::TempDir {
        pohunek_test_support::tempdir_with_prefix("pgc-st").expect("private fixture root")
    }

    #[test]
    fn begin_review_from_session_resumes_a_persisted_draft_for_the_same_source() {
        let root = review_resume_root();
        let store = ReviewStore::new(root.path().join("reviews"));
        let host_id = HostId::new("local");
        let mut source_session = session("s-1", None);
        source_session.branch = Some("feature/x".to_owned());

        // First "app run": open the review, add a comment, and persist it —
        // exactly what `save_review_comment` does, but driven directly here
        // since that method also needs an open comment editor.
        let mut workspace = Workspace::default();
        workspace.begin_review_from_session(host_id.clone(), &store, &source_session, "project-1");
        let review_id = {
            let host = workspace.hosts.get_mut(&host_id).expect("host");
            let review = host
                .review
                .active_review
                .as_mut()
                .expect("fresh draft on first open");
            review.add_comment(ReviewComment::new("src/lib.rs", ReviewSide::New, 1, "lgtm"));
            store.save(review).expect("persist draft with comment");
            review.id.clone()
        };

        // "Restart": a brand-new in-memory `Workspace` (nothing carried over
        // except the on-disk store) opening a review for the exact same
        // source must resume the persisted draft, comment included.
        let mut restarted = Workspace::default();
        restarted.begin_review_from_session(host_id.clone(), &store, &source_session, "project-1");
        let resumed = restarted
            .hosts
            .get(&host_id)
            .expect("host")
            .review
            .active_review
            .as_ref()
            .expect("resumed review");
        assert_eq!(resumed.id, review_id);
        assert_eq!(resumed.comments.len(), 1);
        assert_eq!(resumed.comments[0].text, "lgtm");

        // A different source (different session id) must not resume this
        // unrelated draft — it mints its own fresh, empty one instead.
        let mut other_session = session("s-2", None);
        other_session.branch = Some("feature/y".to_owned());
        let mut other = Workspace::default();
        other.begin_review_from_session(host_id.clone(), &store, &other_session, "project-1");
        let fresh = other
            .hosts
            .get(&host_id)
            .expect("host")
            .review
            .active_review
            .as_ref()
            .expect("fresh draft for a different source");
        assert_ne!(fresh.id, review_id);
        assert!(fresh.comments.is_empty());
    }

    #[test]
    fn resuming_picks_the_draft_with_the_latest_instant_not_the_largest_string() {
        let root = review_resume_root();
        let store = ReviewStore::new(root.path().join("reviews"));
        let host_id = HostId::new("local");
        let mut source_session = session("s-1", None);
        source_session.branch = Some("feature/x".to_owned());
        let source = ReviewSource::Session {
            host_id: host_id.clone(),
            session_id: source_session.id.clone(),
        };

        // As strings the later draft ('.5Z') sorts below the earlier one ('Z').
        let mut earlier = Review::new(source.clone(), "project-1", "feature/x");
        earlier.updated_at = "2026-10-01T08:00:05Z".to_owned();
        let mut later = Review::new(source, "project-1", "feature/x");
        later.updated_at = "2026-10-01T08:00:05.5Z".to_owned();
        store.save(&earlier).expect("persist earlier draft");
        store.save(&later).expect("persist later draft");

        let mut workspace = Workspace::default();
        workspace.begin_review_from_session(host_id.clone(), &store, &source_session, "project-1");
        let resumed = workspace
            .hosts
            .get(&host_id)
            .expect("host")
            .review
            .active_review
            .as_ref()
            .expect("resumed review");

        assert_eq!(resumed.id, later.id);
    }

    #[test]
    fn begin_review_from_pull_request_resumes_a_persisted_draft_for_the_same_pr() {
        let root = review_resume_root();
        let store = ReviewStore::new(root.path().join("reviews"));
        let host_id = HostId::new("local");

        let mut workspace = Workspace::default();
        workspace.begin_review_from_pull_request(
            host_id.clone(),
            &store,
            42,
            "project-1",
            "feature/pr-42",
        );
        let review_id = {
            let host = workspace.hosts.get_mut(&host_id).expect("host");
            let review = host
                .review
                .active_review
                .as_mut()
                .expect("fresh draft on first open");
            review.add_comment(ReviewComment::new("README.md", ReviewSide::Old, 3, "typo"));
            store.save(review).expect("persist draft with comment");
            review.id.clone()
        };

        let mut restarted = Workspace::default();
        restarted.begin_review_from_pull_request(
            host_id.clone(),
            &store,
            42,
            "project-1",
            "feature/pr-42",
        );
        let resumed = restarted
            .hosts
            .get(&host_id)
            .expect("host")
            .review
            .active_review
            .as_ref()
            .expect("resumed review");
        assert_eq!(resumed.id, review_id);
        assert_eq!(resumed.comments.len(), 1);

        // A different PR number on the same host must not resume it.
        let mut other = Workspace::default();
        other.begin_review_from_pull_request(
            host_id.clone(),
            &store,
            43,
            "project-1",
            "feature/pr-43",
        );
        let fresh = other
            .hosts
            .get(&host_id)
            .expect("host")
            .review
            .active_review
            .as_ref()
            .expect("fresh draft for a different PR");
        assert_ne!(fresh.id, review_id);
        assert!(fresh.comments.is_empty());
    }

    #[test]
    fn begin_review_from_session_ignores_a_dispatched_draft_and_mints_a_fresh_one() {
        let root = review_resume_root();
        let store = ReviewStore::new(root.path().join("reviews"));
        let host_id = HostId::new("local");
        let mut source_session = session("s-1", None);
        source_session.branch = Some("feature/x".to_owned());

        let mut workspace = Workspace::default();
        workspace.begin_review_from_session(host_id.clone(), &store, &source_session, "project-1");
        let dispatched_id = {
            let host = workspace.hosts.get_mut(&host_id).expect("host");
            let review = host
                .review
                .active_review
                .as_mut()
                .expect("fresh draft on first open");
            review.mark_dispatched(SessionId("s-dispatched".to_owned()));
            store.save(review).expect("persist dispatched review");
            review.id.clone()
        };

        let mut restarted = Workspace::default();
        restarted.begin_review_from_session(host_id.clone(), &store, &source_session, "project-1");
        let fresh = restarted
            .hosts
            .get(&host_id)
            .expect("host")
            .review
            .active_review
            .as_ref()
            .expect("fresh draft, not the dispatched one");
        assert_ne!(fresh.id, dispatched_id);
        assert_eq!(fresh.status, ReviewStatus::Draft);
    }
}
