//! Modal contents for session launch, assistant launch, key help, and toasts.

// Rust guideline compliant 2026-10-01

use iced::widget::{
    button, checkbox, column, container, row, scrollable, space, text, text_editor, text_input,
};
use iced::{Background, Border, Center, Color, Element, Fill, Shadow, Theme, Vector};
use pohunek_gui_core::Toast;

use crate::keyboard::{
    KeyBindingHelp, KeyContext, SelectEntry, SELECT_LIST_MAX_HEIGHT, SELECT_ROW_HEIGHT,
    SELECT_ROW_SPACING,
};
use crate::message::{FormField, FormSelect, ListDirection, Message};
use crate::selection::project_host;
use crate::view::session::session_name_input;
use crate::PohunekApp;

use super::dropdown::{dropdown, MenuKeys};
use super::{dialog_card, muted_style, scrolling_dialog_card};

pub(crate) fn start_modal_content(app: &PohunekApp) -> Element<'_, Message> {
    let advanced_label = if app.start.show_advanced {
        "Advanced v"
    } else {
        "Advanced >"
    };
    let prompt_label = if app.start.template.is_some() {
        "Prompt (edit before starting)"
    } else {
        "Prompt / initial input (optional)"
    };
    let mut panel = column![
        form_select(app, "Project", FormField::StartProject),
        row![
            form_select(app, "Agent", FormField::StartAgent),
            form_select(app, "Template", FormField::StartTemplate),
        ]
        .spacing(8)
        .align_y(Center),
        session_name_input(app),
        text(prompt_label).size(13),
        text_editor(&app.prompt_editor)
            .id(crate::keyboard::start_prompt_input_id())
            .height(220)
            .key_binding(start_prompt_binding)
            .on_action(Message::PromptEdited),
        button(text(advanced_label).size(13))
            .on_press(Message::ToggleStartAdvanced)
            .style(iced::widget::button::text),
    ]
    .spacing(8);
    if app.start.show_advanced && app.start.template.is_none() {
        panel = panel.push(
            row![
                text_input("branch override", &app.start.branch)
                    .id(crate::keyboard::start_branch_input_id())
                    .on_input(Message::StartBranchChanged),
                text_input("base branch override", &app.start.base_branch)
                    .id(crate::keyboard::start_base_branch_input_id())
                    .on_input(Message::StartBaseBranchChanged),
            ]
            .spacing(8),
        );
    }
    let mut start = button(if app.launcher.pending {
        "Starting..."
    } else {
        "Start session"
    })
    .style(iced::widget::button::primary);
    if !app.launcher.pending
        && project_host(app, app.start.project.as_ref())
            .is_some_and(|host| host.agent_is_launchable(&app.start.agent))
    {
        start = start.on_press(Message::CreateSession);
    }
    scrolling_dialog_card("Start a session", panel.push(start))
}

pub(crate) fn assistant_modal_content(app: &PohunekApp) -> Element<'_, Message> {
    let advanced_label = if app.assistant.show_advanced {
        "Advanced v"
    } else {
        "Advanced >"
    };
    let mut panel = column![
        form_select(app, "Project", FormField::AssistantProject),
        row![
            form_select(app, "Intent", FormField::AssistantIntent),
            form_select(app, "Agent", FormField::AssistantAgent),
        ]
        .spacing(8)
        .align_y(Center),
        text("Request / initial prompt").size(13),
        text_editor(&app.assistant_editor)
            .id(crate::keyboard::assistant_request_input_id())
            .height(180)
            .key_binding(assistant_request_binding)
            .on_action(Message::AssistantRequestEdited),
        button(text(advanced_label).size(13))
            .on_press(Message::ToggleAssistantAdvanced)
            .style(iced::widget::button::text),
    ]
    .spacing(8);
    if app.assistant.show_advanced {
        panel = panel
            .push(
                row![
                    text_input("branch override", &app.assistant.branch)
                        .id(crate::keyboard::assistant_branch_input_id())
                        .on_input(Message::AssistantBranchChanged),
                    text_input("base branch override", &app.assistant.base_branch)
                        .id(crate::keyboard::assistant_base_branch_input_id())
                        .on_input(Message::AssistantBaseBranchChanged),
                ]
                .spacing(8),
            )
            .push(
                row![
                    checkbox(app.assistant.no_snapshot)
                        .label("No snapshot")
                        .on_toggle(Message::AssistantNoSnapshotToggled),
                    checkbox(app.assistant.degraded)
                        .label("Degraded")
                        .on_toggle(Message::AssistantDegradedToggled),
                ]
                .spacing(12),
            );
    }
    let launchable = project_host(app, app.assistant.project.as_ref()).is_some_and(|host| {
        app.assistant.agent.as_deref().map_or_else(
            || !host.launchable_assistant_agents().is_empty(),
            |agent| host.agent_is_assistant_capable(agent),
        )
    });
    let mut start = button("Start assistant").style(iced::widget::button::primary);
    if launchable {
        start = start.on_press(Message::LaunchAssistant);
    }
    scrolling_dialog_card("Start assistant", panel.push(start))
}

