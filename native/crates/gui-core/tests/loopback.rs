//! Headless GUI-core harness against real `pohunekd` and `pohunek-sessiond`
//! processes.
//!
//! Every test starts its own daemon in a private environment and talks to it
//! over the daemon's Unix socket. The binaries come from the pinned core
//! revision (see `support`).

// Rust guideline compliant 2026-10-03
#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures::StreamExt;
use no_origin::{
    add_project, inspect_host_governance, inspect_session, list_project_actions, list_projects,
    load_host_snapshot, read_session_output, read_session_screen, remove_project, rename_project,
    resolve_project_action, resolve_project_prompt, set_session_metadata, show_project,
    stop_session as stop_gui_session, wait_for_session,
};
use pohunek_client::{Client, ClientOptions, OriginSource};
use pohunek_gui_core::assistant::{self, AssistantPaths, Intent, LaunchParams};
use pohunek_gui_core::{
    dispatch_review, launch_action_prompt_with_options, launch_provider_item_with_options,
    parse_unified_diff, preview_action_prompt, preview_prompt_content, render_review_prompt,
    session_link_metadata, session_metadata_rows, set_notification_policy_with_options,
    spawn_attach_command, workspace_connection_stream, AgentStateEvent, AttachCommandSpawner,
    AttachSpawnIntent, AttachTemplateValues, ConnState, ConnectionOptions, CoreError,
    DiffFileStatus, DomainEvent, HealthSummary, HostConfig, HostEvent, HostId, HostSnapshot,
    HostView, PromptContext, PromptLaunchParams, PromptPreview, ProviderLaunchItem,
    ProviderLaunchParams, Review, ReviewComment, ReviewDispatchParams, ReviewSide, ReviewSource,
    ReviewStatus, ReviewStore, RuntimeContinuity, Selection, SessionAccess, SessionGroup,
    SessionLinkKind, SessionLinkProvider, SessionRow, SubagentCounts, UiState, WindowSize,
    Workspace,
};
use pohunek_platform::process::{HostInspector, ProcessInspector};
use pohunek_test_support::env::TestEnv;
use pohunek_test_support::process_env::ProcessEnv;
use pohunek_test_support::wait;
use protocol::{
    method, AgentActivity, ErrorClass, NotificationPolicyParams, ProcessStartIdentity,
    ProjectActionParams, ProjectActionResult, ProjectActionsParams, ProjectAddParams,
    ProjectPromptParams, ProjectRemoveParams, ProjectRenameParams, ProjectShowParams,
    ProtocolError, ProviderKind, ReportSequence, Request, Response, RuntimeGeneration, RuntimeRef,
    RuntimeState, SessionDiffParams, SessionId, SessionInfo, SessionNewParams, SessionOutputParams,
    SessionReportNativeIdParams, SessionRuntimeIdentity, SessionScreenParams,
    SessionSetMetadataParams, SessionWaitParams, StateSource, SubagentInfo, SubagentLifecycle,
    SubagentRevision, SubagentStateEvent,
};
use time::format_description::well_known::Rfc3339;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

// Keeps a test report live long enough for local scheduling without making it
// effectively unbounded.
const NATIVE_REPORT_EXPIRY_MINUTES: i64 = 1;

// Keeps the observation smoke test intentionally small while exercising a
// nonempty bounded output page.
const GUI_TEST_OUTPUT_BYTES: u32 = 1_024;

// The state predicate is already true, so this only bounds a regression hang.
const GUI_TEST_WAIT_MS: u32 = 100;

mod no_origin;
mod support;

#[tokio::test]
async fn dropping_the_harness_with_a_live_session_reaps_the_worker_and_agent() {
    let mut env = ProcessEnv::lock();
    let bin_dir = temp_dir("gui-core-drop-bin");
    write_executable(&bin_dir.join("codex"), "#!/bin/sh\n/bin/sleep 30\n");
    prepend_path(&mut env, &bin_dir);

    let daemon = LoopbackDaemon::spawn("drop-reaps").await;
    let host = daemon.host("host-drop");
    let session =
        create_agent_session(&host, RuntimeRef::codex(), temp_dir("gui-core-drop-cwd")).await;
    let inspector = HostInspector::new();
    let hierarchy = inspector
        .descendants(daemon.pid())
        .expect("list the daemon's process tree");
    assert!(
        hierarchy.iter().any(|fact| fact
            .cmdline
            .iter()
            .any(|arg| arg.ends_with("pohunek-sessiond"))),
        "session {} must have a worker below the daemon: {hierarchy:?}",
        session.id.0
    );

    // The unwind path of a failing test runs the same `Drop`.
    drop(daemon);

    wait::wait_until("the worker and agent to be gone", || async {
        hierarchy
            .iter()
            .all(|fact| !inspector.is_running(fact.identity()).unwrap_or(false))
            .then_some(())
    })
    .await;
}

#[tokio::test]
async fn governance_inspect_returns_safe_never_enrolled_status_over_the_unix_socket() {
    let _env = ProcessEnv::lock();
    let daemon = LoopbackDaemon::spawn("gui-governance-inspect").await;
    let host = daemon.host("host-governance");

    let status = inspect_host_governance(&host)
        .await
        .expect("governance inspect through the real daemon");

    assert!(status.host_id().to_string().starts_with("host_"));
    assert!(status.enrollment().is_none());
    assert!(status.owner().is_none());
    assert!(status.owner_revision().is_none());
    assert!(status.quarantine().is_none());
    assert!(status
        .approval_key_reference()
        .to_string()
        .starts_with("approval_key_"));

    daemon.shutdown().await;
}

#[tokio::test]
async fn loopback_hosts_seed_and_stream_agent_state() {
    let mut env = ProcessEnv::lock();
    let bin_dir = temp_dir("gui-core-codex-bin");
    write_executable(
        &bin_dir.join("codex"),
        "#!/bin/sh\n/bin/sleep 0.2\nprintf '\\033]2;Action Required\\007'\n/bin/sleep 30\n",
    );
    prepend_path(&mut env, &bin_dir);

    let daemon_a = LoopbackDaemon::spawn("gui-a").await;
    let daemon_b = LoopbackDaemon::spawn("gui-b").await;
    let host_a = daemon_a.host("host-a");
    let host_b = daemon_b.host("host-b");

    let snapshot_a = load_host_snapshot(&host_a).await.expect("host-a seed");
    let snapshot_b = load_host_snapshot(&host_b).await.expect("host-b seed");
    assert_eq!(snapshot_a.health.status, "ok");
    assert_eq!(snapshot_b.health.status, "ok");
    assert!(snapshot_a.sessions.is_empty());
    assert!(snapshot_b.sessions.is_empty());
    assert!(snapshot_a
        .notification_providers
        .iter()
        .any(|provider| provider == "codex"));

    let mut events = Box::pin(workspace_connection_stream(
        vec![host_a.clone()],
        test_connection_options(),
    ));
    assert!(matches!(
        events.next().await.expect("connecting message"),
        DomainEvent::HostConnecting { .. }
    ));
    assert!(matches!(
        events.next().await.expect("subscribed message"),
        DomainEvent::HostSubscribed { .. }
    ));

    let created =
        create_agent_session(&host_a, RuntimeRef::codex(), temp_dir("gui-core-cwd")).await;
    let state = wait_for_agent_state(&mut events, &created.id).await;
    assert_eq!(state.activity, AgentActivity::Blocked);
    assert_eq!(state.source, StateSource::OscTitle);

    stop_session(&host_a, &created.id).await;
    daemon_a.shutdown().await;
    daemon_b.shutdown().await;
}

#[tokio::test]
async fn workspace_connects_to_multiple_loopback_daemons_and_lists_sessions() {
    let mut env = ProcessEnv::lock();
    let bin_dir = temp_dir("gui-core-m1-bin");
    write_executable(&bin_dir.join("codex"), "#!/bin/sh\n/bin/sleep 30\n");
    prepend_path(&mut env, &bin_dir);

    let daemon_a = LoopbackDaemon::spawn("m1-a").await;
    let daemon_b = LoopbackDaemon::spawn("m1-b").await;
    let host_a = daemon_a.host("host-a");
    let host_b = daemon_b.host("host-b");
    let repo_a = init_git_repo("gui-core-m1-repo-a");
    let repo_b = init_git_repo("gui-core-m1-repo-b");
    let session_a = create_agent_session(&host_a, RuntimeRef::codex(), repo_a).await;
    let session_b = create_agent_session(&host_b, RuntimeRef::codex(), repo_b).await;

    let mut workspace = Workspace::default();
    let mut stream = Box::pin(workspace_connection_stream(
        vec![host_a.clone(), host_b.clone()],
        test_connection_options(),
    ));
    wait_for_hosts_with_sessions(
        &mut workspace,
        &mut stream,
        &[(&host_a, &session_a.id), (&host_b, &session_b.id)],
    )
    .await;

    let view_a = workspace.hosts.get(&host_a.id).expect("host-a view");
    let view_b = workspace.hosts.get(&host_b.id).expect("host-b view");
    assert_eq!(view_a.conn, ConnState::Connected);
    assert_eq!(view_b.conn, ConnState::Connected);
    assert!(view_a.sessions.contains_key(&session_a.id.0));
    assert!(view_b.sessions.contains_key(&session_b.id.0));
    assert!(
        !view_a.projects.is_empty(),
        "host-a should seed projects through project.list"
    );
    assert!(
        !view_b.projects.is_empty(),
        "host-b should seed projects through project.list"
    );

    stop_session(&host_a, &session_a.id).await;
    stop_session(&host_b, &session_b.id).await;
    daemon_a.shutdown().await;
    daemon_b.shutdown().await;
}

#[tokio::test]
async fn live_agent_state_updates_are_reflected() {
    let mut env = ProcessEnv::lock();
    let bin_dir = temp_dir("gui-core-m1-blocked-bin");
    write_executable(
        &bin_dir.join("codex"),
        "#!/bin/sh\n/bin/sleep 0.2\nprintf '\\033]2;Action Required\\007'\n/bin/sleep 30\n",
    );
    prepend_path(&mut env, &bin_dir);

    let daemon = LoopbackDaemon::spawn("m1-blocked").await;
    let host = daemon.host("host-blocked");
    let mut workspace = Workspace::default();
    let mut stream = Box::pin(workspace_connection_stream(
        vec![host.clone()],
        test_connection_options(),
    ));
    wait_for_host_connected(&mut workspace, &mut stream, &host).await;

    let session =
        create_agent_session(&host, RuntimeRef::codex(), temp_dir("gui-core-m1-cwd")).await;
    wait_for_session_activity(
        &mut workspace,
        &mut stream,
        &host,
        &session.id,
        AgentActivity::Blocked,
    )
    .await;

    let view = workspace.hosts.get(&host.id).expect("host view");
    assert_eq!(
        view.sessions
            .get(&session.id.0)
            .and_then(|session| session.activity),
        Some(AgentActivity::Blocked)
    );
    // The transient blocked-session OS notification path was removed. OS intents
    // now originate from durable `notification_created` events produced by the
    // daemon projector, so a bare `agent_state` transition raises no intent.
    assert!(workspace.notification_intents.is_empty());
    assert!(workspace.toasts.is_empty());

    stop_session(&host, &session.id).await;
    daemon.shutdown().await;
}

#[tokio::test]
async fn notification_seed_with_an_empty_inbox_connects_and_streams_sessions() {
    let mut env = ProcessEnv::lock();
    let bin_dir = temp_dir("gui-core-notif-seed-bin");
    write_executable(&bin_dir.join("codex"), "#!/bin/sh\n/bin/sleep 30\n");
    prepend_path(&mut env, &bin_dir);

    // A daemon with an empty inbox: the host connects and streams sessions.
    let daemon = LoopbackDaemon::spawn("notif-seed").await;
    let host = daemon.host("host-notif");
    let mut workspace = Workspace::default();
    let mut stream = Box::pin(workspace_connection_stream(
        vec![host.clone()],
        test_connection_options(),
    ));
    wait_for_host_connected(&mut workspace, &mut stream, &host).await;

    let session =
        create_agent_session(&host, RuntimeRef::codex(), temp_dir("gui-core-notif-cwd")).await;
    wait_for_hosts_with_sessions(&mut workspace, &mut stream, &[(&host, &session.id)]).await;

    let view = workspace.hosts.get(&host.id).expect("host view");
    assert_eq!(view.conn, ConnState::Connected);
    assert!(view.notifications.is_empty());
    assert_eq!(workspace.unread_notification_count(), 0);

    stop_session(&host, &session.id).await;
    daemon.shutdown().await;
}

#[tokio::test]
async fn notification_seed_treats_method_not_found_as_an_empty_inbox() {
    let _env = ProcessEnv::lock();
    let daemon = NotificationListErrorDaemon::spawn_without_notification_support().await;
    let host = HostConfig::tcp("host-notif-legacy", daemon.addr);

    let snapshot = load_host_snapshot(&host)
        .await
        .expect("a daemon without notification.list still seeds the host");

    assert_eq!(snapshot.health.status, "ok");
    assert!(snapshot.notifications.is_empty());
    assert_eq!(snapshot.project_error, None);

    daemon.join().await;
}

#[tokio::test]
async fn notification_seed_runtime_error_surfaces_on_snapshot() {
    let _env = ProcessEnv::lock();
    let daemon = NotificationListErrorDaemon::spawn().await;
    let host = HostConfig::tcp("host-notif-error", daemon.addr);

    let snapshot = load_host_snapshot(&host)
        .await
        .expect("runtime notification error is non-fatal to host seed");

    assert!(snapshot.notifications.is_empty());
    let error = snapshot
        .project_error
        .as_deref()
        .expect("notification.list runtime error is surfaced");
    assert!(
        error.contains("notification.list failed"),
        "seed error is attributed to notification.list: {error}"
    );
    assert!(
        error.contains("notification_store_unavailable"),
        "seed error keeps daemon code: {error}"
    );

    daemon.join().await;
}

