//! Native Iced shell for the pohunek control plane.

// Rust guideline compliant 2026-09-11
#![forbid(unsafe_code)]

mod attach;
mod bin_resolver;
mod command;
mod config;
mod keyboard;
mod message;
mod notify;
mod open;
mod runtime;
mod selection;
mod terminal;
#[cfg(test)]
mod test_support;
mod view;

#[cfg(target_os = "linux")]
use std::ffi::OsStr;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use iced::widget::text_editor;
use iced::{window, Subscription, Task, Theme};
use pohunek_gui_core::{
    default_state_dir, AttachTemplateValues, HostConfig, HostId, NotificationFilter,
    NotificationScope, ProjectRef, UiState, Workspace,
};
use protocol::{NotificationId, SessionId};
use thiserror::Error;

use attach::{window_dimension_to_f32, AttachPlan};
use command::{discover_hosts_task, update};
use config::AppConfig;
use message::{
    AppMode, AssistantForm, FormField, FormSelect, InboxView, LauncherState, Message, MetadataEdit,
    ModalView, StartForm, TemplateRecipe,
};
use view::view;

// The Wayland-only startup contract applies to Linux; macOS uses the native
// window backend and has no display-server environment to validate.
// Wayland clients discover their compositor through this standard variable.
#[cfg(target_os = "linux")]
const WAYLAND_DISPLAY_ENV: &str = "WAYLAND_DISPLAY";

// X11 clients use this standard variable; seeing it without Wayland gives a
// clearer error than letting the window backend fail later.
#[cfg(target_os = "linux")]
const X11_DISPLAY_ENV: &str = "DISPLAY";

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("{err}");
            ExitCode::FAILURE
        }
    }
}

/// Command-line flag that starts only the Start-a-session dialog.
const NEW_SESSION_FLAG: &str = "--new-session";

/// Wayland application id of the dialog-only window, so a compositor rule can
/// float it without touching the main window.
#[cfg(target_os = "linux")]
const LAUNCHER_APP_ID: &str = "pohunek-gui-new-session";

/// Size of the dialog-only window: the 640 px dialog plus its margin, tall
/// enough that an open project list fits below the select.
const LAUNCHER_WINDOW_SIZE: (f32, f32) = (700.0, 760.0);

/// Argument error: this program accepts no argument except [`NEW_SESSION_FLAG`].
#[derive(Debug, Error, PartialEq, Eq)]
#[error("unexpected argument `{argument}`; usage: pohunek-gui [{NEW_SESSION_FLAG}]")]
struct UsageError {
    argument: String,
}

fn parse_args(args: impl IntoIterator<Item = OsString>) -> Result<AppMode, UsageError> {
    let mut mode = AppMode::Full;
    for argument in args {
        if argument == NEW_SESSION_FLAG {
            mode = AppMode::NewSession;
        } else {
            return Err(UsageError {
                argument: argument.to_string_lossy().into_owned(),
            });
        }
    }
    Ok(mode)
}

fn run() -> Result<(), StartupError> {
    let mode = parse_args(std::env::args_os().skip(1))?;
    #[cfg(target_os = "linux")]
    validate_wayland_environment()?;
    let boot = BootState::load(mode);
    let initial_window_size = boot.ui_state.window_size;
    let application = iced::application(move || PohunekApp::boot(boot.clone(), mode), update, view)
        .subscription(subscription)
        .theme(theme);
    match mode {
        AppMode::Full => application.window_size((
            window_dimension_to_f32(initial_window_size.width),
            window_dimension_to_f32(initial_window_size.height),
        )),
        AppMode::NewSession => application.window(launcher_window_settings()),
    }
    .run()?;
    Ok(())
}

fn launcher_window_settings() -> window::Settings {
    window::Settings {
        size: LAUNCHER_WINDOW_SIZE.into(),
        position: window::Position::Centered,
        // A fixed size makes the compositor float the window (sway and other
        // Wayland compositors treat equal min and max size as a dialog).
        resizable: false,
        #[cfg(target_os = "linux")]
        platform_specific: window::settings::PlatformSpecific {
            application_id: LAUNCHER_APP_ID.to_owned(),
            ..window::settings::PlatformSpecific::default()
        },
        ..window::Settings::default()
    }
}

