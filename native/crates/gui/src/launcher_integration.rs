//! Headless integration scenarios for the dialog-only GUI process.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs::{self, File, FileTimes};
use std::os::unix::fs::PermissionsExt as _;
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::time::{Duration, Instant, SystemTime};

use futures::StreamExt as _;
use iced::advanced::widget::operation::Operation;
use iced::advanced::widget::Tree;
use iced::advanced::{layout, Layout};
use iced::Size;
use iced_runtime::{task::into_stream, Action};
use pohunek_client::{Client, ClientOptions, OriginSource};
use pohunek_gui_core::{
    create_session, inspect_session, load_host_snapshot, remove_session, stop_session, CoreError,
    DomainEvent, HostConfig, Selection, UiState, WindowSize,
};
use pohunek_platform::process::{HostInspector, ProcessInspector};
use pohunek_test_support::env::TestEnv;
use pohunek_test_support::process_env::ProcessEnv;
use pohunek_test_support::wait;
use protocol::{
    method, ProcessStartIdentity, ReportSequence, Request, SessionId, SessionNewParams,
    SessionReportNativeIdParams,
};
use time::format_description::well_known::Rfc3339;

use crate::config::{AppConfig, ConfigError};
use crate::message::{AppMode, LaunchPhase, Message, ModalView, RecoveryAction};
use crate::{command, parse_args, view, BootState, HostId, PohunekApp};

const STATE_CHILD_ENV: &str = "POHUNEK_GUI_LAUNCHER_STATE_CHILD";
const STATE_CHILD_MARKER_ENV: &str = "POHUNEK_GUI_LAUNCHER_STATE_MARKER";
const DAEMON_DROP_EXIT_TIMEOUT: Duration = Duration::from_secs(5);
const NATIVE_REPORT_EXPIRY_MINUTES: i64 = 1;

#[test]
fn launcher_interactions_preserve_the_main_window_state_file() {
    if std::env::var_os(STATE_CHILD_ENV).is_some() {
        run_launcher_state_child();
        return;
    }

    let env = TestEnv::new().expect("private process environment");
    let state_dir = env.state_home().join("pohunek-gui");
    let saved = UiState {
        window_size: WindowSize {
            width: 1227,
            height: 819,
        },
        selection: Some(Selection::Session {
            host_id: HostId::new("main-window"),
            session_id: SessionId("session-main".to_owned()),
        }),
    };
    saved
        .save_to_dir(&state_dir)
        .expect("write main window state");
    let state_path = state_dir.join("ui-state.toml");
    let original = fs::read(&state_path).expect("read saved state");
    let marker = env.root().join("dialog-complete");

    let child = std::process::Command::new(std::env::current_exe().expect("test executable"))
        .args([
            "--exact",
            "launcher_integration::launcher_interactions_preserve_the_main_window_state_file",
            "--nocapture",
        ])
        .env(STATE_CHILD_ENV, "1")
        .env(STATE_CHILD_MARKER_ENV, &marker)
        .env("HOME", env.home())
        .env("XDG_CONFIG_HOME", env.config_home())
        .env("XDG_RUNTIME_DIR", env.runtime_dir())
        .env("XDG_STATE_HOME", env.state_home())
        .output()
        .expect("start dialog-only test process");
    assert!(
        child.status.success(),
        "dialog-only process failed: stdout={} stderr={}",
        String::from_utf8_lossy(&child.stdout),
        String::from_utf8_lossy(&child.stderr)
    );
    assert_eq!(fs::read(&marker).expect("dialog process ran"), b"complete");
    assert_eq!(
        fs::read(&state_path).expect("read state after dialog"),
        original
    );
}