#[tokio::test]
async fn unreachable_host_marks_error_without_breaking_other_hosts() {
    let mut env = ProcessEnv::lock();
    let bin_dir = temp_dir("gui-core-m1-unreachable-bin");
    write_executable(&bin_dir.join("codex"), "#!/bin/sh\n/bin/sleep 30\n");
    prepend_path(&mut env, &bin_dir);

    let daemon = LoopbackDaemon::spawn("m1-live").await;
    let live_host = daemon.host("host-live");
    let dead_host = HostConfig::tcp("host-dead", unused_loopback_addr().await);
    let session = create_agent_session(
        &live_host,
        RuntimeRef::codex(),
        init_git_repo("gui-core-m1-live-repo"),
    )
    .await;

    let mut workspace = Workspace::default();
    let mut stream = Box::pin(workspace_connection_stream(
        vec![dead_host.clone(), live_host.clone()],
        test_connection_options(),
    ));
    // The dead host keeps cycling Unreachable -> Connecting between retries, so
    // its state is asserted on the view captured when the error was observed,
    // never re-read after the live host's wait has pumped further events.
    let dead = wait_for_host_error(&mut workspace, &mut stream, &dead_host).await;
    assert_eq!(dead.conn, ConnState::Unreachable);
    assert!(dead.last_error.is_some());

    wait_for_hosts_with_sessions(&mut workspace, &mut stream, &[(&live_host, &session.id)]).await;
    let live = workspace.hosts.get(&live_host.id).expect("live host view");
    assert_eq!(live.conn, ConnState::Connected);
    assert!(live.sessions.contains_key(&session.id.0));

    stop_session(&live_host, &session.id).await;
    daemon.shutdown().await;
}

#[tokio::test]
async fn session_lifecycle_create_inspect_and_stop_reconciles_workspace_state() {
    let mut env = ProcessEnv::lock();
    let bin_dir = temp_dir("gui-core-m2-session-bin");
    write_executable(&bin_dir.join("codex"), "#!/bin/sh\n/bin/sleep 30\n");
    prepend_path(&mut env, &bin_dir);

    let daemon = LoopbackDaemon::spawn("m2-session").await;
    let host = daemon.host("host-session");
    let mut workspace = Workspace::default();
    let mut stream = Box::pin(workspace_connection_stream(
        vec![host.clone()],
        test_connection_options(),
    ));
    wait_for_host_connected(&mut workspace, &mut stream, &host).await;

    let created = no_origin::create_session(
        &host,
        SessionNewParams {
            agent: agent_name(&RuntimeRef::codex()).to_owned(),
            name: None,
            cwd: Some(temp_dir("gui-core-m2-session-cwd")),
            cols: 100,
            rows: 32,
            project: None,
            repo: None,
            branch: None,
            base_branch: None,
            input: None,
            extended_input_ready_wait: None,
            metadata: std::collections::BTreeMap::from([("source".to_owned(), "gui".to_owned())]),
        },
    )
    .await
    .expect("session.new through gui-core");
    workspace.apply(DomainEvent::SessionCreated {
        host_id: host.id.clone(),
        session: created.session.clone(),
    });
    assert!(workspace
        .hosts
        .get(&host.id)
        .expect("host view")
        .sessions
        .contains_key(&created.session.id.0));

    let inspected = inspect_session(&host, &created.session.id)
        .await
        .expect("session.inspect through gui-core");
    workspace.apply(DomainEvent::SessionInspected {
        host_id: host.id.clone(),
        session: inspected.clone(),
    });
    assert_eq!(inspected.id, created.session.id);
    assert_eq!(session_metadata_rows(&inspected)[0].key, "source");

    exercise_observation_and_policy(&host, &inspected).await;

    let stopped = stop_gui_session(&host, &created.session.id)
        .await
        .expect("session.stop through gui-core");
    assert!(stopped.stopped);
    workspace.apply(DomainEvent::SessionStopCompleted {
        host_id: host.id.clone(),
        session_id: created.session.id.clone(),
        result: stopped,
    });
    assert_eq!(
        workspace
            .hosts
            .get(&host.id)
            .and_then(|view| view.sessions.get(&created.session.id.0))
            .map(|session| session.state),
        Some(protocol::SessionState::Stopped)
    );

    wait_for_session_state(
        &mut workspace,
        &mut stream,
        &host,
        &created.session.id,
        protocol::SessionState::Stopped,
    )
    .await;

    daemon.shutdown().await;
}

#[tokio::test]
async fn session_children_receive_the_fixture_environment_not_the_host_one() {
    let mut env = ProcessEnv::lock();
    let bin_dir = temp_dir("gui-core-env-bin");
    let record_dir = temp_dir("gui-core-env-record");
    let env_out = record_dir.join("env.txt");
    write_executable(
        &bin_dir.join("codex"),
        &environment_recorder_script(&env_out),
    );
    prepend_path(&mut env, &bin_dir);

    let daemon = LoopbackDaemon::spawn("env-scrub").await;
    let host = daemon.host("host-env-scrub");
    let created = no_origin::create_session(
        &host,
        SessionNewParams {
            agent: agent_name(&RuntimeRef::codex()).to_owned(),
            name: None,
            cwd: Some(temp_dir("gui-core-env-cwd")),
            cols: 100,
            rows: 32,
            project: None,
            repo: None,
            branch: None,
            base_branch: None,
            input: None,
            extended_input_ready_wait: None,
            metadata: std::collections::BTreeMap::new(),
        },
    )
    .await
    .expect("session.new through gui-core");

    let recorded = wait_for_file(&env_out).await;
    let fixture_home = daemon.home().display().to_string();
    assert!(
        recorded
            .lines()
            .any(|line| line == format!("HOME={fixture_home}")),
        "the child must see the daemon fixture HOME, got:\n{recorded}"
    );
    assert!(
        recorded.lines().any(|line| line == "SSH_AUTH_SOCK=<unset>"),
        "the child must not see a host SSH agent socket, got:\n{recorded}"
    );

    stop_session(&host, &created.session.id).await;
    daemon.shutdown().await;
}

/// Replacement worker for the replaced-worker regression: the real runtime with
/// a new worker instance id and the next generation.
fn replaced_runtime(session: &SessionInfo) -> SessionRuntimeIdentity {
    let runtime = session
        .runtime
        .as_ref()
        .expect("managed session has a runtime");
    SessionRuntimeIdentity::new(
        "w-recovered",
        RuntimeGeneration::new(runtime.runtime_generation.get() + 1),
    )
    .expect("valid replacement runtime identity")
}

/// A subagent hook report shaped like a real worker relays one: running
/// subagents carry `Working`, finished ones carry no activity.
fn subagent_state(
    session: &SessionInfo,
    identity: &str,
    generation: RuntimeGeneration,
    revision: u64,
    lifecycle: SubagentLifecycle,
) -> HostEvent {
    HostEvent::SubagentState(SubagentStateEvent {
        session_id: session.id.clone(),
        subagent: SubagentInfo {
            id: "child-1".to_owned(),
            parent_id: None,
            provider: RuntimeRef::codex(),
            agent_type: Some("Explore".to_owned()),
            lifecycle,
            activity: (lifecycle == SubagentLifecycle::Running).then_some(AgentActivity::Working),
            revision: SubagentRevision::new(revision),
            started_at_ms: 1_000,
            updated_at_ms: 1_000 + revision,
            finished_at_ms: None,
        },
        runtime: Some(
            SessionRuntimeIdentity::new(identity, generation)
                .expect("valid subagent runtime identity"),
        ),
    })
}

/// Aggregated subagent counts on the public session row of one session.
fn row_subagents(workspace: &Workspace, session_id: &SessionId) -> SubagentCounts {
    workspace
        .session_rows()
        .into_iter()
        .find(|row| row.session_id == *session_id)
        .map(|row| row.subagents)
        .expect("session row for the real session")
}

/// The live session view inside one host's workspace state.
fn session_view<'a>(
    workspace: &'a Workspace,
    host_id: &HostId,
    session_key: &str,
) -> Option<&'a SessionInfo> {
    workspace
        .hosts
        .get(host_id)
        .and_then(|view| view.sessions.get(session_key))
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "keeps stale-revision and worker-recovery assertions in one daemon-seeded flow"
)]
async fn stale_subagent_events_from_replaced_workers_never_revive_the_session_view() {
    let mut env = ProcessEnv::lock();
    let bin_dir = temp_dir("gui-core-stale-bin");
    write_executable(&bin_dir.join("codex"), "#!/bin/sh\nexec /bin/sleep 30\n");
    prepend_path(&mut env, &bin_dir);

    let daemon = LoopbackDaemon::spawn("gui-stale-subagent").await;
    let host = daemon.host("host-stale-subagent");
    let created = no_origin::create_session(
        &host,
        SessionNewParams {
            agent: agent_name(&RuntimeRef::codex()).to_owned(),
            name: None,
            cwd: Some(temp_dir("gui-core-stale-cwd")),
            cols: 80,
            rows: 24,
            project: None,
            repo: None,
            branch: None,
            base_branch: None,
            input: None,
            extended_input_ready_wait: None,
            metadata: std::collections::BTreeMap::new(),
        },
    )
    .await
    .expect("session.new through gui-core");
    let session = created.session.clone();
    let runtime = created.session.runtime.as_ref().expect("managed runtime");
    let worker_instance_id = runtime
        .worker_instance_id
        .clone()
        .expect("managed session has a worker instance");
    let generation = runtime.runtime_generation;

    // The GUI seeds its workspace from the real daemon's snapshot before any
    // event is processed.
    let snapshot = load_host_snapshot(&host)
        .await
        .expect("snapshot through gui-core");
    assert!(snapshot
        .sessions
        .iter()
        .any(|listed| listed.id == session.id));
    let mut workspace = Workspace::default();
    workspace.apply(DomainEvent::HostSnapshotLoaded { snapshot });
    let host_id = host.id.clone();
    let session_key = session.id.0.clone();

    // The current worker reports the subagent completed; a late hook report of
    // the same subagent carries an older revision and must lose to it.
    workspace.apply(DomainEvent::HostEvent {
        host_id: host.id.clone(),
        event: subagent_state(
            &session,
            &worker_instance_id,
            generation,
            2,
            SubagentLifecycle::Completed,
        ),
    });
    workspace.apply(DomainEvent::HostEvent {
        host_id: host.id.clone(),
        event: subagent_state(
            &session,
            &worker_instance_id,
            generation,
            1,
            SubagentLifecycle::Running,
        ),
    });
    let subagent = session_view(&workspace, &host_id, &session_key)
        .and_then(|view| view.subagents.first())
        .cloned()
        .expect("the completed subagent stays in the workspace view");
    assert_eq!(subagent.lifecycle, SubagentLifecycle::Completed);
    assert_eq!(subagent.revision, SubagentRevision::new(2));
    assert_eq!(
        row_subagents(&workspace, &session.id),
        SubagentCounts {
            running: 0,
            total: 1,
        }
    );

    // Explicit recovery replaces the worker: the new generation carries no
    // subagents, and the prior runtime is recorded as recovered.
    let mut recovered = session.clone();
    let replacement = replaced_runtime(&session);
    let view_runtime = recovered.runtime.as_mut().expect("managed session runtime");
    view_runtime.worker_instance_id = Some(replacement.worker_instance_id().to_owned());
    view_runtime.runtime_generation = replacement.runtime_generation();
    recovered.subagents.clear();
    workspace.apply(DomainEvent::HostEvent {
        host_id: host.id.clone(),
        event: HostEvent::NativeRecovered(recovered),
    });
    assert_eq!(
        workspace.runtime_continuity(&host.id, &session.id),
        Some(RuntimeContinuity::Recovered),
        "the replaced worker is recorded as an explicit recovery"
    );
    assert!(
        session_view(&workspace, &host_id, &session_key)
            .expect("recovered session view")
            .subagents
            .is_empty(),
        "recovery replaces the subagent history with the replacement runtime's"
    );

    // The replaced worker keeps emitting late hook reports with revisions above
    // anything the replacement published; none may be accepted.
    for (revision, lifecycle) in [
        (99, SubagentLifecycle::Running),
        (2, SubagentLifecycle::Cancelled),
    ] {
        workspace.apply(DomainEvent::HostEvent {
            host_id: host.id.clone(),
            event: subagent_state(
                &session,
                &worker_instance_id,
                generation,
                revision,
                lifecycle,
            ),
        });
        assert!(
            session_view(&workspace, &host_id, &session_key)
                .expect("recovered session view")
                .subagents
                .is_empty(),
            "a late event from the replaced worker must not revive the subagent"
        );
    }
    assert_eq!(
        row_subagents(&workspace, &session.id),
        SubagentCounts {
            running: 0,
            total: 0,
        }
    );

    stop_session(&host, &session.id).await;
    daemon.shutdown().await;
}