#[derive(Debug, Error)]
enum StartupError {
    #[error(transparent)]
    Usage(#[from] UsageError),
    #[cfg(target_os = "linux")]
    #[error(transparent)]
    Display(#[from] DisplayServerError),
    #[error(transparent)]
    Iced(#[from] iced::Error),
}

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DisplayServerError {
    MissingWayland,
    X11WithoutWayland,
}

#[cfg(target_os = "linux")]
impl std::fmt::Display for DisplayServerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingWayland => write!(
                f,
                "pohunek-gui is Wayland-only; set `{WAYLAND_DISPLAY_ENV}` to a Wayland display before starting it"
            ),
            Self::X11WithoutWayland => write!(
                f,
                "pohunek-gui is Wayland-only; {X11_DISPLAY_ENV} is set, but {WAYLAND_DISPLAY_ENV} is missing or empty. X11 is not supported"
            ),
        }
    }
}

#[cfg(target_os = "linux")]
impl std::error::Error for DisplayServerError {}

#[cfg(target_os = "linux")]
fn validate_wayland_environment() -> Result<(), DisplayServerError> {
    let wayland_display = std::env::var_os(WAYLAND_DISPLAY_ENV);
    let x11_display = std::env::var_os(X11_DISPLAY_ENV);
    validate_wayland_display(wayland_display.as_deref(), x11_display.as_deref())
}

#[cfg(target_os = "linux")]
fn validate_wayland_display(
    wayland_display: Option<&OsStr>,
    x11_display: Option<&OsStr>,
) -> Result<(), DisplayServerError> {
    if has_display_value(wayland_display) {
        Ok(())
    } else if has_display_value(x11_display) {
        Err(DisplayServerError::X11WithoutWayland)
    } else {
        Err(DisplayServerError::MissingWayland)
    }
}

#[cfg(target_os = "linux")]
fn has_display_value(value: Option<&OsStr>) -> bool {
    value.is_some_and(|value| !value.is_empty())
}

#[derive(Debug, Clone)]
struct BootState {
    ui_state: UiState,
    state_dir: Option<PathBuf>,
    status: Option<String>,
}

impl BootState {
    fn load(mode: AppMode) -> Self {
        Self::read().for_mode(mode)
    }

    /// The dialog-only process reads the saved selection to preselect a
    /// project but never writes it: the main window owns the file, and this
    /// process's window size and selection must not replace the main one's.
    fn for_mode(mut self, mode: AppMode) -> Self {
        if mode == AppMode::NewSession {
            self.state_dir = None;
        }
        self
    }

    fn read() -> Self {
        match default_state_dir() {
            Ok(state_dir) => match UiState::load_from_dir(&state_dir) {
                Ok(ui_state) => Self {
                    ui_state,
                    state_dir: Some(state_dir),
                    status: None,
                },
                Err(err) => Self {
                    ui_state: UiState::default(),
                    state_dir: Some(state_dir),
                    status: Some(err.to_string()),
                },
            },
            Err(err) => Self {
                ui_state: UiState::default(),
                state_dir: None,
                status: Some(err.to_string()),
            },
        }
    }
}