fn run_launcher_state_child() {
    let mode = parse_args([OsString::from("--new-session")]).expect("dialog flag");
    assert_eq!(mode, AppMode::NewSession);
    let boot = BootState::load(mode);
    let saved = boot.ui_state.clone();
    let (mut app, _) = PohunekApp::boot(boot, mode);
    assert_eq!(app.ui_state.selection, saved.selection);

    let save = command::update(&mut app, Message::WindowResized(Size::new(700.0, 760.0)));
    assert_eq!(
        save.units(),
        0,
        "dialog resize cannot schedule a state write"
    );
    assert_ne!(app.ui_state.window_size, saved.window_size);
    let marker = std::env::var_os(STATE_CHILD_MARKER_ENV).expect("child marker path");
    fs::write(marker, b"complete").expect("mark dialog interaction complete");
}

#[tokio::test(flavor = "current_thread")]
#[expect(
    clippy::too_many_lines,
    reason = "the scenario crosses private process setup, daemon transport, GUI updates, and cleanup"
)]
async fn launcher_retries_failures_and_confirms_native_recovery() {
    let mut process_env = ProcessEnv::lock();
    process_env
        .remove("POHUNEK_SESSION_ID")
        .remove("POHUNEK_DAEMON_ID");
    let env = TestEnv::new().expect("private process environment");
    process_env
        .set("HOME", env.home())
        .set("XDG_CONFIG_HOME", env.config_home())
        .set("XDG_RUNTIME_DIR", env.runtime_dir())
        .set("XDG_STATE_HOME", env.state_home());

    let agent_dir = env.root().join("agents");
    fs::create_dir(&agent_dir).expect("agent directory");
    let agent = agent_dir.join("codex");
    fs::write(&agent, "#!/bin/sh\n/bin/sleep 30\n").expect("write agent fixture");
    fs::set_permissions(&agent, fs::Permissions::from_mode(0o755)).expect("agent executable");
    let claude = agent_dir.join("claude");
    fs::write(&claude, "#!/bin/sh\n/bin/sleep 30\n").expect("write Claude fixture");
    fs::set_permissions(&claude, fs::Permissions::from_mode(0o755)).expect("Claude executable");
    let search_path = format!(
        "{}:{}",
        agent_dir.display(),
        std::env::var("PATH").expect("test PATH")
    );

    let cli = required_binary("POHUNEK_CLI_BIN");
    let gui_config = env.config_home().join("pohunek/gui.toml");
    let config_dir = gui_config.parent().expect("config directory");
    fs::create_dir(config_dir).expect("create config directory");
    fs::set_permissions(config_dir, fs::Permissions::from_mode(0o700))
        .expect("private config directory");
    let config_text = format!(
        "pohunek_bin = {}\nattach_command = \"/bin/false {{bin}} --host={{host}} attach {{id}}\"\nattach_command_mode = \"argv\"\n",
        toml::Value::String(cli.to_string_lossy().into_owned())
    );
    fs::write(&gui_config, &config_text).expect("write GUI configuration");
    assert_eq!(
        AppConfig::load()
            .expect("load default GUI configuration")
            .connection_options
            .request_timeout,
        None
    );
    fs::write(
        &gui_config,
        format!("{config_text}\n[gui]\nrequest_timeout_ms = 5000\n"),
    )
    .expect("write explicit timeout");
    assert_eq!(
        AppConfig::load()
            .expect("load explicit GUI timeout")
            .connection_options
            .request_timeout,
        Some(Duration::from_secs(5))
    );
    fs::write(
        &gui_config,
        format!("{config_text}\n[gui]\nrequest_timeout_ms = 0\n"),
    )
    .expect("write zero timeout");
    assert!(matches!(
        AppConfig::load(),
        Err(ConfigError::Invalid {
            field: "gui.request_timeout_ms",
            ..
        })
    ));
    fs::write(&gui_config, &config_text).expect("restore GUI configuration");

    let repo = env.cwd().join("project");
    fs::create_dir(&repo).expect("project directory");
    let git = std::process::Command::new("git")
        .args(["init", "-q"])
        .arg(&repo)
        .output()
        .expect("initialize project");
    assert!(
        git.status.success(),
        "git init: {}",
        String::from_utf8_lossy(&git.stderr)
    );

    let socket = pohunek_paths::socket_path().expect("private daemon socket path");
    let mut daemon = Daemon::spawn(&env, &search_path);
    wait::wait_until("daemon socket", || {
        let socket = socket.clone();
        async move { tokio::net::UnixStream::connect(&socket).await.ok() }
    })
    .await;

    let added = env
        .command(&cli)
        .args(["project", "add", "--json"])
        .arg(&repo)
        .output()
        .expect("register project");
    assert!(
        added.status.success(),
        "project add: {}",
        String::from_utf8_lossy(&added.stderr)
    );

    let host = HostConfig::local("local", &socket);
    let snapshot = load_host_snapshot(&host)
        .await
        .expect("real daemon snapshot");
    let (mut app, _) = PohunekApp::boot(BootState::load(AppMode::NewSession), AppMode::NewSession);
    assert!(
        app.config.is_ok(),
        "GUI configuration: {:?}",
        app.config.as_ref().err()
    );
    app.hosts = vec![host.clone()];
    let _ = command::update(
        &mut app,
        Message::Core(DomainEvent::HostSnapshotLoaded { snapshot }),
    );
    app.start.project = Some(
        app.workspace
            .project_choices()
            .first()
            .expect("registered project is visible")
            .project
            .clone(),
    );
    app.start.agent = "codex".to_owned();
    assert!(
        app.workspace
            .hosts
            .get(&host.id)
            .expect("host view")
            .agent_is_launchable("codex"),
        "fixture agent must be launchable"
    );

    app.hosts[0] = HostConfig::local("local", env.runtime_dir().join("missing.sock"));
    let failed = command::update(&mut app, Message::CreateSession);
    assert_eq!(app.launcher.phase, LaunchPhase::Launching);
    for message in outputs(failed).await {
        let _ = command::update(&mut app, message);
    }
    assert_eq!(app.launcher.phase, LaunchPhase::Idle);
    assert!(app
        .status
        .as_deref()
        .is_some_and(|status| !status.is_empty()));
    assert!(load_host_snapshot(&host)
        .await
        .expect("daemon snapshot")
        .sessions
        .is_empty());

    app.hosts[0] = host.clone();
    let create = command::update(&mut app, Message::CreateSession);
    assert_eq!(app.launcher.phase, LaunchPhase::Launching);
    assert_eq!(
        command::update(&mut app, Message::CreateSession).units(),
        0,
        "second submit cannot schedule another session"
    );
    let mut attachment = None;
    for message in outputs(create).await {
        assert!(
            matches!(&message, Message::CoreCommandCompleted(Ok(_))),
            "{message:?}"
        );
        attachment = Some(command::update(&mut app, message));
    }
    let created = load_host_snapshot(&host)
        .await
        .expect("created session visible");
    assert_eq!(created.sessions.len(), 1);
    let attachment = attachment.expect("one create completion");
    let responses = outputs(attachment).await;
    assert!(responses
        .iter()
        .any(|message| matches!(message, Message::AttachSpawned(Err(_)))));
    for message in responses {
        let _ = command::update(&mut app, message);
    }
    assert_eq!(app.launcher.phase, LaunchPhase::Created);
    assert_eq!(command::update(&mut app, Message::CreateSession).units(), 0);
    assert_eq!(
        load_host_snapshot(&host)
            .await
            .expect("final snapshot")
            .sessions
            .len(),
        1
    );

    app.mode = AppMode::Full;

    stop_session(&host, &created.sessions[0].id)
        .await
        .expect("stop fixture session");
    let stopped = load_host_snapshot(&host)
        .await
        .expect("stopped session snapshot");
    assert!(stopped.sessions[0].state.is_terminal());
    assert!(stopped.sessions[0].capabilities.resume);
    assert!(stopped.sessions[0].native_session_id.is_none());
    let session_id = stopped.sessions[0].id.clone();
    let _ = command::update(
        &mut app,
        Message::Core(DomainEvent::HostSnapshotLoaded { snapshot: stopped }),
    );
    app.workspace
        .hosts
        .get_mut(&host.id)
        .expect("host view")
        .sessions
        .get_mut(&session_id.0)
        .expect("stopped session")
        .native_session_id = Some("stale-native-id".to_owned());
    app.modal = ModalView::Session;
    let configured_hosts = std::mem::take(&mut app.hosts);
    let unavailable = command::update(
        &mut app,
        Message::OpenSession {
            host_id: host.id.clone(),
            session_id: session_id.clone(),
        },
    );
    assert_eq!(unavailable.units(), 0);
    assert!(modal_text(&app)
        .iter()
        .any(|text| text.contains("unknown host")));
    app.hosts = configured_hosts;
    let opening = command::update(
        &mut app,
        Message::OpenSession {
            host_id: host.id.clone(),
            session_id: session_id.clone(),
        },
    );
    assert_eq!(app.recovery_pending, Some(app.recovery_generation));
    assert!(app.recovery_confirmation.is_none());
    let inspected = outputs(opening).await;
    assert!(inspected
        .iter()
        .all(|message| matches!(message, Message::RecoveryInspected { .. })));
    for message in inspected {
        let _ = command::update(&mut app, message);
    }
    assert!(app.recovery_confirmation.is_none());
    assert!(app
        .status
        .as_deref()
        .is_some_and(|status| status.contains("native recovery target")));
    assert!(modal_text(&app)
        .iter()
        .any(|text| text.contains("native recovery target")));
    assert!(load_host_snapshot(&host)
        .await
        .expect("session remained stopped")
        .sessions[0]
        .state
        .is_terminal());
    app.workspace
        .select_session(host.id.clone(), session_id.clone());
    app.ui_state.selection = Some(Selection::Session {
        host_id: host.id.clone(),
        session_id: session_id.clone(),
    });
    let configured_hosts = std::mem::take(&mut app.hosts);
    let unavailable = command::update(&mut app, Message::ForkSelectedSession);
    assert_eq!(unavailable.units(), 0);
    assert!(modal_text(&app)
        .iter()
        .any(|text| text.contains("unknown host")));
    app.hosts = configured_hosts;
    let fork = command::update(&mut app, Message::ForkSelectedSession);
    assert_eq!(app.recovery_pending, Some(app.recovery_generation));
    let fork_inspected = outputs(fork).await;
    assert!(fork_inspected.iter().all(|message| matches!(
        message,
        Message::RecoveryInspected {
            action: RecoveryAction::Fork,
            ..
        }
    )));
    for message in fork_inspected {
        let _ = command::update(&mut app, message);
    }
    assert!(app.recovery_confirmation.is_none());
    let fork_notice = app.recovery_notice.as_deref().expect("fork refusal");
    assert!(modal_text(&app)
        .iter()
        .any(|text| text.contains(fork_notice)));

    remove_session(&host, &session_id)
        .await
        .expect("remove stopped fixture session");
    let missing = inspect_session(&host, &session_id)
        .await
        .expect_err("removed session must refuse inspection");
    let code = match missing {
        CoreError::Client(error) => error.to_protocol_error().code,
        CoreError::Protocol(error) => error.code,
        error => panic!("expected typed daemon refusal: {error}"),
    };
    let opening = command::update(
        &mut app,
        Message::OpenSession {
            host_id: host.id.clone(),
            session_id: session_id.clone(),
        },
    );
    for message in outputs(opening).await {
        let _ = command::update(&mut app, message);
    }
    assert_eq!(app.modal, ModalView::Session);
    assert!(modal_text(&app).iter().any(|text| text.contains(&code)));

    let claude_session = create_session(
        &host,
        SessionNewParams {
            agent: "claude".to_owned(),
            name: None,
            cwd: Some(repo),
            cols: 80,
            rows: 24,
            project: None,
            repo: None,
            branch: None,
            base_branch: None,
            input: None,
            metadata: BTreeMap::default(),
        },
    )
    .await
    .expect("create real Claude session");
    let claude_id = claude_session.session.id;
    let transcript_dir = env.home().join(".claude/projects/fixture");
    fs::create_dir_all(&transcript_dir).expect("Claude transcript directory");
    let first_transcript = transcript_dir.join("native-first.jsonl");
    write_transcript(&first_transcript, 1_700_000_000);
    report_native_id(&host, &claude_id, "native-first", 1).await;
    let first = inspect_session(&host, &claude_id)
        .await
        .expect("inspect first reported native target");
    assert_eq!(first.native_session_id.as_deref(), Some("native-first"));
    assert!(first.native_last_activity_at.is_some());
    let snapshot = load_host_snapshot(&host)
        .await
        .expect("snapshot with reported native target");
    let _ = command::update(
        &mut app,
        Message::Core(DomainEvent::HostSnapshotLoaded { snapshot }),
    );
    app.workspace
        .select_session(host.id.clone(), claude_id.clone());
    app.ui_state.selection = Some(Selection::Session {
        host_id: host.id.clone(),
        session_id: claude_id.clone(),
    });

    for (description, invalid_id, invalid_path) in [
        ("empty id with path", true, false),
        ("id with empty path", false, true),
    ] {
        let mut malformed = first.clone();
        if invalid_id {
            malformed.native_session_id = Some(String::new());
            malformed.native_session_path = Some("/valid/conversation".to_owned());
        }
        if invalid_path {
            malformed.native_session_path = Some(String::new());
        }

        let initial = command::update(&mut app, Message::ForkSelectedSession);
        assert_eq!(initial.units(), 1, "{description}: inspect was requested");
        let generation = app.recovery_generation;
        let refused = command::update(
            &mut app,
            Message::RecoveryInspected {
                generation,
                host_id: host.id.clone(),
                session_id: claude_id.clone(),
                action: RecoveryAction::Fork,
                result: Ok(malformed.clone()),
            },
        );
        assert_eq!(refused.units(), 0, "{description}: no fork task");
        assert!(app.recovery_confirmation.is_none(), "{description}");
        assert_eq!(app.modal, ModalView::Session, "{description}");
        assert!(modal_text(&app)
            .iter()
            .any(|text| text.contains("exactly one native recovery target")));

        let initial = command::update(&mut app, Message::ForkSelectedSession);
        assert_eq!(initial.units(), 1, "{description}: inspect was requested");
        let generation = app.recovery_generation;
        let accepted = command::update(
            &mut app,
            Message::RecoveryInspected {
                generation,
                host_id: host.id.clone(),
                session_id: claude_id.clone(),
                action: RecoveryAction::Fork,
                result: Ok(first.clone()),
            },
        );
        assert_eq!(accepted.units(), 0, "{description}: confirmation only");
        let expected = app
            .recovery_confirmation
            .as_ref()
            .expect("valid target was shown")
            .clone();
        let verifying = command::update(&mut app, Message::ConfirmRecovery);
        assert_eq!(
            verifying.units(),
            1,
            "{description}: reinspection was requested"
        );
        let generation = app.recovery_generation;
        let refused = command::update(
            &mut app,
            Message::RecoveryReinspected {
                generation,
                expected,
                result: Ok(malformed),
            },
        );
        assert_eq!(refused.units(), 0, "{description}: no fork task");
        assert!(app.recovery_confirmation.is_none(), "{description}");
        assert_eq!(app.modal, ModalView::Session, "{description}");
        assert_eq!(
            load_host_snapshot(&host)
                .await
                .expect("malformed target did not create a worker")
                .sessions
                .len(),
            1,
            "{description}"
        );
    }

    let fork = command::update(&mut app, Message::ForkSelectedSession);
    for message in outputs(fork).await {
        assert!(matches!(
            message,
            Message::RecoveryInspected {
                action: RecoveryAction::Fork,
                ..
            }
        ));
        let _ = command::update(&mut app, message);
    }
    assert_eq!(app.modal, ModalView::ConfirmRecovery);
    let confirmation = app
        .recovery_confirmation
        .as_ref()
        .expect("first confirmation");
    assert_eq!(confirmation.target, "native_session_id: native-first");
    assert_eq!(
        confirmation.native_last_activity_at,
        first.native_last_activity_at
    );

    let second_transcript = transcript_dir.join("native-second.jsonl");
    write_transcript(&second_transcript, 1_700_000_060);
    report_native_id(&host, &claude_id, "native-second", 2).await;
    let second = inspect_session(&host, &claude_id)
        .await
        .expect("inspect changed native target");
    assert_eq!(second.native_session_id.as_deref(), Some("native-second"));
    assert_ne!(
        second.native_last_activity_at,
        first.native_last_activity_at
    );
    let verifying = command::update(&mut app, Message::ConfirmRecovery);
    assert_eq!(verifying.units(), 1, "confirm schedules a second inspect");
    assert!(app.recovery_confirmation.is_none());
    for message in outputs(verifying).await {
        assert!(matches!(message, Message::RecoveryReinspected { .. }));
        assert_eq!(command::update(&mut app, message).units(), 0);
    }
    let confirmation = app.recovery_confirmation.as_ref().expect("updated target");
    assert_eq!(confirmation.target, "native_session_id: native-second");
    assert_eq!(
        confirmation.native_last_activity_at,
        second.native_last_activity_at
    );
    assert!(app
        .status
        .as_deref()
        .is_some_and(|status| status.contains("confirm the updated details again")));
    assert!(modal_text(&app)
        .iter()
        .any(|text| text.contains("confirm the updated details again")));
    assert_eq!(
        load_host_snapshot(&host)
            .await
            .expect("no fork yet")
            .sessions
            .len(),
        1
    );

    write_transcript(&second_transcript, 1_700_000_120);
    let activity = inspect_session(&host, &claude_id)
        .await
        .expect("inspect changed native activity");
    assert_ne!(
        activity.native_last_activity_at,
        second.native_last_activity_at
    );
    let verifying = command::update(&mut app, Message::ConfirmRecovery);
    assert!(app.recovery_notice.is_none());
    for message in outputs(verifying).await {
        assert!(matches!(message, Message::RecoveryReinspected { .. }));
        assert_eq!(command::update(&mut app, message).units(), 0);
    }
    let confirmation = app
        .recovery_confirmation
        .as_ref()
        .expect("updated activity");
    assert_eq!(confirmation.target, "native_session_id: native-second");
    assert_eq!(
        confirmation.native_last_activity_at,
        activity.native_last_activity_at
    );
    assert_eq!(
        load_host_snapshot(&host)
            .await
            .expect("no fork yet")
            .sessions
            .len(),
        1
    );

    let _ = command::update(&mut app, Message::CloseModal);
    assert!(app.recovery_confirmation.is_none());
    assert!(app.recovery_notice.is_none());
    assert_eq!(
        command::update(&mut app, Message::ConfirmRecovery).units(),
        0
    );
    let fork = command::update(&mut app, Message::ForkSelectedSession);
    for message in outputs(fork).await {
        let _ = command::update(&mut app, message);
    }
    assert_eq!(app.modal, ModalView::ConfirmRecovery);
    assert_eq!(
        app.recovery_confirmation
            .as_ref()
            .expect("current confirmation")
            .native_last_activity_at,
        activity.native_last_activity_at
    );
    let verifying = command::update(&mut app, Message::ConfirmRecovery);
    let mut launched = None;
    for message in outputs(verifying).await {
        assert!(matches!(message, Message::RecoveryReinspected { .. }));
        launched = Some(command::update(&mut app, message));
    }
    let launched = launched.expect("matching inspection");
    assert_eq!(launched.units(), 1, "matching target dispatches fork");
    assert!(app.recovery_confirmation.is_none());
    for message in outputs(launched).await {
        assert!(
            matches!(message, Message::CoreCommandCompleted(Ok(_))),
            "{message:?}"
        );
    }
    assert_eq!(
        load_host_snapshot(&host)
            .await
            .expect("forked session")
            .sessions
            .len(),
        2
    );

    stop_session(&host, &claude_id)
        .await
        .expect("stop Claude session for resume");
    let snapshot = load_host_snapshot(&host)
        .await
        .expect("stopped Claude snapshot");
    let _ = command::update(
        &mut app,
        Message::Core(DomainEvent::HostSnapshotLoaded { snapshot }),
    );
    let opening = command::update(
        &mut app,
        Message::OpenSession {
            host_id: host.id.clone(),
            session_id: claude_id.clone(),
        },
    );
    for message in outputs(opening).await {
        let _ = command::update(&mut app, message);
    }
    assert_eq!(app.modal, ModalView::ConfirmRecovery);
    assert_eq!(
        app.recovery_confirmation
            .as_ref()
            .expect("resume confirmation")
            .target,
        "native_session_id: native-second"
    );
    let verifying = command::update(&mut app, Message::ConfirmRecovery);
    let mut resuming = None;
    for message in outputs(verifying).await {
        assert!(matches!(message, Message::RecoveryReinspected { .. }));
        resuming = Some(command::update(&mut app, message));
    }
    let resuming = resuming.expect("matching resume inspection");
    assert_eq!(resuming.units(), 1, "matching target dispatches resume");
    for message in outputs(resuming).await {
        assert!(
            matches!(message, Message::CoreCommandCompleted(Ok(_))),
            "{message:?}"
        );
    }
    assert_eq!(
        inspect_session(&host, &claude_id)
            .await
            .expect("resumed Claude session")
            .state,
        protocol::SessionState::Running
    );

    stop_session(&host, &claude_id)
        .await
        .expect("stop Claude session for reinspection refusal");
    let snapshot = load_host_snapshot(&host)
        .await
        .expect("stopped Claude snapshot for reinspection refusal");
    let _ = command::update(
        &mut app,
        Message::Core(DomainEvent::HostSnapshotLoaded { snapshot }),
    );
    let opening = command::update(
        &mut app,
        Message::OpenSession {
            host_id: host.id.clone(),
            session_id: claude_id.clone(),
        },
    );
    for message in outputs(opening).await {
        let _ = command::update(&mut app, message);
    }
    assert_eq!(app.modal, ModalView::ConfirmRecovery);
    remove_session(&host, &claude_id)
        .await
        .expect("remove Claude session before reinspection");
    let verifying = command::update(&mut app, Message::ConfirmRecovery);
    for message in outputs(verifying).await {
        assert!(matches!(
            message,
            Message::RecoveryReinspected { result: Err(_), .. }
        ));
        assert_eq!(command::update(&mut app, message).units(), 0);
    }
    assert_eq!(app.modal, ModalView::Session);
    assert!(modal_text(&app).iter().any(|text| text.contains(&code)));
    daemon.stop();
}