#[tokio::test]
async fn conflicted_and_incompatible_runtime_sessions_fail_closed_in_session_rows() {
    let mut env = ProcessEnv::lock();
    let bin_dir = temp_dir("gui-core-conflict-bin");
    write_executable(&bin_dir.join("codex"), "#!/bin/sh\nexec /bin/sleep 30\n");
    prepend_path(&mut env, &bin_dir);

    let daemon = LoopbackDaemon::spawn("gui-runtime-conflict").await;
    let host = daemon.host("host-runtime-conflict");
    let created = no_origin::create_session(
        &host,
        SessionNewParams {
            agent: agent_name(&RuntimeRef::codex()).to_owned(),
            name: None,
            cwd: Some(temp_dir("gui-core-conflict-cwd")),
            cols: 80,
            rows: 24,
            project: None,
            repo: None,
            branch: None,
            base_branch: None,
            input: None,
            extended_input_ready_wait: None,
            metadata: std::collections::BTreeMap::new(),
        },
    )
    .await
    .expect("session.new through gui-core");
    let session = created.session;
    assert_eq!(
        session.runtime.as_ref().expect("managed runtime").state,
        RuntimeState::Live,
        "the real session starts with a live runtime"
    );

    // The GUI seeds its workspace from the real daemon's snapshot, then derives
    // the unusable runtime states from it the way a daemon's reconciliation can
    // report them.
    let mut snapshot = load_host_snapshot(&host)
        .await
        .expect("snapshot through gui-core");
    let live = snapshot
        .sessions
        .iter()
        .find(|listed| listed.id == session.id)
        .cloned()
        .expect("the snapshot lists the real session");
    let mut conflicted = live.clone();
    conflicted.id = SessionId("s-conflicted".to_owned());
    conflicted.runtime.as_mut().expect("managed runtime").state = RuntimeState::Conflict;
    let mut incompatible = live;
    incompatible.id = SessionId("s-incompatible".to_owned());
    incompatible
        .runtime
        .as_mut()
        .expect("managed runtime")
        .state = RuntimeState::Incompatible;
    snapshot.sessions.push(conflicted);
    snapshot.sessions.push(incompatible);

    let mut workspace = Workspace::default();
    workspace.apply(DomainEvent::HostSnapshotLoaded { snapshot });
    let rows: BTreeMap<String, SessionRow> = workspace
        .session_rows()
        .into_iter()
        .map(|row| (row.session_id.0.clone(), row))
        .collect();

    // The untouched real session stays attachable: the deny is driven by the
    // runtime state, not by the seeding path.
    let live_row = &rows[&session.id.0];
    assert_eq!(live_row.access, SessionAccess::Attach);
    assert!(live_row.can_stop);
    assert!(live_row.can_remove);

    for unsafe_id in ["s-conflicted", "s-incompatible"] {
        let row = &rows[unsafe_id];
        assert_eq!(
            row.access,
            SessionAccess::Unavailable,
            "{unsafe_id} must not be attachable"
        );
        assert!(!row.can_stop, "{unsafe_id} must deny a direct stop");
        assert!(!row.can_remove, "{unsafe_id} must deny a remove");
        assert_eq!(row.group, SessionGroup::Unavailable, "{unsafe_id} group");
    }

    stop_session(&host, &session.id).await;
    daemon.shutdown().await;
}

async fn exercise_observation_and_policy(host: &HostConfig, session: &SessionInfo) {
    let screen = read_session_screen(host, SessionScreenParams::new(session.id.clone()))
        .await
        .expect("session.screen through gui-core");
    assert_eq!(screen.session_id, session.id);
    let output = read_session_output(
        host,
        SessionOutputParams::new(session.id.clone(), None, None, GUI_TEST_OUTPUT_BYTES, None)
            .expect("valid output params"),
    )
    .await
    .expect("session.output through gui-core");
    assert_eq!(output.session_id(), &session.id);
    let stale_runtime = protocol::SessionRuntimeIdentity::new(
        output.runtime().worker_instance_id(),
        protocol::RuntimeGeneration::new(
            output
                .runtime()
                .runtime_generation()
                .get()
                .checked_add(1)
                .expect("test runtime generation can advance"),
        ),
    )
    .expect("valid stale runtime identity");
    let stale_error = read_session_output(
        host,
        SessionOutputParams::new(
            session.id.clone(),
            Some(stale_runtime),
            Some(output.next_offset()),
            GUI_TEST_OUTPUT_BYTES,
            None,
        )
        .expect("valid stale output params"),
    )
    .await
    .expect_err("same runtime id with a new generation is rejected");
    assert!(stale_error.is_session_runtime_changed());
    let waited = wait_for_session(
        host,
        SessionWaitParams::new(
            session.id.clone(),
            None,
            None,
            None,
            None,
            Some(vec![protocol::SessionState::Running]),
            None,
            GUI_TEST_WAIT_MS,
        )
        .expect("valid wait params"),
    )
    .await
    .expect("session.wait through gui-core");
    assert_eq!(waited.reason, protocol::SessionWaitReason::StateMatched);

    let mut policy =
        pohunek_gui_core::get_notification_policy_with_options(host, test_connection_options())
            .await
            .expect("notification.policy.get through gui-core")
            .policy;
    policy
        .providers
        .insert("future-agent".to_owned(), policy.enabled.clone());
    let saved = set_notification_policy_with_options(
        host,
        NotificationPolicyParams { policy },
        test_connection_options(),
    )
    .await
    .expect("notification.policy.set through gui-core");
    assert!(saved.policy.providers.contains_key("future-agent"));
}

#[tokio::test]
async fn session_metadata_merge_and_clear_round_trips() {
    let mut env = ProcessEnv::lock();
    let bin_dir = temp_dir("gui-core-m2-metadata-bin");
    write_executable(&bin_dir.join("codex"), "#!/bin/sh\n/bin/sleep 30\n");
    prepend_path(&mut env, &bin_dir);

    let daemon = LoopbackDaemon::spawn("m2-metadata").await;
    let host = daemon.host("host-metadata");
    let created = no_origin::create_session(
        &host,
        SessionNewParams {
            agent: agent_name(&RuntimeRef::codex()).to_owned(),
            name: None,
            cwd: Some(temp_dir("gui-core-m2-metadata-cwd")),
            cols: 80,
            rows: 24,
            project: None,
            repo: None,
            branch: None,
            base_branch: None,
            input: None,
            extended_input_ready_wait: None,
            metadata: std::collections::BTreeMap::from([
                ("keep".to_owned(), "original".to_owned()),
                ("remove".to_owned(), "gone".to_owned()),
            ]),
        },
    )
    .await
    .expect("session.new with metadata");

    let updated = set_session_metadata(
        &host,
        SessionSetMetadataParams {
            session_id: created.session.id.clone(),
            metadata: std::collections::BTreeMap::from([
                ("keep".to_owned(), Some("updated".to_owned())),
                ("remove".to_owned(), None),
                ("added".to_owned(), Some("value".to_owned())),
            ]),
        },
    )
    .await
    .expect("session.set_metadata");

    assert_eq!(
        updated.session.metadata,
        std::collections::BTreeMap::from([
            ("added".to_owned(), "value".to_owned()),
            ("keep".to_owned(), "updated".to_owned()),
        ])
    );
    let inspected = inspect_session(&host, &created.session.id)
        .await
        .expect("session.inspect after metadata update");
    assert_eq!(inspected.metadata, updated.session.metadata);
    assert_eq!(
        session_metadata_rows(&inspected)
            .into_iter()
            .map(|row| (row.key, row.value))
            .collect::<Vec<_>>(),
        vec![
            ("added".to_owned(), "value".to_owned()),
            ("keep".to_owned(), "updated".to_owned()),
        ]
    );

    stop_session(&host, &created.session.id).await;
    daemon.shutdown().await;
}