fn start_prompt_binding(key_press: text_editor::KeyPress) -> Option<text_editor::Binding<Message>> {
    multiline_binding(key_press, Message::CreateSession)
}

fn assistant_request_binding(
    key_press: text_editor::KeyPress,
) -> Option<text_editor::Binding<Message>> {
    multiline_binding(key_press, Message::LaunchAssistant)
}

fn multiline_binding(
    key_press: text_editor::KeyPress,
    submit: Message,
) -> Option<text_editor::Binding<Message>> {
    if crate::keyboard::is_submit_chord(
        &key_press.key,
        key_press.modifiers,
        cfg!(target_os = "macos"),
    ) {
        Some(text_editor::Binding::Custom(submit))
    } else {
        text_editor::Binding::from_key_press(key_press)
    }
}

pub(crate) fn keymap_modal_content(app: &PohunekApp) -> Element<'_, Message> {
    let rows = app.keymap.help_rows();
    dialog_card(
        "Keyboard shortcuts",
        column![
            keymap_section("Global", &rows, KeyContext::Global),
            keymap_section("Modal", &rows, KeyContext::Modal),
        ]
        .spacing(14),
    )
}

fn keymap_section(
    title: &'static str,
    rows: &[KeyBindingHelp],
    context: KeyContext,
) -> Element<'static, Message> {
    let mut section = column![text(title).size(15)].spacing(6);
    for binding in rows.iter().filter(|binding| binding.context == context) {
        section = section.push(
            row![
                text(binding.chord.clone())
                    .size(13)
                    .font(iced::Font::MONOSPACE),
                text(binding.name).size(13).style(muted_style),
            ]
            .spacing(14),
        );
    }
    section.into()
}

fn form_select<'a>(
    app: &'a PohunekApp,
    label: &'static str,
    field: FormField,
) -> Element<'a, Message> {
    let selected = crate::keyboard::form_select_label(app, field);
    let is_focused = app.form_focus == field;
    let open = app
        .form_select
        .as_ref()
        .filter(|select| select.field == field);
    let trigger = button(row![text(selected).width(Fill), text("v")].spacing(8))
        .width(Fill)
        .on_press(Message::ToggleFormSelect(field));
    let trigger = if is_focused {
        trigger.style(iced::widget::button::primary)
    } else {
        trigger.style(iced::widget::button::secondary)
    };
    let menu = open.map_or_else(
        || Element::from(space()),
        |select| select_menu(app, field, select),
    );
    let keys = MenuKeys {
        up: Message::MoveFormSelect(ListDirection::Up),
        down: Message::MoveFormSelect(ListDirection::Down),
        confirm: Message::ConfirmFormSelect,
        dismiss: Message::CloseFormSelect,
    };
    column![
        text(label).size(14),
        dropdown(trigger, menu, open.is_some(), keys)
    ]
    .spacing(4)
    .width(Fill)
    .into()
}

/// Menu of an open select: an optional search box above the option rows.
fn select_menu<'a>(
    app: &'a PohunekApp,
    field: FormField,
    select: &'a FormSelect,
) -> Element<'a, Message> {
    let entries = crate::keyboard::form_select_entries(app, field, &select.query);
    let mut rows = column![].spacing(SELECT_ROW_SPACING);
    if entries.is_empty() {
        rows = rows.push(
            container(text("No matches").style(muted_style))
                .height(SELECT_ROW_HEIGHT)
                .padding([0, 10])
                .align_y(Center),
        );
    }
    for (position, entry) in entries.into_iter().enumerate() {
        rows = rows.push(select_row(
            field,
            position,
            entry,
            position == select.cursor,
        ));
    }
    let list = container(scrollable(rows).id(crate::keyboard::form_select_scroll_id()))
        .max_height(SELECT_LIST_MAX_HEIGHT);
    let mut menu = column![].spacing(8);
    if crate::keyboard::form_select_is_searchable(app, field) {
        menu = menu.push(
            text_input("Search...", &select.query)
                .id(crate::keyboard::form_select_search_id())
                .on_input(Message::FormSelectQueryChanged)
                .size(14),
        );
    }
    container(menu.push(list))
        .padding(8)
        .style(menu_style)
        .into()
}