fn write_transcript(path: &PathBuf, modified_at: u64) {
    fs::write(path, "{}\n").expect("write Claude transcript");
    File::options()
        .write(true)
        .open(path)
        .expect("open Claude transcript")
        .set_times(
            FileTimes::new()
                .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(modified_at)),
        )
        .expect("set Claude transcript activity");
}

async fn report_native_id(host: &HostConfig, id: &SessionId, native_id: &str, sequence: u64) {
    let session = inspect_session(host, id)
        .await
        .expect("inspect session before native identity report");
    let worker_instance_id = session
        .runtime
        .as_ref()
        .and_then(|runtime| runtime.worker_instance_id.clone())
        .expect("managed session has a runtime id");
    let process_start_identity = HostInspector::new()
        .identity(session.pid)
        .expect("inspect managed process identity")
        .expect("managed process is live");
    let expires_at = (time::OffsetDateTime::now_utc()
        + time::Duration::minutes(NATIVE_REPORT_EXPIRY_MINUTES))
    .format(&Rfc3339)
    .expect("format native identity report expiry");
    let params = SessionReportNativeIdParams::new(
        id.clone(),
        worker_instance_id,
        "claude",
        session.pid,
        ProcessStartIdentity::new(process_start_identity.start_identity.get()),
        ReportSequence::new(sequence),
        expires_at,
        native_id,
        None,
    )
    .expect("native identity report params are valid");
    let pohunek_gui_core::HostTransport::Local { socket_path } = &host.transport else {
        panic!("launcher integration uses a local daemon");
    };
    let mut client = Client::connect_local_with_options(
        socket_path,
        ClientOptions::default().with_origin_source(OriginSource::Omitted),
    )
    .await
    .expect("connect to fixture daemon");
    let request = Request::new(
        "gui-report-native-id",
        method::SESSION_REPORT_NATIVE_ID,
        serde_json::to_value(params).expect("serialize native identity report"),
    )
    .expect("native identity report request is valid");
    let reported: protocol::SessionReportNativeIdResult = serde_json::from_value(
        client
            .request(&request)
            .await
            .expect("session.report_native_id"),
    )
    .expect("decode native identity report result");
    assert!(reported.recorded, "daemon must record the native identity");
}