#[tokio::test]
async fn project_add_list_show_rename_and_remove_round_trips() {
    let _env = ProcessEnv::lock();
    let daemon = LoopbackDaemon::spawn("m2-project").await;
    let host = daemon.host("host-project");
    let repo = init_git_repo("gui-core-m2-project-repo");

    let added = add_project(
        &host,
        ProjectAddParams {
            path: Some(repo.clone()),
            name: Some("M2 Project".to_owned()),
            base_branch: Some("main".to_owned()),
        },
    )
    .await
    .expect("project.add");
    assert_eq!(added.label, "M2 Project");

    let listed = list_projects(&host).await.expect("project.list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, added.id);

    let shown = show_project(
        &host,
        ProjectShowParams {
            reference: added.id.clone(),
        },
    )
    .await
    .expect("project.show");
    assert_eq!(shown.project.id, added.id);
    assert!(shown
        .worktrees
        .iter()
        .any(|worktree| worktree.path == std::fs::canonicalize(&repo).expect("canonical repo")));

    let renamed = rename_project(
        &host,
        ProjectRenameParams {
            reference: added.id.clone(),
            name: "Renamed M2 Project".to_owned(),
        },
    )
    .await
    .expect("project.rename");
    assert_eq!(renamed.label, "Renamed M2 Project");

    let removed = remove_project(
        &host,
        ProjectRemoveParams {
            reference: renamed.id.clone(),
            prune_worktrees: false,
        },
    )
    .await
    .expect("project.remove");
    assert!(removed.removed);
    assert!(list_projects(&host)
        .await
        .expect("project.list after remove")
        .is_empty());

    daemon.shutdown().await;
}

#[tokio::test]
async fn worktree_creation_is_session_new_with_branch_and_visible_in_project_show() {
    let mut env = ProcessEnv::lock();
    let bin_dir = temp_dir("gui-core-m2-worktree-bin");
    write_executable(&bin_dir.join("codex"), "#!/bin/sh\n/bin/sleep 30\n");
    prepend_path(&mut env, &bin_dir);

    let daemon = LoopbackDaemon::spawn("m2-worktree").await;
    let host = daemon.host("host-worktree");
    let repo = init_git_repo("gui-core-m2-worktree-repo");
    let project = add_project(
        &host,
        ProjectAddParams {
            path: Some(repo),
            name: Some("Worktree Project".to_owned()),
            base_branch: Some("main".to_owned()),
        },
    )
    .await
    .expect("project.add for worktree");

    let created = no_origin::create_session(
        &host,
        SessionNewParams {
            agent: agent_name(&RuntimeRef::codex()).to_owned(),
            name: None,
            cwd: None,
            cols: 80,
            rows: 24,
            project: Some(project.id.clone()),
            repo: None,
            branch: Some("feature/gui-m2".to_owned()),
            base_branch: Some("main".to_owned()),
            input: None,
            extended_input_ready_wait: None,
            metadata: std::collections::BTreeMap::new(),
        },
    )
    .await
    .expect("session.new creates worktree when branch is set");

    assert_eq!(
        created.session.project_id.as_deref(),
        Some(project.id.as_str())
    );
    assert_eq!(created.session.branch.as_deref(), Some("feature/gui-m2"));
    assert!(
        created.session.worktree_path.is_some(),
        "worktree creation must be represented by session.new with branch"
    );

    let shown = show_project(
        &host,
        ProjectShowParams {
            reference: project.id.clone(),
        },
    )
    .await
    .expect("project.show after worktree session");
    assert!(shown.worktrees.iter().any(|worktree| {
        worktree.owned && worktree.session_id.as_deref() == Some(created.session.id.0.as_str())
    }));

    stop_session(&host, &created.session.id).await;
    daemon.shutdown().await;
}

#[tokio::test]
async fn prompt_actions_and_prompt_resolve_from_target_host() {
    let _env = ProcessEnv::lock();
    let daemon = LoopbackDaemon::spawn("m3-resolve").await;
    let host = daemon.host("host-prompts");
    let repo = init_git_repo("gui-core-m3-resolve-repo");
    write_file(
        &repo.join(".pohunek/templates.toml"),
        r#"
[template.issue]
agent = "codex"
prompt = "issue"
base_branch = "main"
"#,
    );
    write_file(
        &repo.join(".pohunek/actions.toml"),
        r#"
[action.process-issue]
template = "issue"
provider = "linear_issue"
"#,
    );
    write_file(
        &repo.join(".pohunek/prompts/issue.tmpl"),
        "Issue ${id}: ${title}\n${body}\nbranch=${branch}\n",
    );
    let project = add_project(
        &host,
        ProjectAddParams {
            path: Some(repo),
            name: Some("Prompt Project".to_owned()),
            base_branch: Some("main".to_owned()),
        },
    )
    .await
    .expect("project.add");

    let actions = list_project_actions(
        &host,
        ProjectActionsParams {
            reference: project.id.clone(),
        },
    )
    .await
    .expect("project.actions through gui-core");
    assert_eq!(actions.actions.len(), 1);
    assert_eq!(actions.actions[0].name, "process-issue");
    assert_eq!(actions.actions[0].provider, ProviderKind::LinearIssue);

    let prompt = resolve_project_prompt(
        &host,
        ProjectPromptParams {
            reference: project.id.clone(),
            name: "issue".to_owned(),
        },
    )
    .await
    .expect("project.prompt through gui-core");
    assert_eq!(
        prompt.content,
        "Issue ${id}: ${title}\n${body}\nbranch=${branch}\n"
    );

    let action = resolve_project_action(
        &host,
        ProjectActionParams {
            reference: project.id,
            name: "process-issue".to_owned(),
        },
    )
    .await
    .expect("project.action through gui-core");
    assert_eq!(action.agent, "codex");
    assert_eq!(action.base_branch.as_deref(), Some("main"));
    assert_eq!(action.prompt_content, prompt.content);

    daemon.shutdown().await;
}

#[tokio::test]
async fn remote_prompt_resolution_uses_target_daemon_config_not_operator_filesystem() {
    let mut env = ProcessEnv::lock();
    let operator_config_home = temp_dir("gui-core-m3-operator-config-home");
    write_file(
        &operator_config_home.join("pohunek/prompts/issue.tmpl"),
        "OPERATOR LOCAL ${title}",
    );
    env.set("XDG_CONFIG_HOME", operator_config_home);

    let daemon = LoopbackDaemon::spawn("m3-remote").await;
    write_file(
        &daemon.config_dir().join("prompts/issue.tmpl"),
        "REMOTE TARGET ${title}",
    );
    let host = daemon.host("remote-host");
    let repo = init_git_repo("gui-core-m3-remote-repo");
    let project = add_project(
        &host,
        ProjectAddParams {
            path: Some(repo),
            name: Some("Remote Prompt Project".to_owned()),
            base_branch: Some("main".to_owned()),
        },
    )
    .await
    .expect("project.add");

    let prompt = resolve_project_prompt(
        &host,
        ProjectPromptParams {
            reference: project.id,
            name: "issue".to_owned(),
        },
    )
    .await
    .expect("project.prompt through remote daemon");

    assert_eq!(prompt.content, "REMOTE TARGET ${title}");
    assert!(!prompt.content.contains("OPERATOR LOCAL"));

    daemon.shutdown().await;
}

#[test]
fn rendered_gui_prompt_matches_shared_prompt_render_for_same_context() {
    let action = ProjectActionResult {
        provider: ProviderKind::LinearIssue,
        agent: "codex".to_owned(),
        base_branch: Some("develop".to_owned()),
        branch: None,
        prompt_name: "issue".to_owned(),
        prompt_content: "Issue ${id}: ${title}\n${body}\nbranch=${branch}\n".to_owned(),
    };
    let context_json = r#"{"identifier":"LIN-123","title":"Fix launcher","description":"Issue body","branchName":"lin-123-fix-launcher","url":"https://linear.test/LIN-123"}"#;

    let preview =
        preview_action_prompt(&action, "LIN-123", context_json).expect("GUI action prompt preview");
    let direct_preview = preview_prompt_content(
        "issue",
        &action.prompt_content,
        &PromptContext {
            provider: pohunek_gui_core::PromptProvider::LinearIssue,
            item_id: "LIN-123".to_owned(),
            json: context_json.to_owned(),
        },
    )
    .expect("GUI direct prompt preview");
    let expected = pohunek_gui_core::render_prompt(
        &action.prompt_content,
        pohunek_gui_core::PromptProvider::LinearIssue,
        "LIN-123",
        context_json,
    )
    .expect("shared prompt render");

    assert_eq!(preview.rendered, expected);
    assert_eq!(direct_preview.rendered, expected);
    assert_eq!(preview.prompt_name, "issue");
    assert_eq!(preview.branch.as_deref(), Some("lin-123-fix-launcher"));
}

#[test]
fn preview_state_updates_without_launching_session() {
    let host_id = HostId::new("preview-host");
    let mut workspace = Workspace::default();
    workspace.apply(DomainEvent::HostSnapshotLoaded {
        snapshot: HostSnapshot {
            host_id: host_id.clone(),
            health: HealthSummary {
                status: "ok".to_owned(),
                daemon_version: "0.3.0-preview".to_owned(),
                protocol_version: protocol::PROTOCOL_VERSION,
            },
            sessions: Vec::new(),
            projects: Vec::new(),
            project_error: None,
            notifications: Vec::new(),
            supported_agents: Vec::new(),
            runtimes: Vec::new(),
            notification_providers: Vec::new(),
            observation_capabilities: pohunek_gui_core::ObservationCapabilities::default(),
        },
    });
    let preview = PromptPreview {
        prompt_name: "issue".to_owned(),
        rendered: "Issue LIN-123".to_owned(),
        branch: Some("lin-123".to_owned()),
    };

    workspace.apply(DomainEvent::PromptPreviewRendered {
        host_id: host_id.clone(),
        preview: preview.clone(),
    });

    let host = workspace.hosts.get(&host_id).expect("host view");
    assert_eq!(host.prompt.preview, Some(preview));
    assert!(host.sessions.is_empty());
}

#[tokio::test]
async fn launch_from_rendered_preset_creates_one_session_with_rendered_input() {
    let mut env = ProcessEnv::lock();
    let bin_dir = temp_dir("gui-core-m3-launch-bin");
    let record_dir = temp_dir("gui-core-m3-launch-record");
    let prompt_out = record_dir.join("prompt.txt");
    write_executable(&bin_dir.join("codex"), &recording_script(&prompt_out));
    prepend_path(&mut env, &bin_dir);

    let daemon = LoopbackDaemon::spawn("m3-launch").await;
    let host = daemon.host("host-launch");
    let repo = init_git_repo("gui-core-m3-launch-repo");
    write_provider_action_fixture(
        &repo,
        "issue",
        "process-issue",
        "linear_issue",
        "Issue ${id}: ${title}\n${body}\nbranch=${branch}\n",
    );
    let project = add_project(
        &host,
        ProjectAddParams {
            path: Some(repo),
            name: Some("Launch Project".to_owned()),
            base_branch: Some("main".to_owned()),
        },
    )
    .await
    .expect("project.add");
    let before = load_host_snapshot(&host)
        .await
        .expect("snapshot before launch")
        .sessions
        .len();
    let action = resolve_project_action(
        &host,
        ProjectActionParams {
            reference: project.id.clone(),
            name: "process-issue".to_owned(),
        },
    )
    .await
    .expect("project.action");
    let context_json = r#"{"identifier":"LIN-123","title":"Fix launcher","description":"Issue body","branchName":"lin-123-fix-launcher","url":"https://linear.test/LIN-123"}"#;
    let preview =
        preview_action_prompt(&action, "LIN-123", context_json).expect("render action preview");

    let launched = launch_action_prompt_with_options(
        &host,
        PromptLaunchParams {
            project: project.id.clone(),
            action,
            preview: preview.clone(),
            cols: 80,
            rows: 24,
            metadata: std::collections::BTreeMap::new(),
            name: None,
        },
        test_connection_options(),
    )
    .await
    .expect("launch rendered prompt");

    assert_eq!(
        launched.session.branch.as_deref(),
        Some("lin-123-fix-launcher")
    );
    assert_eq!(
        launched.session.project_id.as_deref(),
        Some(project.id.as_str())
    );
    assert!(launched.session.metadata.is_empty());

    let recorded = wait_for_file(&prompt_out).await;
    assert_eq!(recorded, preview.rendered);

    let after = load_host_snapshot(&host)
        .await
        .expect("snapshot after launch")
        .sessions;
    assert_eq!(after.len(), before + 1);
    assert_eq!(
        after
            .iter()
            .filter(|session| session.id == launched.session.id)
            .count(),
        1
    );

    stop_session(&host, &launched.session.id).await;
    daemon.shutdown().await;
}

#[tokio::test]
async fn assistant_launch_creates_project_session_with_opening_prompt() {
    let mut env = ProcessEnv::lock();
    let bin_dir = temp_dir("gui-core-assistant-bin");
    let record_dir = temp_dir("gui-core-assistant-record");
    let prompt_out = record_dir.join("prompt.txt");
    write_executable(&bin_dir.join("codex"), &recording_script(&prompt_out));
    prepend_path(&mut env, &bin_dir);

    let daemon = LoopbackDaemon::spawn("assistant-launch").await;
    let host = daemon.host("host-assistant");
    let repo = init_git_repo("gui-core-assistant-repo");
    let project = add_project(
        &host,
        ProjectAddParams {
            path: Some(repo),
            name: Some("Assistant Project".to_owned()),
            base_branch: Some("main".to_owned()),
        },
    )
    .await
    .expect("project.add");
    let paths = AssistantPaths {
        runtime_dir: temp_dir("gui-core-assistant-runtime"),
        data_dir: temp_dir("gui-core-assistant-data"),
        log_dir: temp_dir("gui-core-assistant-logs"),
        cache_dir: temp_dir("gui-core-assistant-cache"),
        config_dir: temp_dir("gui-core-assistant-config"),
    };

    let launched = assistant::launch_with_options(
        &host,
        &paths,
        LaunchParams {
            intent: Intent::Debug,
            request: Some("inspect the GUI assistant launcher".to_owned()),
            agent: None,
            project: Some(project.id.clone()),
            repo: None,
            branch: None,
            base_branch: None,
            cols: 80,
            rows: 24,
            no_snapshot: true,
            degraded: false,
            auto_started_daemon: false,
        },
        test_connection_options(),
    )
    .await
    .expect("assistant launch");

    assert_eq!(
        launched.session.project_id.as_deref(),
        Some(project.id.as_str())
    );
    assert_eq!(launched.session.agent, "codex");
    assert_eq!(launched.applied_input, Some(true));
    assert_eq!(launched.assistant.intent, Intent::Debug);
    assert_eq!(launched.assistant.agent, "codex");
    assert_eq!(launched.assistant.knowledge, "materialized");

    let recorded = wait_for_file(&prompt_out).await;
    assert!(recorded.contains("# Pohunek Assistant"));
    assert!(recorded.contains("intent: debug"));
    assert!(recorded.contains("request: inspect the GUI assistant launcher"));

    stop_session(&host, &launched.session.id).await;
    daemon.shutdown().await;
}

#[tokio::test]
#[allow(
    clippy::too_many_lines,
    reason = "keeps the linked launch and metadata-persistence flow in one end-to-end assertion"
)]
async fn provider_launch_linear_issue_creates_one_linked_session_and_persists_metadata() {
    let mut env = ProcessEnv::lock();
    let bin_dir = temp_dir("gui-core-m4-linear-bin");
    let record_dir = temp_dir("gui-core-m4-linear-record");
    let prompt_out = record_dir.join("prompt.txt");
    write_executable(&bin_dir.join("codex"), &recording_script(&prompt_out));
    prepend_path(&mut env, &bin_dir);

    let mut daemon = LoopbackDaemon::spawn("m4-linear").await;
    let host = daemon.host("host-linear");
    let repo = init_git_repo("gui-core-m4-linear-repo");
    write_provider_action_fixture(
        &repo,
        "issue",
        "process-issue",
        "linear_issue",
        "Issue ${id}: ${title}\n${body}\nbranch=${branch}\n",
    );
    let project = add_project(
        &host,
        ProjectAddParams {
            path: Some(repo),
            name: Some("Linear Launch Project".to_owned()),
            base_branch: Some("main".to_owned()),
        },
    )
    .await
    .expect("project.add");
    let before = load_host_snapshot(&host)
        .await
        .expect("snapshot before linear launch")
        .sessions
        .len();
    let context_json = r#"{"identifier":"LIN-123","title":"Fix launcher","description":"Issue body","branchName":"lin-123-fix-launcher","url":"https://linear.test/LIN-123","token":"lin_api_secret_fixture"}"#;
    let item =
        ProviderLaunchItem::linear_issue("LIN-123", context_json, "https://linear.test/LIN-123")
            .expect("linear launch item");

    let launched = launch_provider_item_with_options(
        &host,
        ProviderLaunchParams {
            project: project.id.clone(),
            action_name: "process-issue".to_owned(),
            item,
            cols: 80,
            rows: 24,
            name: None,
        },
        test_connection_options(),
    )
    .await
    .expect("launch linked Linear issue");

    let expected_prompt = "Issue LIN-123: Fix launcher\nIssue body\nbranch=lin-123-fix-launcher\n";
    assert_eq!(wait_for_file(&prompt_out).await, expected_prompt);
    assert_eq!(
        launched.session.branch.as_deref(),
        Some("lin-123-fix-launcher")
    );
    assert_eq!(
        launched.session.project_id.as_deref(),
        Some(project.id.as_str())
    );
    let expected_link = expected_linear_link_metadata();
    assert_eq!(
        launched.session.metadata,
        expected_link.to_session_metadata()
    );
    assert_eq!(
        session_link_metadata(&launched.session),
        Some(expected_link)
    );
    let metadata_json = serde_json::to_string(&launched.session.metadata).expect("metadata json");
    assert!(!metadata_json.contains("lin_api_secret_fixture"));

    let after = load_host_snapshot(&host)
        .await
        .expect("snapshot after linear launch")
        .sessions;
    assert_eq!(after.len(), before + 1);
    assert_eq!(
        after
            .iter()
            .filter(|session| session.id == launched.session.id)
            .count(),
        1
    );

    report_native_id(&host, &launched.session.id, "codex", "native-linear-1").await;
    let captured = wait_for_native_id(&host, &launched.session.id, "native-linear-1").await;
    assert_eq!(captured.metadata, launched.session.metadata);
    stop_session(&host, &launched.session.id).await;
    // The daemon's own store is read back through a restarted daemon.
    daemon.restart().await;
    let persisted = load_host_snapshot(&host)
        .await
        .expect("snapshot after daemon restart")
        .sessions
        .into_iter()
        .find(|session| session.id == launched.session.id)
        .expect("linked session record survives the restart");
    assert_eq!(
        session_link_metadata(&persisted),
        session_link_metadata(&launched.session)
    );

    daemon.shutdown().await;
}

#[tokio::test]
async fn provider_launch_github_pr_creates_one_linked_session_with_rendered_input() {
    let mut env = ProcessEnv::lock();
    let bin_dir = temp_dir("gui-core-m4-github-bin");
    let record_dir = temp_dir("gui-core-m4-github-record");
    let prompt_out = record_dir.join("prompt.txt");
    write_executable(&bin_dir.join("claude"), &recording_script(&prompt_out));
    prepend_path(&mut env, &bin_dir);

    let daemon = LoopbackDaemon::spawn("m4-github").await;
    let host = daemon.host("host-github");
    let repo = init_git_repo("gui-core-m4-github-repo");
    write_provider_action_fixture(
        &repo,
        "pr",
        "review-pr",
        "github_pr",
        "PR ${number}: ${title}\n${body}\nbranch=${branch}\nurl=${url}\n",
    );
    let project = add_project(
        &host,
        ProjectAddParams {
            path: Some(repo),
            name: Some("GitHub Launch Project".to_owned()),
            base_branch: Some("main".to_owned()),
        },
    )
    .await
    .expect("project.add");
    let before = load_host_snapshot(&host)
        .await
        .expect("snapshot before github launch")
        .sessions
        .len();
    let context_json = r#"{"number":7,"title":"Fix filters","body":"Body text","headRefName":"feature/filters","branch":"feature/filters","url":"https://github.example/repo/pull/7"}"#;
    let item = ProviderLaunchItem::github_pull_request(
        "7",
        context_json,
        "https://github.example/repo/pull/7",
    )
    .expect("GitHub PR launch item");

    let launched = launch_provider_item_with_options(
        &host,
        ProviderLaunchParams {
            project: project.id.clone(),
            action_name: "review-pr".to_owned(),
            item,
            cols: 80,
            rows: 24,
            name: None,
        },
        test_connection_options(),
    )
    .await
    .expect("launch linked GitHub PR");

    let expected_prompt =
        "PR 7: Fix filters\nBody text\nbranch=feature/filters\nurl=https://github.example/repo/pull/7\n";
    assert_eq!(wait_for_file(&prompt_out).await, expected_prompt);
    assert_eq!(launched.session.branch.as_deref(), Some("feature/filters"));
    assert_eq!(
        launched.session.metadata,
        std::collections::BTreeMap::from([
            ("link.provider".to_owned(), "github".to_owned()),
            ("link.kind".to_owned(), "pull_request".to_owned()),
            ("link.id".to_owned(), "7".to_owned()),
            (
                "link.url".to_owned(),
                "https://github.example/repo/pull/7".to_owned(),
            ),
            ("link.branch".to_owned(), "feature/filters".to_owned()),
        ])
    );

    let after = load_host_snapshot(&host)
        .await
        .expect("snapshot after github launch")
        .sessions;
    assert_eq!(after.len(), before + 1);
    assert_eq!(
        after
            .iter()
            .filter(|session| session.id == launched.session.id)
            .count(),
        1
    );

    stop_session(&host, &launched.session.id).await;
    daemon.shutdown().await;
}