fn select_row(
    field: FormField,
    position: usize,
    entry: SelectEntry,
    is_cursor: bool,
) -> Element<'static, Message> {
    // The cursor row inherits the button's text color so it stays readable on
    // the accent background; other rows fade secondary information.
    let fade = move |theme: &Theme, faded: bool| {
        if faded && !is_cursor {
            muted_style(theme)
        } else {
            iced::widget::text::Style::default()
        }
    };
    let font = if entry.is_current {
        iced::Font {
            weight: iced::font::Weight::Bold,
            ..iced::Font::DEFAULT
        }
    } else {
        iced::Font::DEFAULT
    };
    let dimmed = entry.dimmed;
    let mut content = row![
        text(entry.label)
            .font(font)
            .style(move |theme: &Theme| fade(theme, dimmed)),
        space().width(Fill),
    ]
    .align_y(Center);
    if let Some(detail) = entry.detail {
        content = content.push(
            text(detail)
                .size(12)
                .style(move |theme: &Theme| fade(theme, true)),
        );
    }
    button(container(content).center_y(Fill))
        .width(Fill)
        .height(SELECT_ROW_HEIGHT)
        .padding([0, 10])
        .on_press(Message::ChooseFormSelect {
            field,
            index: position,
        })
        .style(select_row_style(is_cursor))
        .into()
}

/// Row background: a solid accent with its paired text color for the cursor
/// row, a light tint on hover, transparent otherwise.
fn select_row_style(
    is_cursor: bool,
) -> impl Fn(&Theme, iced::widget::button::Status) -> iced::widget::button::Style {
    move |theme, status| {
        use iced::widget::button::{Status, Style};
        let palette = theme.extended_palette();
        let mut style = Style {
            background: None,
            text_color: palette.background.base.text,
            border: iced::border::rounded(6.0),
            ..Style::default()
        };
        if is_cursor {
            style.background = Some(Background::Color(palette.primary.base.color));
            style.text_color = palette.primary.base.text;
        } else if matches!(status, Status::Hovered | Status::Pressed) {
            style.background = Some(Background::Color(palette.background.weak.color));
        }
        style
    }
}

/// Raised panel for the dropdown menu so it reads as floating above the dialog.
fn menu_style(theme: &Theme) -> iced::widget::container::Style {
    let palette = theme.extended_palette();
    iced::widget::container::Style {
        background: Some(Background::Color(palette.background.base.color)),
        border: Border {
            color: palette.background.strong.color,
            width: 1.0,
            radius: 8.0.into(),
        },
        shadow: Shadow {
            color: Color::BLACK.scale_alpha(0.4),
            offset: Vector::new(0.0, 4.0),
            blur_radius: 12.0,
        },
        ..iced::widget::container::Style::default()
    }
}

pub(crate) fn toast_view<'a>(app: &PohunekApp, toast: &'a Toast) -> Element<'a, Message> {
    container(text(format!(
        "{} / {}: {}",
        app.workspace.host_label(&toast.host_id),
        toast.session_id.0,
        toast.message
    )))
    .padding(8)
    .into()
}

#[cfg(test)]
mod tests {
    #[test]
    fn ctrl_enter_submits_multiline_forms() {
        use iced::keyboard::Modifiers;
        let enter = iced::keyboard::Key::Named(iced::keyboard::key::Named::Enter);
        assert!(crate::keyboard::is_submit_chord(
            &enter,
            Modifiers::CTRL,
            false
        ));
        assert!(crate::keyboard::is_submit_chord(
            &enter,
            Modifiers::CTRL,
            true
        ));
        assert!(!crate::keyboard::is_submit_chord(
            &enter,
            Modifiers::empty(),
            true
        ));
        assert!(!crate::keyboard::is_submit_chord(
            &enter,
            Modifiers::CTRL | Modifiers::ALT,
            true
        ));
        assert!(crate::keyboard::is_submit_chord(
            &enter,
            Modifiers::COMMAND,
            true
        ));
        assert!(!crate::keyboard::is_submit_chord(
            &enter,
            Modifiers::LOGO,
            false
        ));
    }
}