#[derive(Default)]
struct ModalText {
    values: Vec<String>,
}

impl Operation for ModalText {
    fn traverse(&mut self, operate: &mut dyn FnMut(&mut dyn Operation)) {
        operate(self);
    }

    fn text(
        &mut self,
        _id: Option<&iced::advanced::widget::Id>,
        _bounds: iced::Rectangle,
        value: &str,
    ) {
        self.values.push(value.to_owned());
    }
}

fn modal_text(app: &PohunekApp) -> Vec<String> {
    let mut content = match app.modal {
        ModalView::Session => view::session::session_modal_content(app),
        ModalView::ConfirmRecovery => view::session::confirm_recovery_modal_content(app),
        modal => panic!("expected recovery modal, got {modal:?}"),
    };
    let renderer = iced_renderer::fallback::Renderer::Secondary(iced_tiny_skia::Renderer::new(
        iced::Font::DEFAULT,
        iced::Pixels(16.0),
    ));
    let mut tree = Tree::new(content.as_widget());
    let node = content.as_widget_mut().layout(
        &mut tree,
        &renderer,
        &layout::Limits::new(Size::ZERO, Size::new(800.0, 800.0)),
    );
    let mut operation = ModalText::default();
    content
        .as_widget_mut()
        .operate(&mut tree, Layout::new(&node), &renderer, &mut operation);
    operation.values
}