#[tokio::test]
async fn prompt_errors_surface_without_corrupting_workspace_state() {
    let mut env = ProcessEnv::lock();
    let bin_dir = temp_dir("gui-core-m3-error-bin");
    write_executable(&bin_dir.join("codex"), "#!/bin/sh\n/bin/sleep 30\n");
    prepend_path(&mut env, &bin_dir);

    let daemon = LoopbackDaemon::spawn("m3-error").await;
    let host = daemon.host("host-error");
    let repo = init_git_repo("gui-core-m3-error-repo");
    write_prompt_error_fixture(&repo);
    let project = add_project(
        &host,
        ProjectAddParams {
            path: Some(repo),
            name: Some("Error Project".to_owned()),
            base_branch: Some("main".to_owned()),
        },
    )
    .await
    .expect("project.add");
    let existing =
        create_agent_session(&host, RuntimeRef::codex(), temp_dir("gui-core-m3-existing")).await;
    let mut workspace = Workspace::default();
    workspace.apply(DomainEvent::HostSnapshotLoaded {
        snapshot: load_host_snapshot(&host).await.expect("seed workspace"),
    });
    let before_sessions = workspace
        .hosts
        .get(&host.id)
        .expect("host view")
        .sessions
        .clone();
    let before_projects = workspace
        .hosts
        .get(&host.id)
        .expect("host view")
        .projects
        .clone();

    apply_prompt_error_cases(&mut workspace, &host, project.id).await;

    let host_view = workspace
        .hosts
        .get(&host.id)
        .expect("host view after errors");
    assert!(host_view.last_error.is_some());
    assert_eq!(host_view.sessions, before_sessions);
    assert_eq!(host_view.projects, before_projects);
    assert!(host_view.sessions.contains_key(&existing.id.0));

    stop_session(&host, &existing.id).await;
    daemon.shutdown().await;
}

fn write_prompt_error_fixture(repo: &Path) {
    write_file(
        &repo.join(".pohunek/templates.toml"),
        r#"
[template.issue]
agent = "codex"
prompt = "issue"
"#,
    );
    write_file(
        &repo.join(".pohunek/actions.toml"),
        r#"
[action.process-issue]
template = "issue"
provider = "linear_issue"
"#,
    );
    write_file(
        &repo.join(".pohunek/prompts/issue.tmpl"),
        "Issue ${id}: ${missing}\n",
    );
}

async fn apply_prompt_error_cases(
    workspace: &mut Workspace,
    host: &HostConfig,
    project_id: String,
) {
    let missing_prompt = resolve_project_prompt(
        host,
        ProjectPromptParams {
            reference: project_id.clone(),
            name: "missing".to_owned(),
        },
    )
    .await
    .expect_err("missing prompt should fail");
    workspace.apply(DomainEvent::HostOperationFailed {
        host_id: host.id.clone(),
        error: missing_prompt.to_string(),
    });

    let missing_action = resolve_project_action(
        host,
        ProjectActionParams {
            reference: project_id.clone(),
            name: "missing-action".to_owned(),
        },
    )
    .await
    .expect_err("missing action should fail");
    workspace.apply(DomainEvent::HostOperationFailed {
        host_id: host.id.clone(),
        error: missing_action.to_string(),
    });

    let action = resolve_project_action(
        host,
        ProjectActionParams {
            reference: project_id,
            name: "process-issue".to_owned(),
        },
    )
    .await
    .expect("project.action");
    let render_error = preview_action_prompt(
        &action,
        "LIN-123",
        r#"{"identifier":"LIN-123","title":"Fix launcher","description":"Issue body","branchName":"lin-123-fix-launcher"}"#,
    )
    .expect_err("unknown variable should fail");
    workspace.apply(DomainEvent::HostOperationFailed {
        host_id: host.id.clone(),
        error: render_error.to_string(),
    });
}

#[test]
fn attach_command_spawn_intent_is_resolved_without_embedded_terminal() {
    #[derive(Debug, Default)]
    struct RecordingSpawner {
        commands: Vec<String>,
    }

    impl AttachCommandSpawner for RecordingSpawner {
        fn spawn(&mut self, command: &str) -> Result<(), String> {
            self.commands.push(command.to_owned());
            Ok(())
        }
    }

    let mut spawner = RecordingSpawner::default();
    let intent = spawn_attach_command(
        &mut spawner,
        "$TERMINAL -e {bin} attach --host {host} {id}",
        &AttachTemplateValues {
            bin: "pohunek".to_owned(),
            host: "devbox".to_owned(),
            id: "s-42".to_owned(),
        },
    )
    .expect("spawn attach command");

    assert_eq!(
        intent,
        AttachSpawnIntent {
            command: "$TERMINAL -e pohunek attach --host devbox s-42".to_owned(),
        }
    );
    assert_eq!(spawner.commands, vec![intent.command]);
}

#[test]
fn ui_state_persists_and_restores() {
    let state_dir = temp_dir("gui-core-m1-ui-state");
    let host = HostConfig::tcp("host-a", "127.0.0.1:65535".parse().expect("addr"));
    let state = UiState {
        window_size: WindowSize {
            width: 1440,
            height: 900,
        },
        selection: Some(Selection::Session {
            host_id: host.id,
            session_id: SessionId("s-1".to_owned()),
        }),
    };

    state.save_to_dir(&state_dir).expect("save ui state");
    let restored = UiState::load_from_dir(&state_dir).expect("restore ui state");

    assert_eq!(restored, state);
}

fn review_prompt_template() -> &'static str {
    "Review of ${source} on branch ${branch} (${comment_count} comments):\n${comments}\n"
}

/// Points `XDG_CONFIG_HOME` at a fresh temp dir with a `review.tmpl` in place,
/// so [`render_review_prompt`] finds a template without touching the real
/// operator config.
fn install_review_template(env: &mut ProcessEnv, tag: &str) {
    let config_home = temp_dir(tag);
    write_file(
        &config_home.join("pohunek/prompts/review.tmpl"),
        review_prompt_template(),
    );
    env.set("XDG_CONFIG_HOME", config_home);
}

async fn create_worktree_session(host: &HostConfig, project_id: &str, branch: &str) -> SessionInfo {
    no_origin::create_session(
        host,
        SessionNewParams {
            agent: agent_name(&RuntimeRef::codex()).to_owned(),
            name: None,
            cwd: None,
            cols: 80,
            rows: 24,
            project: Some(project_id.to_owned()),
            repo: None,
            branch: Some(branch.to_owned()),
            base_branch: Some("main".to_owned()),
            input: None,
            extended_input_ready_wait: None,
            metadata: std::collections::BTreeMap::new(),
        },
    )
    .await
    .expect("session.new creates worktree")
    .session
}

#[tokio::test]
async fn review_session_diff_is_parsed_into_added_and_modified_files() {
    let mut env = ProcessEnv::lock();
    let bin_dir = temp_dir("gui-core-review-diff-bin");
    write_executable(&bin_dir.join("codex"), "#!/bin/sh\n/bin/sleep 30\n");
    prepend_path(&mut env, &bin_dir);

    let daemon = LoopbackDaemon::spawn("review-diff").await;
    let host = daemon.host("host-review-diff");
    let repo = init_git_repo("gui-core-review-diff-repo");
    let project = add_project(
        &host,
        ProjectAddParams {
            path: Some(repo),
            name: Some("Review Diff Project".to_owned()),
            base_branch: Some("main".to_owned()),
        },
    )
    .await
    .expect("project.add");

    let session = create_worktree_session(&host, &project.id, "feature/diff-review").await;
    let worktree_path = session
        .worktree_path
        .clone()
        .expect("worktree path present");

    std::fs::write(worktree_path.join("README.md"), "init\nchanged\n").expect("edit README");
    std::fs::write(worktree_path.join("new_file.txt"), "brand new content\n")
        .expect("write new file");

    let diff_result = no_origin::diff_session(
        &host,
        SessionDiffParams {
            session_id: session.id.clone(),
            base: None,
        },
    )
    .await
    .expect("session.diff");
    assert!(!diff_result.truncated);

    let model = parse_unified_diff(&diff_result.diff);
    let readme = model
        .files
        .iter()
        .find(|file| file.path == "README.md")
        .expect("README.md present in the parsed diff");
    assert_eq!(readme.status, DiffFileStatus::Modified);
    let new_file = model
        .files
        .iter()
        .find(|file| file.path == "new_file.txt")
        .expect("new_file.txt present in the parsed diff");
    assert_eq!(new_file.status, DiffFileStatus::Added);

    stop_session(&host, &session.id).await;
    daemon.shutdown().await;
}

#[tokio::test]
#[allow(
    clippy::too_many_lines,
    reason = "keeps the dispatch, metadata-copy, and reload-after-dispatch assertions in one end-to-end flow"
)]
async fn review_dispatch_creates_one_session_in_the_same_worktree_with_copied_link_metadata() {
    let mut env = ProcessEnv::lock();
    install_review_template(&mut env, "gui-core-review-dispatch-config-home");

    // Plain no-op `codex` for the *source* session: it takes no `input`, so
    // it must not touch the recorded prompt file at all. If it shared the
    // recording script installed below, its own (empty) invocation could win
    // a race against the dispatched session's write to the same file.
    let sleep_bin_dir = temp_dir("gui-core-review-dispatch-sleep-bin");
    write_executable(&sleep_bin_dir.join("codex"), "#!/bin/sh\n/bin/sleep 30\n");
    prepend_path(&mut env, &sleep_bin_dir);
    // The recording directory is on `PATH` ahead of the plain one from the
    // start, because the sessions' environment is fixed when the daemon is
    // built. It holds no `codex` until the recording script is written below.
    let record_bin_dir = temp_dir("gui-core-review-dispatch-record-bin");
    prepend_path(&mut env, &record_bin_dir);

    let daemon = LoopbackDaemon::spawn("review-dispatch").await;
    let host = daemon.host("host-review-dispatch");
    let repo = init_git_repo("gui-core-review-dispatch-repo");
    let project = add_project(
        &host,
        ProjectAddParams {
            path: Some(repo),
            name: Some("Review Dispatch Project".to_owned()),
            base_branch: Some("main".to_owned()),
        },
    )
    .await
    .expect("project.add");

    let session = create_worktree_session(&host, &project.id, "feature/diff-review").await;

    // Only now install the recording `codex` script, prepended in front of
    // the plain one above, so exactly one process — the one dispatch spawns
    // below — ever writes to `prompt_out`.
    let record_dir = temp_dir("gui-core-review-dispatch-record");
    let prompt_out = record_dir.join("prompt.txt");
    write_executable(
        &record_bin_dir.join("codex"),
        &recording_script(&prompt_out),
    );

    set_session_metadata(
        &host,
        SessionSetMetadataParams {
            session_id: session.id.clone(),
            metadata: std::collections::BTreeMap::from([
                ("link.provider".to_owned(), Some("github".to_owned())),
                ("link.kind".to_owned(), Some("pull_request".to_owned())),
                ("link.id".to_owned(), Some("42".to_owned())),
                (
                    "link.url".to_owned(),
                    Some("https://github.test/pull/42".to_owned()),
                ),
                (
                    "link.branch".to_owned(),
                    Some("feature/diff-review".to_owned()),
                ),
                (
                    "not_link_key".to_owned(),
                    Some("must not be copied".to_owned()),
                ),
            ]),
        },
    )
    .await
    .expect("session.set_metadata");

    let session_info = inspect_session(&host, &session.id)
        .await
        .expect("session.inspect");

    let store = ReviewStore::new(temp_dir("gui-core-review-dispatch-store"));
    let mut review = Review::new(
        ReviewSource::Session {
            host_id: host.id.clone(),
            session_id: session.id.clone(),
        },
        project.id.clone(),
        "feature/diff-review",
    );
    review.add_comment(ReviewComment::new(
        "src/lib.rs",
        ReviewSide::New,
        10,
        "fix this",
    ));
    store.save(&review).expect("save draft review");

    let rendered_prompt =
        render_review_prompt(&review, "session diff-review worktree diff vs main")
            .expect("render review prompt");

    let dispatched = dispatch_review(
        &mut review,
        ReviewDispatchParams {
            config: &host,
            store: &store,
            session_info: &session_info,
            agent: None,
            rendered_prompt,
            cols: 80,
            rows: 24,
            options: test_connection_options(),
        },
    )
    .await
    .expect("dispatch review");

    assert_eq!(
        dispatched.session.cwd,
        session_info.worktree_path.clone().expect("worktree path")
    );
    assert_eq!(
        dispatched
            .session
            .metadata
            .get("link.provider")
            .map(String::as_str),
        Some("github")
    );
    assert_eq!(
        dispatched
            .session
            .metadata
            .get("link.id")
            .map(String::as_str),
        Some("42")
    );
    assert!(!dispatched.session.metadata.contains_key("not_link_key"));
    assert_eq!(
        dispatched
            .session
            .metadata
            .get("review.source")
            .map(String::as_str),
        Some(review.id.as_str())
    );
    assert!(dispatched
        .session
        .metadata
        .contains_key("review.dispatched_at"));

    assert_eq!(review.status, ReviewStatus::Dispatched);
    assert_eq!(
        review.dispatched_session_id,
        Some(dispatched.session.id.clone())
    );

    let reloaded = store
        .load_all()
        .into_iter()
        .find_map(|entry| entry.ok().filter(|loaded| loaded.id == review.id))
        .expect("reloaded dispatched review");
    assert_eq!(reloaded.status, ReviewStatus::Dispatched);
    assert_eq!(reloaded.dispatched_session_id, review.dispatched_session_id);

    let prompt_content = wait_for_file(&prompt_out).await;
    assert!(prompt_content.contains("fix this"));

    stop_session(&host, &session.id).await;
    stop_session(&host, &dispatched.session.id).await;
    daemon.shutdown().await;
}

