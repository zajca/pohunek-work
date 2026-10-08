//! Open-in-browser and open-folder actions of a session.

// Rust guideline compliant 2026-10-03

use std::path::{Path, PathBuf};

use iced::widget::{button, column, row, text};
use iced::{Center, Element};
use pohunek_gui_core::{work_link, ExternalUrl, HostId, WorkLink};
use protocol::SessionInfo;

use crate::message::Message;
use crate::open::{host_is_local, OpenTarget};
use crate::PohunekApp;

use super::{card, muted_style, section_title, status_pill, PillTone};

/// Where a session's links and folder lead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Targets {
    /// Linked work item, labelled by the site its URL points to.
    pub(crate) item: Option<ExternalUrl>,
    /// Branch page of the repository, derived from a pull-request link.
    pub(crate) branch_page: Option<ExternalUrl>,
    pub(crate) branch: Option<String>,
    /// Worktree, or the working directory when there is none.
    pub(crate) path: Option<PathBuf>,
    /// Whether `path` can be opened on this machine.
    pub(crate) open_folder: bool,
    /// Whether `path` lives on a known remote host: it exists only there, so it
    /// can be copied but not opened.
    pub(crate) remote_path: bool,
}

impl Targets {
    pub(crate) fn new(
        link: Option<&WorkLink>,
        branch: Option<&str>,
        path: Option<&Path>,
        local: Option<bool>,
    ) -> Self {
        let branch = branch
            .filter(|branch| !branch.is_empty())
            .or_else(|| link.and_then(|link| link.branch.as_deref()))
            .map(str::to_owned);
        // The provider's branch names the pull request head; the session branch
        // can be a local helper branch (a review checkout) that GitHub lacks.
        let branch_page = link
            .and_then(|link| link.url.as_ref().zip(link.branch.as_deref()))
            .or_else(|| {
                link.and_then(|link| link.url.as_ref())
                    .zip(branch.as_deref())
            })
            .and_then(|(url, branch)| url.github_branch_url(branch));
        Self {
            item: link.and_then(|link| link.url.clone()),
            branch_page,
            branch,
            path: path.map(Path::to_path_buf),
            open_folder: local == Some(true) && path.is_some_and(Path::is_absolute),
            remote_path: local == Some(false) && path.is_some(),
        }
    }

    /// Whether any action exists.
    pub(crate) fn is_empty(&self) -> bool {
        self.item.is_none() && self.branch.is_none() && self.path.is_none()
    }
}

/// Whether sessions of `host_id` live on this machine, or `None` while the host
/// is not known yet.
pub(crate) fn session_host_is_local(app: &PohunekApp, host_id: &HostId) -> Option<bool> {
    app.hosts
        .iter()
        .find(|host| host.id == *host_id)
        .map(host_is_local)
}

fn small_button(label: String, message: Message) -> Element<'static, Message> {
    button(text(label).size(12))
        .padding([5, 9])
        .on_press(message)
        .style(iced::widget::button::secondary)
        .into()
}

fn open_url_button(label: String, url: &ExternalUrl) -> Element<'static, Message> {
    small_button(label, Message::OpenExternal(OpenTarget::Url(url.clone())))
}

/// Compact link and folder buttons for a session-list row.
pub(crate) fn row_buttons(targets: &Targets) -> Vec<Element<'static, Message>> {
    let mut buttons = Vec::new();
    if let Some(url) = &targets.item {
        buttons.push(open_url_button(url.site().label().to_owned(), url));
    }
    if let (true, Some(path)) = (targets.open_folder, &targets.path) {
        buttons.push(small_button(
            "Folder".to_owned(),
            Message::OpenExternal(OpenTarget::Folder(path.clone())),
        ));
    }
    buttons
}

/// Card with every link, folder and copy action of the session.
pub(crate) fn links_view<'a>(
    app: &PohunekApp,
    host_id: &HostId,
    session: &SessionInfo,
) -> Option<Element<'a, Message>> {
    let link = work_link(session);
    let path = session
        .worktree_path
        .as_deref()
        .unwrap_or(session.cwd.as_path());
    let targets = Targets::new(
        link.as_ref(),
        session.branch.as_deref(),
        Some(path),
        session_host_is_local(app, host_id),
    );
    if targets.is_empty() {
        return None;
    }
    let mut content = column![section_title("Links")].spacing(8);
    if let Some(link) = &link {
        let mut heading = row![text(link.id.clone()).size(14)]
            .spacing(6)
            .align_y(Center);
        if let Some(kind) = &link.kind {
            heading = heading.push(status_pill(kind.replace('_', " "), PillTone::Neutral));
        }
        if let Some(role) = &link.role {
            heading = heading.push(status_pill(role.clone(), PillTone::Success));
        }
        content = content.push(heading);
    }
    let mut actions = row![].spacing(8);
    if let Some(url) = &targets.item {
        actions = actions.push(open_url_button(
            format!("Open in {}", url.site().label()),
            url,
        ));
    }
    if let Some(url) = &targets.branch_page {
        actions = actions.push(open_url_button("Open branch on GitHub".to_owned(), url));
    }
    if let (true, Some(path)) = (targets.open_folder, &targets.path) {
        actions = actions.push(small_button(
            "Open folder".to_owned(),
            Message::OpenExternal(OpenTarget::Folder(path.clone())),
        ));
    }
    if let Some(branch) = &targets.branch {
        actions = actions.push(small_button(
            "Copy branch".to_owned(),
            Message::CopyText {
                label: "branch",
                text: branch.clone(),
            },
        ));
    }
    if let Some(path) = &targets.path {
        actions = actions.push(small_button(
            "Copy path".to_owned(),
            Message::CopyText {
                label: "path",
                text: path.to_string_lossy().into_owned(),
            },
        ));
    }
    content = content.push(actions);
    if targets.remote_path {
        content = content.push(
            text("The folder is on a remote host; copy its path instead.")
                .size(12)
                .style(muted_style),
        );
    }
    Some(card(content))
}