async fn outputs(task: iced::Task<Message>) -> Vec<Message> {
    let mut output = Vec::new();
    if let Some(mut stream) = into_stream(task) {
        while let Some(action) = stream.next().await {
            if let Action::Output(message) = action {
                output.push(message);
            }
        }
    }
    output
}

fn required_binary(name: &str) -> PathBuf {
    let path =
        PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("{name} must be set")));
    assert!(
        path.is_absolute() && path.is_file(),
        "{name} must name an absolute binary"
    );
    path
}

struct Daemon(Option<Child>);

impl Daemon {
    fn spawn(env: &TestEnv, search_path: &str) -> Self {
        let child = env
            .command(required_binary("POHUNEK_DAEMON_BIN"))
            .env("POHUNEK_WORKER_LAUNCHER", "subprocess")
            .env("POHUNEK_WORKER_BIN", required_binary("POHUNEK_WORKER_BIN"))
            .env("SHELL", "/bin/sh")
            .env("PATH", search_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .spawn()
            .expect("spawn pinned daemon");
        Self(Some(child))
    }

    fn stop(&mut self) {
        let mut child = self.0.take().expect("daemon running");
        let inspector = HostInspector::new();
        let hierarchy = inspector.descendants(child.id()).unwrap_or_else(|error| {
            eprintln!("cannot list the daemon process tree: {error}");
            Vec::new()
        });
        if let Some(pid) = i32::try_from(child.id())
            .ok()
            .and_then(rustix::process::Pid::from_raw)
        {
            let _ = rustix::process::kill_process(pid, rustix::process::Signal::TERM);
        }
        let deadline = Instant::now() + DAEMON_DROP_EXIT_TIMEOUT;
        while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
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

impl Drop for Daemon {
    fn drop(&mut self) {
        if self.0.is_some() {
            self.stop();
        }
    }
}