#[tokio::test]
async fn review_dispatch_leaves_the_draft_byte_identical_when_session_new_fails() {
    let mut env = ProcessEnv::lock();
    install_review_template(&mut env, "gui-core-review-dispatch-fail-config-home");

    let bin_dir = temp_dir("gui-core-review-dispatch-fail-bin");
    write_executable(&bin_dir.join("codex"), "#!/bin/sh\n/bin/sleep 30\n");
    prepend_path(&mut env, &bin_dir);

    let daemon = LoopbackDaemon::spawn("review-dispatch-fail").await;
    let host = daemon.host("host-review-dispatch-fail");
    let repo = init_git_repo("gui-core-review-dispatch-fail-repo");
    let project = add_project(
        &host,
        ProjectAddParams {
            path: Some(repo),
            name: Some("Review Dispatch Fail Project".to_owned()),
            base_branch: Some("main".to_owned()),
        },
    )
    .await
    .expect("project.add");

    let session = create_worktree_session(&host, &project.id, "feature/diff-review").await;

    // Force the daemon to refuse `session.new`: a bogus agent profile name
    // fails `resolve_agent` while the worktree path is still valid, so this
    // exercises the daemon-refusal path specifically, not the local
    // missing-worktree pre-check.
    let mut session_info = inspect_session(&host, &session.id)
        .await
        .expect("session.inspect");
    session_info.agent = "not-a-real-agent-profile".to_owned();

    let store = ReviewStore::new(temp_dir("gui-core-review-dispatch-fail-store"));
    let mut review = Review::new(
        ReviewSource::Session {
            host_id: host.id.clone(),
            session_id: session.id.clone(),
        },
        project.id.clone(),
        "feature/diff-review",
    );
    store.save(&review).expect("save draft review");
    let draft_before =
        std::fs::read(store.path_for(&review.id)).expect("read draft before dispatch attempt");

    let rendered_prompt =
        render_review_prompt(&review, "session diff-review worktree diff vs main")
            .expect("render review prompt");

    let error = dispatch_review(
        &mut review,
        ReviewDispatchParams {
            config: &host,
            store: &store,
            session_info: &session_info,
            agent: None,
            rendered_prompt,
            cols: 80,
            rows: 24,
            options: test_connection_options(),
        },
    )
    .await
    .expect_err("dispatch fails when the daemon refuses the bogus agent");
    assert!(!matches!(
        error,
        CoreError::ReviewSessionMissingWorktree { .. }
    ));

    assert_eq!(review.status, ReviewStatus::Draft);
    assert!(review.dispatched_session_id.is_none());
    let draft_after =
        std::fs::read(store.path_for(&review.id)).expect("read draft after failed dispatch");
    assert_eq!(draft_before, draft_after);

    stop_session(&host, &session.id).await;
    daemon.shutdown().await;
}

#[tokio::test]
async fn review_dispatch_uses_the_overridden_agent_instead_of_the_source_sessions() {
    let mut env = ProcessEnv::lock();
    install_review_template(
        &mut env,
        "gui-core-review-dispatch-agent-override-config-home",
    );

    let bin_dir = temp_dir("gui-core-review-dispatch-agent-override-bin");
    write_executable(&bin_dir.join("codex"), "#!/bin/sh\n/bin/sleep 30\n");
    prepend_path(&mut env, &bin_dir);

    let daemon = LoopbackDaemon::spawn("review-dispatch-agent-override").await;
    let host = daemon.host("host-review-dispatch-agent-override");
    let repo = init_git_repo("gui-core-review-dispatch-agent-override-repo");
    let project = add_project(
        &host,
        ProjectAddParams {
            path: Some(repo),
            name: Some("Review Dispatch Agent Override Project".to_owned()),
            base_branch: Some("main".to_owned()),
        },
    )
    .await
    .expect("project.add");

    // The source session runs `codex`; the override below dispatches into
    // `shell` instead, proving `ReviewDispatchParams::agent` — not
    // `session_info.agent` — decides the dispatched session's agent.
    let session = create_worktree_session(&host, &project.id, "feature/diff-review").await;
    let session_info = inspect_session(&host, &session.id)
        .await
        .expect("session.inspect");
    assert_eq!(session_info.agent, agent_name(&RuntimeRef::codex()));

    let store = ReviewStore::new(temp_dir("gui-core-review-dispatch-agent-override-store"));
    let mut review = Review::new(
        ReviewSource::Session {
            host_id: host.id.clone(),
            session_id: session.id.clone(),
        },
        project.id.clone(),
        "feature/diff-review",
    );
    store.save(&review).expect("save draft review");

    let rendered_prompt =
        render_review_prompt(&review, "session diff-review worktree diff vs main")
            .expect("render review prompt");

    let dispatched = dispatch_review(
        &mut review,
        ReviewDispatchParams {
            config: &host,
            store: &store,
            session_info: &session_info,
            agent: Some(agent_name(&RuntimeRef::shell()).to_owned()),
            rendered_prompt,
            cols: 80,
            rows: 24,
            options: test_connection_options(),
        },
    )
    .await
    .expect("dispatch review with agent override");

    assert_eq!(dispatched.session.agent, agent_name(&RuntimeRef::shell()));
    assert_ne!(dispatched.session.agent, session_info.agent);

    stop_session(&host, &session.id).await;
    stop_session(&host, &dispatched.session.id).await;
    daemon.shutdown().await;
}

#[tokio::test]
async fn review_state_never_contains_diff_content_or_embedded_secrets() {
    const SECRET_FIXTURE: &str = "gh_api_secret_fixture_should_never_persist";

    let mut env = ProcessEnv::lock();
    install_review_template(&mut env, "gui-core-review-secret-scan-config-home");

    let bin_dir = temp_dir("gui-core-review-secret-scan-bin");
    write_executable(&bin_dir.join("codex"), "#!/bin/sh\n/bin/sleep 30\n");
    prepend_path(&mut env, &bin_dir);

    let daemon = LoopbackDaemon::spawn("review-secret-scan").await;
    let host = daemon.host("host-review-secret-scan");
    let repo = init_git_repo("gui-core-review-secret-scan-repo");
    let project = add_project(
        &host,
        ProjectAddParams {
            path: Some(repo),
            name: Some("Review Secret Scan Project".to_owned()),
            base_branch: Some("main".to_owned()),
        },
    )
    .await
    .expect("project.add");

    let session = create_worktree_session(&host, &project.id, "feature/diff-review").await;
    let worktree_path = session
        .worktree_path
        .clone()
        .expect("worktree path present");

    std::fs::write(
        worktree_path.join("config.txt"),
        format!("token = {SECRET_FIXTURE}\n"),
    )
    .expect("write file containing fixture secret");

    let diff_params = SessionDiffParams {
        session_id: session.id.clone(),
        base: None,
    };
    let diff_result = no_origin::diff_session(&host, diff_params.clone())
        .await
        .expect("session.diff");
    // Sanity: the secret really is present in the fetched diff text, so the
    // absence checks below are meaningful rather than vacuous.
    assert!(diff_result.diff.contains(SECRET_FIXTURE));
    // `session.diff`'s own request carries only a session id/base, never file
    // content, so it cannot leak the secret either.
    let request_json = serde_json::to_string(&diff_params).expect("serialize request params");
    assert!(!request_json.contains(SECRET_FIXTURE));

    let session_info = inspect_session(&host, &session.id)
        .await
        .expect("session.inspect");

    let store = ReviewStore::new(temp_dir("gui-core-review-secret-scan-store"));
    let mut review = Review::new(
        ReviewSource::Session {
            host_id: host.id.clone(),
            session_id: session.id.clone(),
        },
        project.id.clone(),
        "feature/diff-review",
    );
    // Operator-authored comment text; deliberately does not quote the secret,
    // matching how a real reviewer would comment on the file without pasting
    // its content back.
    review.add_comment(ReviewComment::new(
        "config.txt",
        ReviewSide::New,
        1,
        "do not commit real tokens here",
    ));
    store.save(&review).expect("save draft review");

    let rendered_prompt =
        render_review_prompt(&review, "session diff-review worktree diff vs main")
            .expect("render review prompt");
    let dispatched = dispatch_review(
        &mut review,
        ReviewDispatchParams {
            config: &host,
            store: &store,
            session_info: &session_info,
            agent: None,
            rendered_prompt,
            cols: 80,
            rows: 24,
            options: test_connection_options(),
        },
    )
    .await
    .expect("dispatch review");

    let review_json =
        std::fs::read_to_string(store.path_for(&review.id)).expect("read persisted review");
    assert!(!review_json.contains(SECRET_FIXTURE));
    let metadata_json =
        serde_json::to_string(&dispatched.session.metadata).expect("serialize dispatch metadata");
    assert!(!metadata_json.contains(SECRET_FIXTURE));

    stop_session(&host, &session.id).await;
    stop_session(&host, &dispatched.session.id).await;
    daemon.shutdown().await;
}

#[test]
fn review_store_load_all_surfaces_corrupt_file_errors_without_dropping_good_reviews() {
    let dir = temp_dir("gui-core-review-corrupt-file");
    let store = ReviewStore::new(&dir);
    let review = Review::new(
        ReviewSource::PullRequest {
            host_id: HostId::new("host-1"),
            pr_number: 7,
        },
        "project-1",
        "feature/x",
    );
    store.save(&review).expect("save good review");
    std::fs::write(dir.join("corrupt.json"), b"{not valid json").expect("write corrupt file");

    let loaded = store.load_all();

    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded.iter().filter(|entry| entry.is_ok()).count(), 1);
    assert_eq!(loaded.iter().filter(|entry| entry.is_err()).count(), 1);
}

/// How long a freshly started daemon may take to bind its control socket.
///
/// Startup acquires the instance locks, opens the stores and reconciles
/// workers; the ceiling only bounds a daemon that never becomes ready.
const DAEMON_READY_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a daemon may take to exit after SIGTERM before it is killed.
const DAEMON_EXIT_TIMEOUT: Duration = Duration::from_secs(15);

/// How long a daemon being dropped by a failing test may take to exit after
/// SIGTERM before it is killed.
const DAEMON_DROP_EXIT_TIMEOUT: Duration = Duration::from_secs(5);

/// File name of the daemon's stderr inside its private root, kept for
/// diagnostics when startup or shutdown fails.
const DAEMON_STDERR_FILE: &str = "pohunekd.stderr";

/// A real `pohunekd` process with its own private environment.
///
/// The daemon supervises `pohunek-sessiond` workers as direct children
/// (`POHUNEK_WORKER_LAUNCHER=subprocess`) and serves the Unix socket below the
/// environment's runtime directory.
struct LoopbackDaemon {
    env: TestEnv,
    socket: PathBuf,
    child: Option<std::process::Child>,
}

impl LoopbackDaemon {
    /// Starts a daemon. `tag` only labels failures.
    async fn spawn(tag: &str) -> Self {
        let env = TestEnv::new().expect("create the daemon's private environment");
        let uid = std::fs::metadata(env.root())
            .expect("daemon environment root metadata")
            .uid();
        let socket = pohunek_paths::BasePaths::resolve_for(
            pohunek_paths::Platform::current().expect("supported platform"),
            uid,
            &pohunek_paths::PathEnv {
                xdg_runtime_dir: Some(env.runtime_dir().into()),
                xdg_data_home: Some(env.data_home().into()),
                xdg_state_home: Some(env.state_home().into()),
                xdg_cache_home: Some(env.cache_home().into()),
                xdg_config_home: Some(env.config_home().into()),
                home: Some(env.home().into()),
            },
        )
        .expect("resolve the daemon socket path")
        .socket;
        let mut daemon = Self {
            env,
            socket,
            child: None,
        };
        daemon.start(tag).await;
        daemon
    }

    /// Host configuration reaching this daemon over its Unix socket.
    fn host(&self, id: &str) -> HostConfig {
        HostConfig::local(id, &self.socket)
    }

    /// Process id of the running daemon.
    fn pid(&self) -> u32 {
        self.child.as_ref().expect("daemon is running").id()
    }

    /// The daemon's `HOME`, which its session children inherit.
    fn home(&self) -> &Path {
        self.env.home()
    }

    /// The daemon's application config directory (`<config home>/pohunek`).
    fn config_dir(&self) -> PathBuf {
        self.env.config_home().join(pohunek_paths::APP_DIR)
    }