// Not `Clone`: `text_editor::Content` (the editable prompt buffer) is not
// clonable, and the application state is owned by Iced and never cloned.
#[derive(Debug)]
struct PohunekApp {
    mode: AppMode,
    launcher: LauncherState,
    workspace: Workspace,
    config: Result<AppConfig, String>,
    keymap: keyboard::KeyMap,
    hosts: Vec<HostConfig>,
    ui_state: UiState,
    start: StartForm,
    assistant: AssistantForm,
    /// Logical focus for launch-form fields that Iced cannot focus natively.
    form_focus: FormField,
    /// Expanded launch-form select and its keyboard cursor.
    form_select: Option<FormSelect>,
    /// Editable session input / rendered prompt buffer shown in the Start modal.
    prompt_editor: text_editor::Content,
    /// Editable request buffer shown in the Assistant modal.
    assistant_editor: text_editor::Content,
    /// Resolved recipe (agent/branch) for the selected template; `None` when a
    /// blank session or while a template is still resolving.
    template_recipe: Option<TemplateRecipe>,
    /// Which modal, if any, is currently open over the workspace.
    modal: ModalView,
    /// Active inbox host filter; `None` fields do not constrain the notification list.
    notification_filter: NotificationFilter,
    /// `Recent | Unread | Archived` scope picked in the activity modal.
    inbox_scope: NotificationScope,
    /// Which layer of the inbox modal is showing.
    inbox_view: InboxView,
    /// Keyboard cursor for the inbox list layer. This stays local UI state; the
    /// persisted UI selection remains reserved for the selected session.
    inbox_cursor: Option<(HostId, NotificationId)>,
    /// Whether the inbox message layer's `> Details` section is expanded.
    inbox_details_expanded: bool,
    metadata_edit: MetadataEdit,
    /// Edit buffer for renaming the selected session's display name.
    rename_edit: String,
    /// Project the session overview is narrowed to; `None` shows every session.
    project_filter: Option<ProjectRef>,
    /// Counter bumped whenever the Start form's project, template or contents
    /// are reset; a template reply is applied only when it carries the current
    /// value.
    template_generation: u64,
    state_dir: Option<PathBuf>,
    status: Option<String>,
    notified_intents: usize,
    /// Last notification backend state, so failures reach the status line once.
    notification_health: notify::NotificationHealth,
}

impl PohunekApp {
    fn boot(boot: BootState, mode: AppMode) -> (Self, Task<Message>) {
        let config = AppConfig::load().map_err(|err| err.to_string());
        let keymap = config.as_ref().map_or_else(
            |_| keyboard::KeyMap::default(),
            |config| config.keymap.clone(),
        );
        let task = match &config {
            Ok(config) => discover_hosts_task(config),
            Err(_) => Task::none(),
        };
        let mut workspace = Workspace::default();
        workspace.selection.clone_from(&boot.ui_state.selection);
        let mut app = Self {
            mode,
            launcher: LauncherState::default(),
            workspace,
            config,
            keymap,
            hosts: Vec::new(),
            ui_state: boot.ui_state,
            start: StartForm::default(),
            assistant: AssistantForm::default(),
            form_focus: FormField::StartAgent,
            form_select: None,
            prompt_editor: text_editor::Content::new(),
            assistant_editor: text_editor::Content::new(),
            template_recipe: None,
            modal: ModalView::None,
            notification_filter: NotificationFilter::default(),
            inbox_scope: NotificationScope::default(),
            inbox_view: InboxView::default(),
            inbox_cursor: None,
            inbox_details_expanded: false,
            metadata_edit: MetadataEdit::default(),
            rename_edit: String::new(),
            project_filter: None,
            template_generation: 0,
            state_dir: boot.state_dir,
            status: boot.status,
            notified_intents: 0,
            notification_health: notify::NotificationHealth::default(),
        };
        if mode == AppMode::NewSession {
            command::open_start_modal(&mut app);
        }
        (app, task)
    }

    pub(crate) fn attach_plan(
        &self,
        host_id: &HostId,
        session_id: &SessionId,
    ) -> Result<AttachPlan, String> {
        let config = self.config.as_ref().map_err(Clone::clone)?;
        let host = self
            .hosts
            .iter()
            .find(|host| &host.id == host_id)
            .ok_or_else(|| format!("unknown host `{host_id}`"))?;
        Ok(AttachPlan {
            selection: config.attach.clone(),
            resolver: Arc::clone(&config.bin_resolver),
            launch: config.launch,
            values: AttachTemplateValues {
                bin: config.pohunek_bin.clone(),
                host: host.attach_host(),
                id: session_id.0.clone(),
            },
        })
    }
}

fn subscription(app: &PohunekApp) -> Subscription<Message> {
    let mut subscriptions = vec![
        window::resize_events().map(|(_id, size)| Message::WindowResized(size)),
        keyboard::subscription(),
    ];
    if let Ok(config) = &app.config {
        subscriptions.extend(app.hosts.iter().cloned().map(|host| {
            Subscription::run_with(
                (host, config.connection_options),
                runtime::host_subscription,
            )
            .map(Message::Core)
        }));
    }
    Subscription::batch(subscriptions)
}

fn theme(_app: &PohunekApp) -> Theme {
    Theme::TokyoNight
}
