//! Headless integration scenarios for the dialog-only GUI process.

use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::PermissionsExt as _;
use std::path::PathBuf;
use std::process::{Child, Stdio};

use futures::StreamExt as _;
use iced::Size;
use iced_runtime::{task::into_stream, Action};
use pohunek_gui_core::{
    load_host_snapshot, stop_session, DomainEvent, HostConfig, Selection, UiState, WindowSize,
};
use pohunek_test_support::env::TestEnv;
use pohunek_test_support::process_env::ProcessEnv;
use pohunek_test_support::wait;
use protocol::SessionId;

use crate::message::{AppMode, LaunchPhase, Message};
use crate::{command, parse_args, BootState, HostId, PohunekApp};

const STATE_CHILD_ENV: &str = "POHUNEK_GUI_LAUNCHER_STATE_CHILD";
const STATE_CHILD_MARKER_ENV: &str = "POHUNEK_GUI_LAUNCHER_STATE_MARKER";

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
async fn launcher_retries_daemon_failure_once_and_locks_after_attach_failure() {
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
    fs::write(
        &gui_config,
        format!(
            "pohunek_bin = {}\nattach_command = \"/bin/false {{bin}} --host={{host}} attach {{id}}\"\nattach_command_mode = \"argv\"\n",
            toml::Value::String(cli.to_string_lossy().into_owned())
        ),
    )
    .expect("write GUI configuration");

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

    stop_session(&host, &created.sessions[0].id)
        .await
        .expect("stop fixture session");
    daemon.stop();
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
        child.kill().expect("stop daemon");
        child.wait().expect("reap daemon");
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        if self.0.is_some() {
            self.stop();
        }
    }
}