    async fn start(&mut self, tag: &str) {
        let stderr = std::fs::File::create(self.env.root().join(DAEMON_STDERR_FILE))
            .expect("create the daemon stderr file");
        let mut command = self.env.command(support::required_binary(
            support::DAEMON_BIN_VAR,
            "pohunekd",
        ));
        command
            .env("POHUNEK_WORKER_LAUNCHER", "subprocess")
            .env(
                support::WORKER_BIN_VAR,
                support::required_binary(support::WORKER_BIN_VAR, "pohunek-sessiond"),
            )
            // A fixed shell keeps sessions independent of the host user's
            // `$SHELL` and its startup files, whose background helpers can hold
            // the PTY open past the stop deadline.
            .env("SHELL", "/bin/sh")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(stderr);
        // Tests install fake agents by prepending to the process `PATH`; the
        // daemon passes it on to the sessions it starts.
        if let Some(path) = std::env::var_os("PATH") {
            command.env("PATH", path);
        }
        self.child = Some(command.spawn().expect("spawn pohunekd"));

        let socket = self.socket.clone();
        let stderr_path = self.env.root().join(DAEMON_STDERR_FILE);
        let child = self.child.as_mut().expect("daemon child");
        let deadline = tokio::time::Instant::now() + DAEMON_READY_TIMEOUT;
        loop {
            if let Some(status) = child.try_wait().expect("poll the daemon process") {
                panic!(
                    "{tag}: pohunekd exited during startup ({status}); stderr:\n{}",
                    std::fs::read_to_string(&stderr_path).unwrap_or_default()
                );
            }
            if tokio::net::UnixStream::connect(&socket).await.is_ok() {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "{tag}: pohunekd did not bind {} within {DAEMON_READY_TIMEOUT:?}; stderr:\n{}",
                socket.display(),
                std::fs::read_to_string(&stderr_path).unwrap_or_default()
            );
            tokio::time::sleep(wait::POLL_INTERVAL).await;
        }
    }

    /// Terminates the daemon with SIGTERM and waits for it to exit; workers keep
    /// running, as they do across a production daemon restart.
    async fn terminate(&mut self) {
        let mut child = self.child.take().expect("daemon is running");
        let pid = rustix::process::Pid::from_raw(
            i32::try_from(child.id()).expect("daemon pid fits in i32"),
        )
        .expect("daemon pid is positive");
        rustix::process::kill_process(pid, rustix::process::Signal::TERM)
            .expect("send SIGTERM to the daemon");
        let deadline = tokio::time::Instant::now() + DAEMON_EXIT_TIMEOUT;
        loop {
            if child.try_wait().expect("poll the daemon process").is_some() {
                return;
            }
            if tokio::time::Instant::now() >= deadline {
                child.kill().expect("kill the unresponsive daemon");
                child.wait().expect("reap the killed daemon");
                panic!(
                    "pohunekd ignored SIGTERM for {DAEMON_EXIT_TIMEOUT:?}; stderr:\n{}",
                    std::fs::read_to_string(self.env.root().join(DAEMON_STDERR_FILE))
                        .unwrap_or_default()
                );
            }
            tokio::time::sleep(wait::POLL_INTERVAL).await;
        }
    }

    /// Restarts the daemon over the same state; durable workers and the
    /// metadata store survive.
    async fn restart(&mut self) {
        self.terminate().await;
        self.start("restart").await;
    }

    /// Stops every session still running, then the daemon, so no worker outlives
    /// the test.
    async fn shutdown(mut self) {
        let host = self.host("shutdown");
        let snapshot = load_host_snapshot(&host)
            .await
            .expect("list the sessions to stop before shutdown");
        for session in snapshot
            .sessions
            .iter()
            .filter(|session| !session.state.is_terminal())
        {
            stop_session(&host, &session.id).await;
        }
        self.terminate().await;
    }
}

impl Drop for LoopbackDaemon {
    /// Tears down a daemon that a failing test left running, together with the
    /// workers and agents it started.
    ///
    /// Workers run in their own process groups and outlive the daemon by design,
    /// so the hierarchy is recorded first. The daemon then gets a bounded
    /// graceful exit (SIGTERM, then SIGKILL), and every recorded process that is
    /// still the same process is killed.
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        let inspector = HostInspector::new();
        let hierarchy = inspector.descendants(child.id()).unwrap_or_else(|error| {
            eprintln!("cannot list the daemon's process tree: {error}");
            Vec::new()
        });
        if let Some(pid) = i32::try_from(child.id())
            .ok()
            .and_then(rustix::process::Pid::from_raw)
        {
            let _ = rustix::process::kill_process(pid, rustix::process::Signal::TERM);
        }
        let deadline = std::time::Instant::now() + DAEMON_DROP_EXIT_TIMEOUT;
        while matches!(child.try_wait(), Ok(None)) && std::time::Instant::now() < deadline {
            std::thread::sleep(wait::POLL_INTERVAL);
        }
        if matches!(child.try_wait(), Ok(None)) {
            let _ = child.kill();
        }
        let _ = child.wait();
        for fact in hierarchy {
            let identity = fact.identity();
            if inspector.is_running(identity).unwrap_or(false) {
                if let Some(pid) = i32::try_from(identity.pid)
                    .ok()
                    .and_then(rustix::process::Pid::from_raw)
                {
                    let _ = rustix::process::kill_process(pid, rustix::process::Signal::KILL);
                }
            }
        }
    }
}

struct NotificationListErrorDaemon {
    addr: SocketAddr,
    handle: JoinHandle<()>,
}

impl NotificationListErrorDaemon {
    /// Serves `notification.list` with a runtime error.
    async fn spawn() -> Self {
        Self::spawn_with(NotificationList::StoreError).await
    }

    /// Answers `notification.list` with `method_not_found`, like a daemon build
    /// that predates the method.
    async fn spawn_without_notification_support() -> Self {
        Self::spawn_with(NotificationList::MethodNotFound).await
    }

    async fn spawn_with(notification_list: NotificationList) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("notification error daemon bind");
        let addr = listener
            .local_addr()
            .expect("notification error daemon addr");
        let handle = tokio::spawn(async move {
            let (stream, _addr) = listener
                .accept()
                .await
                .expect("notification error daemon accept");
            let mut reader = BufReader::new(stream);
            loop {
                let mut line = String::new();
                let bytes = reader
                    .read_line(&mut line)
                    .await
                    .expect("notification error daemon read request");
                if bytes == 0 {
                    break;
                }
                let request: Request =
                    serde_json::from_str(line.trim_end()).expect("parse request");
                let response = notification_error_response(&request, notification_list);
                let reply = serde_json::to_string(&response).expect("serialize response");
                reader
                    .get_mut()
                    .write_all(reply.as_bytes())
                    .await
                    .expect("write response");
                reader
                    .get_mut()
                    .write_all(b"\n")
                    .await
                    .expect("write response newline");
            }
        });
        Self { addr, handle }
    }

    async fn join(self) {
        self.handle.await.expect("notification error daemon task");
    }
}

/// How the fixture daemon answers `notification.list`.
#[derive(Debug, Clone, Copy)]
enum NotificationList {
    /// A runtime error with the code `notification_store_unavailable`.
    StoreError,
    /// The generic `method_not_found` error of an unsupported method.
    MethodNotFound,
}

fn notification_error_response(request: &Request, notification_list: NotificationList) -> Response {
    match request.method() {
        method::DAEMON_HEALTH => Response::ok(
            protocol::PROTOCOL_VERSION,
            request.id(),
            serde_json::to_value(HealthSummary {
                status: "ok".to_owned(),
                daemon_version: "0.1.0-notif-error".to_owned(),
                protocol_version: protocol::PROTOCOL_VERSION,
            })
            .expect("serialize health"),
        )
        .expect("test health response is valid"),
        method::SESSION_LIST | method::PROJECT_LIST => Response::ok(
            protocol::PROTOCOL_VERSION,
            request.id(),
            serde_json::json!([]),
        )
        .expect("test list response is valid"),
        method::NOTIFICATION_LIST if matches!(notification_list, NotificationList::StoreError) => {
            Response::err(
                protocol::PROTOCOL_VERSION,
                request.id(),
                ProtocolError::new(
                    ErrorClass::Runtime,
                    "notification_store_unavailable",
                    "notification store unavailable",
                    None,
                ),
            )
            .expect("test notification error response is valid")
        }
        method => Response::err(
            protocol::PROTOCOL_VERSION,
            request.id(),
            ProtocolError::method_not_found(method),
        )
        .expect("test method error response is valid"),
    }
}

fn test_connection_options() -> ConnectionOptions {
    ConnectionOptions {
        connect_timeout: Duration::from_millis(100),
        // `session.new` launches a real `pohunek-sessiond` subprocess: the daemon
        // forks and execs the worker, which creates its directories, binds its
        // control socket and completes a handshake before the daemon replies.
        // Single-shot request call sites (e.g. `assistant::launch_with_options`,
        // `dispatch_review`) need that budget; the reconciliation-loop call
        // sites retry on timeout via `backoff_initial`/`backoff_max`.
        request_timeout: Some(Duration::from_secs(15)),
        reconcile_interval: Duration::from_millis(100),
        backoff_initial: Duration::from_millis(10),
        backoff_max: Duration::from_millis(50),
        origin_source: OriginSource::Omitted,
    }
}

// Requires `Connected` together with the session so a caller's follow-up read
// of `conn` sees the state the predicate held on, not a later reconnect.
async fn wait_for_hosts_with_sessions<S>(
    workspace: &mut Workspace,
    events: &mut S,
    expected: &[(&HostConfig, &SessionId)],
) where
    S: futures::Stream<Item = DomainEvent> + Unpin,
{
    wait_for_workspace(events, workspace, |workspace| {
        expected.iter().all(|(host, session_id)| {
            workspace.hosts.get(&host.id).is_some_and(|view| {
                view.conn == ConnState::Connected && view.sessions.contains_key(&session_id.0)
            })
        })
    })
    .await;
}

async fn wait_for_host_connected<S>(workspace: &mut Workspace, events: &mut S, host: &HostConfig)
where
    S: futures::Stream<Item = DomainEvent> + Unpin,
{
    wait_for_workspace(events, workspace, |workspace| {
        workspace
            .hosts
            .get(&host.id)
            .is_some_and(|view| view.conn == ConnState::Connected)
    })
    .await;
}

// Returns a clone of the host view taken at the instant the predicate held. An
// unreachable host retries on a backoff and re-enters `Connecting` (clearing
// `last_error`), so only this snapshot is a stable record of the error.
async fn wait_for_host_error<S>(
    workspace: &mut Workspace,
    events: &mut S,
    host: &HostConfig,
) -> HostView
where
    S: futures::Stream<Item = DomainEvent> + Unpin,
{
    wait_for_workspace(events, workspace, |workspace| {
        workspace
            .hosts
            .get(&host.id)
            .is_some_and(|view| view.conn == ConnState::Unreachable && view.last_error.is_some())
    })
    .await;
    workspace
        .hosts
        .get(&host.id)
        .cloned()
        .expect("host view exists once its error was observed")
}

async fn wait_for_session_activity<S>(
    workspace: &mut Workspace,
    events: &mut S,
    host: &HostConfig,
    session_id: &SessionId,
    activity: AgentActivity,
) where
    S: futures::Stream<Item = DomainEvent> + Unpin,
{
    wait_for_workspace(events, workspace, |workspace| {
        workspace
            .hosts
            .get(&host.id)
            .and_then(|view| view.sessions.get(&session_id.0))
            .and_then(|session| session.activity)
            == Some(activity)
    })
    .await;
}

async fn wait_for_session_state<S>(
    workspace: &mut Workspace,
    events: &mut S,
    host: &HostConfig,
    session_id: &SessionId,
    state: protocol::SessionState,
) where
    S: futures::Stream<Item = DomainEvent> + Unpin,
{
    wait_for_workspace(events, workspace, |workspace| {
        workspace
            .hosts
            .get(&host.id)
            .and_then(|view| view.sessions.get(&session_id.0))
            .map(|session| session.state)
            == Some(state)
    })
    .await;
}

async fn wait_for_workspace<S, F>(events: &mut S, workspace: &mut Workspace, mut done: F)
where
    S: futures::Stream<Item = DomainEvent> + Unpin,
    F: FnMut(&Workspace) -> bool,
{
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !done(workspace) {
        let now = tokio::time::Instant::now();
        assert!(now < deadline, "workspace condition timed out");
        let message = tokio::time::timeout(deadline - now, events.next())
            .await
            .expect("message before deadline")
            .expect("workspace message");
        workspace.apply(message);
    }
}

/// Returns a loopback address that nothing listens on: the port is bound once
/// and released before the address is returned.
async fn unused_loopback_addr() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind unused loopback");
    let addr = listener.local_addr().expect("unused local addr");
    drop(listener);
    addr
}

/// Returns a `git` command that reads neither the user's nor the system's
/// configuration: `HOME` is private, and the system file is switched off.
fn git_command() -> std::process::Command {
    let mut command = scrubbed_command("git");
    command.env("GIT_CONFIG_NOSYSTEM", "1");
    command
}

fn init_git_repo(tag: &str) -> PathBuf {
    let dir = temp_dir(tag);
    let output = git_command()
        .args(["-c", "init.defaultBranch=main", "init", "-q"])
        .arg(&dir)
        .output()
        .expect("run git init");
    assert!(
        output.status.success(),
        "git init failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    for args in [
        ["config", "user.email", "test@example.com"],
        ["config", "user.name", "Test"],
        ["config", "commit.gpgsign", "false"],
    ] {
        let output = git_command()
            .arg("-C")
            .arg(&dir)
            .args(args)
            .output()
            .expect("run git config");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    std::fs::write(dir.join("README.md"), "init\n").expect("write README");
    for args in [vec!["add", "."], vec!["commit", "-q", "-m", "init"]] {
        let output = git_command()
            .arg("-C")
            .arg(&dir)
            .args(&args)
            .output()
            .expect("run git commit");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    dir
}

fn write_file(path: &Path, body: &str) {
    std::fs::create_dir_all(path.parent().expect("path has parent")).expect("create parent dir");
    std::fs::write(path, body).expect("write file");
}

fn write_provider_action_fixture(
    repo: &Path,
    prompt_name: &str,
    action_name: &str,
    provider: &str,
    prompt_content: &str,
) {
    let agent = if provider == "github_pr" {
        "claude"
    } else {
        "codex"
    };
    write_file(
        &repo.join(".pohunek/templates.toml"),
        &format!(
            r#"
[template.{prompt_name}]
agent = "{agent}"
prompt = "{prompt_name}"
base_branch = "develop"
"#
        ),
    );
    write_file(
        &repo.join(".pohunek/actions.toml"),
        &format!(
            r#"
[action.{action_name}]
template = "{prompt_name}"
provider = "{provider}"
"#
        ),
    );
    write_file(
        &repo.join(format!(".pohunek/prompts/{prompt_name}.tmpl")),
        prompt_content,
    );
}

fn expected_linear_link_metadata() -> pohunek_gui_core::SessionLinkMetadata {
    pohunek_gui_core::SessionLinkMetadata {
        provider: SessionLinkProvider::Linear,
        kind: SessionLinkKind::Issue,
        id: "LIN-123".to_owned(),
        url: "https://linear.test/LIN-123".to_owned(),
        branch: "lin-123-fix-launcher".to_owned(),
    }
}

/// Reads a file that its writer publishes by atomic rename.
///
/// `None` means the file has not been published yet. A published file is
/// complete, so a partially written file is never observable here.
fn read_published(path: &Path) -> Option<String> {
    match std::fs::read_to_string(path) {
        Ok(value) => Some(value),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => panic!("failed to read {}: {err}", path.display()),
    }
}

/// Waits until a fake agent has published `path` and returns its content.
async fn wait_for_file(path: &Path) -> String {
    wait::wait_until(&format!("{} to be published", path.display()), || async {
        read_published(path)
    })
    .await
}

/// A recorder process that is killed and reaped when dropped, including when
/// the owning test unwinds.
struct RecorderGuard(std::process::Child);

impl Drop for RecorderGuard {
    fn drop(&mut self) {
        // The child may already have exited, which makes `kill` fail; reaping
        // it is what matters.
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn spawn_recorder(script: &Path, prompt: &str) -> RecorderGuard {
    let child = scrubbed_command("/bin/sh")
        .arg(script)
        .arg(prompt)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn recorder");
    RecorderGuard(child)
}

fn make_fifo(path: &Path) {
    let status = scrubbed_command("mkfifo")
        .env("PATH", SYSTEM_PATH)
        .arg(path)
        .status()
        .expect("run mkfifo");
    assert!(status.success(), "mkfifo failed: {status}");
}

/// Opens the gate FIFO and queues the release token without blocking.
///
/// A read-write open never waits for a reader, so a recorder that died before
/// opening the FIFO cannot hang the test. The returned handle keeps the token
/// buffered and must stay alive until the recorder has consumed it.
fn release_gate(gate: &Path) -> std::fs::File {
    use std::io::Write as _;

    let mut fifo = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(gate)
        .expect("open gate FIFO");
    fifo.write_all(b"go\n").expect("queue gate release token");
    fifo
}

/// Waits for `path` like [`wait_for_file`], failing at once if `recorder` exits
/// first.
async fn wait_for_file_while_recording(path: &Path, recorder: &mut RecorderGuard) -> String {
    let what = format!("{} to be published", path.display());
    let outcome = wait::wait_until(&what, || {
        let probed = match read_published(path) {
            Some(content) => Some(Ok(content)),
            None => recorder
                .0
                .try_wait()
                .expect("poll recorder status")
                .map(Err),
        };
        std::future::ready(probed)
    })
    .await;
    outcome.unwrap_or_else(|status| {
        panic!(
            "recorder exited with {status} before publishing {}",
            path.display()
        )
    })
}

#[tokio::test]
async fn recorded_prompt_is_unobservable_until_the_writer_has_published_it() {
    let dir = temp_dir("gui-core-recorder-gate");
    let prompt_out = dir.join("prompt.txt");
    let gate = dir.join("gate.fifo");
    make_fifo(&gate);
    let script = dir.join("recorder.sh");
    std::fs::write(&script, recorder_script(&prompt_out, Some(&gate))).expect("write recorder");
    let expected = "PR 7: Fix filters\nBody text\nbranch=feature/filters\n";
    let mut recorder = spawn_recorder(&script, expected);

    // The writer has started and is held at the gate: its partial file exists
    // while the published path must not.
    let partial = prompt_out.with_extension("partial");
    assert_eq!(
        wait_for_file_while_recording(&partial, &mut recorder).await,
        ""
    );
    assert_eq!(
        read_published(&prompt_out),
        None,
        "an unfinished prompt is visible at the published path"
    );

    let _token = release_gate(&gate);
    assert_eq!(
        wait_for_file_while_recording(&prompt_out, &mut recorder).await,
        expected
    );
}

#[tokio::test]
#[should_panic(expected = "recorder exited with")]
async fn recorder_that_dies_before_opening_the_gate_fails_the_wait_without_hanging() {
    let dir = temp_dir("gui-core-recorder-dies");
    let prompt_out = dir.join("prompt.txt");
    let gate = dir.join("gate.fifo");
    make_fifo(&gate);
    let script = dir.join("recorder.sh");
    let partial = prompt_out.with_extension("partial");
    std::fs::write(
        &script,
        format!("#!/bin/sh\n: > '{}'\nexit 3\n", partial.display()),
    )
    .expect("write recorder");
    let mut recorder = spawn_recorder(&script, "unused");

    // No reader ever opens the FIFO, so a blocking open would never return.
    let _token = release_gate(&gate);
    wait_for_file_while_recording(&prompt_out, &mut recorder).await;
}

async fn report_native_id(host: &HostConfig, id: &SessionId, agent: &str, native_id: &str) {
    let session = inspect_session(host, id)
        .await
        .expect("inspect session before native identity report");
    let worker_instance_id = session
        .runtime
        .as_ref()
        .and_then(|runtime| runtime.worker_instance_id.clone())
        .expect("managed session has a runtime id");
    let process_start_identity = process_start_identity(session.pid);
    let expires_at = (time::OffsetDateTime::now_utc()
        + time::Duration::minutes(NATIVE_REPORT_EXPIRY_MINUTES))
    .format(&Rfc3339)
    .expect("format native identity report expiry");
    let params = SessionReportNativeIdParams::new(
        id.clone(),
        worker_instance_id,
        agent,
        session.pid,
        process_start_identity,
        ReportSequence::new(1),
        expires_at,
        native_id,
        None,
    )
    .expect("native identity report params are valid");
    let mut client = client(host).await;
    let request = Request::new(
        "gui-core-report-native-id",
        method::SESSION_REPORT_NATIVE_ID,
        serde_json::to_value(params).expect("serialize native id params"),
    )
    .expect("test report-native-id request is valid");
    let _ = client
        .request(&request)
        .await
        .expect("session.report_native_id");
}

fn process_start_identity(pid: u32) -> ProcessStartIdentity {
    let identity = HostInspector::new()
        .identity(pid)
        .expect("inspect managed process identity")
        .expect("managed process is live");
    ProcessStartIdentity::new(identity.start_identity.get())
}

async fn wait_for_native_id(host: &HostConfig, id: &SessionId, native_id: &str) -> SessionInfo {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let inspected = inspect_session(host, id).await.expect("inspect native id");
        if inspected.native_session_id.as_deref() == Some(native_id) {
            return inspected;
        }
        let now = tokio::time::Instant::now();
        assert!(now < deadline, "native id was not captured before deadline");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn create_agent_session(host: &HostConfig, agent: RuntimeRef, cwd: PathBuf) -> SessionInfo {
    let mut client = client(host).await;
    let request = Request::new(
        "gui-core-session-new",
        method::SESSION_NEW,
        serde_json::to_value(SessionNewParams {
            agent: agent_name(&agent).to_owned(),
            name: None,
            cwd: Some(cwd),
            cols: 80,
            rows: 24,
            project: None,
            repo: None,
            branch: None,
            base_branch: None,
            input: None,
            extended_input_ready_wait: None,
            metadata: std::collections::BTreeMap::new(),
        })
        .expect("serialize session.new params"),
    )
    .expect("test session-new request is valid");
    serde_json::from_value(client.request(&request).await.expect("session.new"))
        .expect("session info")
}

async fn stop_session(host: &HostConfig, id: &SessionId) {
    let mut client = client(host).await;
    let request = Request::new(
        "gui-core-session-stop",
        method::SESSION_STOP,
        serde_json::to_value(id).expect("serialize session id"),
    )
    .expect("test session-stop request is valid");
    let _ = client.request(&request).await.expect("session.stop");
}

async fn client(host: &HostConfig) -> Client {
    match host.transport {
        pohunek_gui_core::HostTransport::Tcp { addr, .. } => {
            Client::connect_trusted_tcp_addr_with_options(
                host.id.as_str(),
                addr,
                ClientOptions::default().with_origin_source(OriginSource::Omitted),
            )
            .await
            .expect("connect tcp")
        }
        pohunek_gui_core::HostTransport::Local { ref socket_path } => {
            Client::connect_local_with_options(
                socket_path,
                ClientOptions::default().with_origin_source(OriginSource::Omitted),
            )
            .await
            .expect("connect local")
        }
        pohunek_gui_core::HostTransport::Remote { .. } => {
            panic!("loopback harness expects direct hosts")
        }
    }
}

async fn wait_for_agent_state<S>(events: &mut S, id: &SessionId) -> AgentStateEvent
where
    S: futures::Stream<Item = DomainEvent> + Unpin,
{
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let now = tokio::time::Instant::now();
        assert!(now < deadline, "agent_state event timed out");
        let message = tokio::time::timeout(deadline - now, events.next())
            .await
            .expect("event before deadline")
            .expect("subscription message");
        if let DomainEvent::HostEvent {
            event: HostEvent::AgentState(state),
            ..
        } = message
        {
            if state.session_id == *id {
                return state;
            }
        }
    }
}

fn agent_name(agent: &RuntimeRef) -> &str {
    agent.as_wire()
}

thread_local! {
    /// The hermetic environment of the current test thread: one private root
    /// holding every fixture directory, removed when the thread ends, after the
    /// test body has finished.
    static TEST_ENV: TestEnv = TestEnv::new().expect("create the hermetic test environment");
    /// Numbers the fixture directories of the current test thread.
    static NEXT_FIXTURE: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

/// Creates an owner-private directory below the test thread's private root.
///
/// Keep `prefix` short: it counts against the socket path limit of anything
/// bound beneath the directory.
fn fixture_dir(prefix: &str) -> PathBuf {
    let number = NEXT_FIXTURE.with(|next| {
        let number = next.get();
        next.set(number + 1);
        number
    });
    let path = TEST_ENV.with(|env| env.root().join(format!("{prefix}{number}")));
    std::fs::create_dir(&path).expect("create private fixture directory");
    make_owner_private(&path);
    path
}

/// Returns a command for `program` with the test thread's scrubbed environment
/// and private working directory.
fn scrubbed_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    TEST_ENV.with(|env| env.command(program))
}

/// `PATH` of helper tools started by the fixtures: the system directories on
/// Linux and macOS, never the developer's toolchain directories.
const SYSTEM_PATH: &str = "/usr/bin:/bin";

fn temp_dir(tag: &str) -> PathBuf {
    fixture_dir(&format!("pgc-{tag}-"))
}

#[cfg(unix)]
fn make_owner_private(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = std::fs::metadata(dir)
        .expect("governance test directory metadata")
        .permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(dir, permissions)
        .expect("make governance test directory owner-private");
}

#[cfg(not(unix))]
fn make_owner_private(_dir: &Path) {}

/// Builds an agent script that publishes the `HOME` and `SSH_AUTH_SOCK` it
/// received to `env_out` (via a sibling `.partial` file renamed into place).
fn environment_recorder_script(env_out: &Path) -> String {
    let quote = |path: &Path| {
        path.to_str()
            .expect("UTF-8 script path")
            .replace('\'', "'\\''")
    };
    let target = quote(env_out);
    let partial = quote(&env_out.with_extension("partial"));
    format!(
        "#!/bin/sh\n{{ printf 'HOME=%s\\n' \"${{HOME-<unset>}}\"; printf 'SSH_AUTH_SOCK=%s\\n' \"${{SSH_AUTH_SOCK-<unset>}}\"; }} > '{partial}' && /bin/mv '{partial}' '{target}'\nexec /bin/sleep 30\n"
    )
}

/// Returns a fake `codex` that records its first argument in `prompt_out`.
///
/// The path is embedded in the script because a session's agent receives only
/// the allowlisted base environment, never arbitrary daemon variables.
fn recording_script(prompt_out: &Path) -> String {
    recorder_script(prompt_out, None)
}

/// Builds the recording script, optionally blocked on `gate` mid-publication.
///
/// The prompt is written to a sibling `.partial` file and renamed into place,
/// so `prompt_out` appears only once it is complete. With a `gate` FIFO the
/// script creates the partial file, then blocks until the test writes to the
/// FIFO, which lets a test hold the writer between "started" and "published".
fn recorder_script(prompt_out: &Path, gate: Option<&Path>) -> String {
    let quote = |path: &Path| {
        path.to_str()
            .expect("UTF-8 script path")
            .replace('\'', "'\\''")
    };
    let target = quote(prompt_out);
    let partial = quote(&prompt_out.with_extension("partial"));
    let gate_step = gate
        .map(|gate| format!("read -r _ < '{}'\n", quote(gate)))
        .unwrap_or_default();
    format!(
        "#!/bin/sh\n: > '{partial}'\n{gate_step}printf '%s' \"${{1:-}}\" > '{partial}' && /bin/mv '{partial}' '{target}'\nexec /bin/sleep 30\n"
    )
}

fn write_executable(path: &Path, body: &str) {
    std::fs::write(path, body).expect("write executable");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mut permissions = std::fs::metadata(path)
            .expect("executable metadata")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions).expect("chmod executable");
    }
}

/// Puts `dir` ahead of the current `PATH` until `env` drops.
fn prepend_path(env: &mut ProcessEnv, dir: &Path) {
    let mut paths = vec![dir.to_path_buf()];
    if let Some(current) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&current));
    }
    env.set("PATH", std::env::join_paths(paths).expect("join PATH"));
}
