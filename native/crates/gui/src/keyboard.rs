//! Keyboard shortcuts for the session-first native GUI.
//!
//! Focused Iced inputs consume handled key presses before the global
//! subscription sees them. Modal routing is therefore gated by `ModalView`,
//! while input editing remains owned by each widget.

// Rust guideline compliant 2026-08-12

use std::collections::BTreeMap;
use std::fmt;

use iced::keyboard::key::Named;
use iced::keyboard::{self, Key, Modifiers};
use iced::widget::{operation, Id};
use iced::{Subscription, Task};
use pohunek_gui_core::assistant::Intent as AssistantIntent;
use pohunek_gui_core::{fuzzy_rank, project_choice_labels, ProjectChoice, ProjectRef};
use protocol::ProviderKind;

use crate::message::{
    FormField, FormSelect, InboxView, ListDirection, Message, ModalView,
    ASSISTANT_AUTO_AGENT_LABEL, BLANK_TEMPLATE_LABEL, PROJECTS_LOADING_LABEL,
    PROJECT_PLACEHOLDER_LABEL,
};
use crate::selection::{available_actions, project_host, selected_session};
use crate::PohunekApp;

/// Keyboard routing scope.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum KeyContext {
    Global,
    Modal,
}

impl fmt::Display for KeyContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Global => f.write_str("global"),
            Self::Modal => f.write_str("modal"),
        }
    }
}

/// Shortcut action resolved from a key chord.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum KeyAction {
    OpenInbox,
    OpenSelectedSession,
    ShowSelectedSession,
    OpenKeymapHelp,
    NewSession,
    OpenAssistant,
    ModalBack,
    ModalPrimary,
    ModalPrimaryWithTerminal,
    OpenLinkedSession,
    ListUp,
    ListDown,
}

const START_NAME_INPUT_ID: &str = "start-session-name";
const START_PROMPT_INPUT_ID: &str = "start-session-prompt";
const START_BRANCH_INPUT_ID: &str = "start-session-branch";
const START_BASE_BRANCH_INPUT_ID: &str = "start-session-base-branch";
const START_PROJECT_SELECT_ID: &str = "start-session-project";
const START_AGENT_SELECT_ID: &str = "start-session-agent";
const START_TEMPLATE_SELECT_ID: &str = "start-session-template";
const ASSISTANT_REQUEST_INPUT_ID: &str = "assistant-request";
const ASSISTANT_BRANCH_INPUT_ID: &str = "assistant-branch";
const ASSISTANT_BASE_BRANCH_INPUT_ID: &str = "assistant-base-branch";
const ASSISTANT_PROJECT_SELECT_ID: &str = "assistant-project";
const ASSISTANT_INTENT_SELECT_ID: &str = "assistant-intent";
const ASSISTANT_AGENT_SELECT_ID: &str = "assistant-agent";
const READ_ONLY_TEXT_INPUT_ID: &str = "read-only-selectable-text";
const FORM_SELECT_SEARCH_ID: &str = "form-select-search";
const FORM_SELECT_SCROLL_ID: &str = "form-select-options";

/// Option count above which a select shows a search box; project selects
/// always do. Short lists such as agents are faster to pick from directly.
const SELECT_SEARCH_MIN_OPTIONS: usize = 6;

/// Height of one option row in an open select. The row height is fixed so the
/// scroll offset that keeps the cursor row centered can be derived from the
/// cursor position alone.
pub(crate) const SELECT_ROW_HEIGHT: f32 = 32.0;
/// Gap between option rows.
pub(crate) const SELECT_ROW_SPACING: f32 = 2.0;
/// Tallest an open select option list grows before it scrolls.
pub(crate) const SELECT_LIST_MAX_HEIGHT: f32 = 264.0;

/// Scrolls the open select's option list so the cursor row sits mid-list.
pub(crate) fn form_select_scroll_task(cursor: usize) -> Task<Message> {
    // Lists are far shorter than `u16::MAX` rows; the clamp only avoids a lossy cast.
    let position = f32::from(u16::try_from(cursor).unwrap_or(u16::MAX));
    let row_top = position * (SELECT_ROW_HEIGHT + SELECT_ROW_SPACING);
    let offset = (row_top - (SELECT_LIST_MAX_HEIGHT - SELECT_ROW_HEIGHT) / 2.0).max(0.0);
    operation::scroll_to(
        form_select_scroll_id(),
        operation::AbsoluteOffset {
            x: Some(0.0),
            y: Some(offset),
        },
    )
}

/// Focuses the search box of the open select, when it has one.
pub(crate) fn form_select_search_focus_task() -> Task<Message> {
    operation::focus(form_select_search_id())
}

pub(crate) fn form_select_search_id() -> Id {
    Id::new(FORM_SELECT_SEARCH_ID)
}

pub(crate) fn form_select_scroll_id() -> Id {
    Id::new(FORM_SELECT_SCROLL_ID)
}

pub(crate) fn start_name_input_id() -> Id {
    Id::new(START_NAME_INPUT_ID)
}

pub(crate) fn start_prompt_input_id() -> Id {
    Id::new(START_PROMPT_INPUT_ID)
}

pub(crate) fn start_branch_input_id() -> Id {
    Id::new(START_BRANCH_INPUT_ID)
}

pub(crate) fn start_base_branch_input_id() -> Id {
    Id::new(START_BASE_BRANCH_INPUT_ID)
}

fn start_project_select_id() -> Id {
    Id::new(START_PROJECT_SELECT_ID)
}

fn start_agent_select_id() -> Id {
    Id::new(START_AGENT_SELECT_ID)
}

fn start_template_select_id() -> Id {
    Id::new(START_TEMPLATE_SELECT_ID)
}

pub(crate) fn assistant_request_input_id() -> Id {
    Id::new(ASSISTANT_REQUEST_INPUT_ID)
}

pub(crate) fn assistant_branch_input_id() -> Id {
    Id::new(ASSISTANT_BRANCH_INPUT_ID)
}

pub(crate) fn assistant_base_branch_input_id() -> Id {
    Id::new(ASSISTANT_BASE_BRANCH_INPUT_ID)
}

fn assistant_project_select_id() -> Id {
    Id::new(ASSISTANT_PROJECT_SELECT_ID)
}

fn assistant_intent_select_id() -> Id {
    Id::new(ASSISTANT_INTENT_SELECT_ID)
}

fn assistant_agent_select_id() -> Id {
    Id::new(ASSISTANT_AGENT_SELECT_ID)
}

pub(crate) fn read_only_text_input_id() -> Id {
    Id::new(READ_ONLY_TEXT_INPUT_ID)
}

/// Config error raised while building a keymap from `gui.toml`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum KeyMapError {
    UnknownBinding {
        name: String,
    },
    InvalidKey {
        binding: String,
        value: String,
        reason: String,
    },
    Conflict {
        context: KeyContext,
        chord: String,
        first: &'static str,
        second: &'static str,
    },
}

impl fmt::Display for KeyMapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownBinding { name } => write!(f, "unknown keybinding `{name}`"),
            Self::InvalidKey {
                binding,
                value,
                reason,
            } => write!(f, "invalid key `{value}` for `{binding}`: {reason}"),
            Self::Conflict {
                context,
                chord,
                first,
                second,
            } => write!(
                f,
                "key `{chord}` in {context} context is bound to both `{first}` and `{second}`"
            ),
        }
    }
}

impl std::error::Error for KeyMapError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BindingId {
    OpenInbox,
    OpenSelectedSession,
    ShowSelectedSession,
    OpenKeymapHelp,
    NewSession,
    OpenAssistant,
    ModalBack,
    ModalPrimary,
    ModalPrimaryWithTerminal,
    ModalListUp,
    ModalListUpArrow,
    ModalListDown,
    ModalListDownArrow,
    ModalOpenLinkedSession,
}

impl BindingId {
    const ALL: &'static [Self] = &[
        Self::OpenInbox,
        Self::OpenSelectedSession,
        Self::ShowSelectedSession,
        Self::OpenKeymapHelp,
        Self::NewSession,
        Self::OpenAssistant,
        Self::ModalBack,
        Self::ModalPrimary,
        Self::ModalPrimaryWithTerminal,
        Self::ModalListUp,
        Self::ModalListUpArrow,
        Self::ModalListDown,
        Self::ModalListDownArrow,
        Self::ModalOpenLinkedSession,
    ];

    fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|binding| binding.config_name() == value)
    }

    const fn config_name(self) -> &'static str {
        match self {
            Self::OpenInbox => "open_inbox",
            Self::OpenSelectedSession => "open_selected_session",
            Self::ShowSelectedSession => "show_selected_session",
            Self::OpenKeymapHelp => "open_keymap_help",
            Self::NewSession => "new_session",
            Self::OpenAssistant => "open_assistant",
            Self::ModalBack => "modal_back",
            Self::ModalPrimary => "modal_primary",
            Self::ModalPrimaryWithTerminal => "modal_primary_with_terminal",
            Self::ModalListUp => "modal_list_up",
            Self::ModalListUpArrow => "modal_list_up_arrow",
            Self::ModalListDown => "modal_list_down",
            Self::ModalListDownArrow => "modal_list_down_arrow",
            Self::ModalOpenLinkedSession => "modal_open_linked_session",
        }
    }
}

/// A normalized key chord used by the shortcut map.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct KeyChord {
    key: ChordKey,
    modifiers: ChordModifiers,
}

impl KeyChord {
    pub(crate) fn character(value: &str) -> Self {
        Self {
            key: ChordKey::Character(value.to_lowercase()),
            modifiers: ChordModifiers::empty(),
        }
    }

    pub(crate) fn named(value: Named) -> Self {
        Self {
            key: ChordKey::Named(value),
            modifiers: ChordModifiers::empty(),
        }
    }

    fn shift_named(value: Named) -> Self {
        Self {
            key: ChordKey::Named(value),
            modifiers: ChordModifiers::SHIFT,
        }
    }

    pub(crate) fn with_modifiers(mut self, modifiers: Modifiers) -> Self {
        self.modifiers = ChordModifiers::from_modifiers(modifiers);
        self
    }

    fn from_key(context: KeyContext, key: &Key, modifiers: Modifiers) -> Self {
        let key = match key.as_ref() {
            Key::Character(value) => ChordKey::Character(value.to_lowercase()),
            Key::Named(value) => ChordKey::Named(value),
            Key::Unidentified => ChordKey::Other,
        };
        let modifiers = ChordModifiers::from_iced(context, &key, modifiers);
        Self { key, modifiers }
    }

    fn parse(value: &str) -> Result<Self, String> {
        let mut key = None;
        let mut modifiers = ChordModifiers::empty();
        for raw_part in value.split('+') {
            let part = raw_part.trim().to_lowercase();
            if part.is_empty() {
                return Err("empty key part".to_owned());
            }
            match part.as_str() {
                "shift" => set_modifier(&mut modifiers.shift, "shift")?,
                "ctrl" | "control" => set_modifier(&mut modifiers.control, "ctrl")?,
                "alt" | "option" | "opt" => set_modifier(&mut modifiers.alt, "alt")?,
                "logo" | "super" | "meta" | "cmd" | "command" => {
                    set_modifier(&mut modifiers.logo, "logo")?;
                }
                _ if key.is_none() => key = Some(parse_key(&part)?),
                _ => return Err("multiple non-modifier keys".to_owned()),
            }
        }
        Ok(Self {
            key: key.ok_or_else(|| "missing key".to_owned())?,
            modifiers,
        })
    }

    fn label(&self) -> String {
        let mut parts = Vec::new();
        if self.modifiers.control {
            parts.push("ctrl".to_owned());
        }
        if self.modifiers.alt {
            parts.push("alt".to_owned());
        }
        if self.modifiers.shift {
            parts.push("shift".to_owned());
        }
        if self.modifiers.logo {
            parts.push("logo".to_owned());
        }
        parts.push(self.key.label());
        parts.join("+")
    }

    fn supported_in(self, context: KeyContext) -> bool {
        context == KeyContext::Global
            || self.modifiers == ChordModifiers::empty()
            || (matches!(self.key, ChordKey::Named(Named::Enter))
                && self.modifiers == ChordModifiers::SHIFT)
    }

    fn is_focus_navigation(&self) -> bool {
        matches!(self.key, ChordKey::Named(Named::Tab))
            && (self.modifiers == ChordModifiers::empty()
                || self.modifiers == ChordModifiers::SHIFT)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ChordKey {
    Character(String),
    Named(Named),
    Other,
}

impl ChordKey {
    fn label(&self) -> String {
        match self {
            Self::Character(value) => value.clone(),
            Self::Named(value) => named_key_label(*value).to_owned(),
            Self::Other => "unidentified".to_owned(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "keyboard modifiers mirror Iced's independent modifier flags"
)]
struct ChordModifiers {
    shift: bool,
    control: bool,
    alt: bool,
    logo: bool,
}

impl ChordModifiers {
    const SHIFT: Self = Self {
        shift: true,
        control: false,
        alt: false,
        logo: false,
    };

    const fn empty() -> Self {
        Self {
            shift: false,
            control: false,
            alt: false,
            logo: false,
        }
    }

    fn from_modifiers(modifiers: Modifiers) -> Self {
        Self {
            shift: modifiers.shift(),
            control: modifiers.control(),
            alt: modifiers.alt(),
            logo: modifiers.logo(),
        }
    }

    fn from_iced(context: KeyContext, key: &ChordKey, modifiers: Modifiers) -> Self {
        // Modal bindings ignore Ctrl/Alt, but a Command chord is never a modal
        // binding: Cmd+C/V/X/A/K belong to the focused text input or the OS, so
        // the logo flag always survives and matches no modal binding.
        if context == KeyContext::Modal && !matches!(key, ChordKey::Named(Named::Enter)) {
            Self {
                logo: modifiers.logo(),
                ..Self::empty()
            }
        } else if context == KeyContext::Modal {
            Self {
                shift: modifiers.shift(),
                logo: modifiers.logo(),
                ..Self::empty()
            }
        } else {
            Self::from_modifiers(modifiers)
        }
    }
}

fn set_modifier(target: &mut bool, label: &'static str) -> Result<(), String> {
    if *target {
        Err(format!("duplicate `{label}` modifier"))
    } else {
        *target = true;
        Ok(())
    }
}

fn parse_key(value: &str) -> Result<ChordKey, String> {
    let named = match value {
        "esc" | "escape" => Some(Named::Escape),
        "enter" | "return" => Some(Named::Enter),
        "tab" => Some(Named::Tab),
        "space" => Some(Named::Space),
        "backspace" => Some(Named::Backspace),
        "delete" | "del" => Some(Named::Delete),
        "home" => Some(Named::Home),
        "end" => Some(Named::End),
        "pageup" | "page_up" => Some(Named::PageUp),
        "pagedown" | "page_down" => Some(Named::PageDown),
        "up" | "arrowup" | "arrow_up" => Some(Named::ArrowUp),
        "down" | "arrowdown" | "arrow_down" => Some(Named::ArrowDown),
        "left" | "arrowleft" | "arrow_left" => Some(Named::ArrowLeft),
        "right" | "arrowright" | "arrow_right" => Some(Named::ArrowRight),
        _ => None,
    };
    if let Some(named) = named {
        return Ok(ChordKey::Named(named));
    }
    let mut chars = value.chars();
    let first = chars.next().ok_or_else(|| "missing key".to_owned())?;
    if chars.next().is_some() {
        Err(format!("unknown key `{value}`"))
    } else {
        Ok(ChordKey::Character(first.to_string()))
    }
}

fn named_key_label(value: Named) -> &'static str {
    match value {
        Named::Escape => "escape",
        Named::Enter => "enter",
        Named::Tab => "tab",
        Named::Space => "space",
        Named::Backspace => "backspace",
        Named::Delete => "delete",
        Named::Home => "home",
        Named::End => "end",
        Named::PageUp => "pageup",
        Named::PageDown => "pagedown",
        Named::ArrowUp => "arrowup",
        Named::ArrowDown => "arrowdown",
        Named::ArrowLeft => "arrowleft",
        Named::ArrowRight => "arrowright",
        _ => "named",
    }
}

#[derive(Clone, Debug)]
pub(crate) struct KeyMap {
    bindings: Vec<KeyBinding>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct KeyBindingHelp {
    pub(crate) context: KeyContext,
    pub(crate) name: &'static str,
    pub(crate) chord: String,
}

impl KeyMap {
    pub(crate) fn action_for(&self, context: KeyContext, chord: &KeyChord) -> Option<KeyAction> {
        self.bindings
            .iter()
            .find(|binding| binding.context == context && binding.chord == *chord)
            .map(|binding| binding.action)
    }

    pub(crate) fn help_rows(&self) -> Vec<KeyBindingHelp> {
        self.bindings
            .iter()
            .map(|binding| KeyBindingHelp {
                context: binding.context,
                name: binding.id.config_name(),
                chord: binding.chord.label(),
            })
            .collect()
    }

    pub(crate) fn from_config(raw: &BTreeMap<String, String>) -> Result<Self, KeyMapError> {
        let mut keymap = Self::default();
        for (name, value) in raw {
            let id = BindingId::parse(name)
                .ok_or_else(|| KeyMapError::UnknownBinding { name: name.clone() })?;
            let chord = KeyChord::parse(value).map_err(|reason| KeyMapError::InvalidKey {
                binding: name.clone(),
                value: value.clone(),
                reason,
            })?;
            let binding = keymap
                .bindings
                .iter_mut()
                .find(|binding| binding.id == id)
                .expect("every binding id has one default");
            if chord.is_focus_navigation() {
                return Err(KeyMapError::InvalidKey {
                    binding: name.clone(),
                    value: value.clone(),
                    reason: "tab and shift+tab are reserved for focus navigation".to_owned(),
                });
            }
            if !chord.clone().supported_in(binding.context) {
                return Err(KeyMapError::InvalidKey {
                    binding: name.clone(),
                    value: value.clone(),
                    reason: "modal shortcuts only support bare keys, except shift+enter".to_owned(),
                });
            }
            binding.chord = chord;
        }
        keymap.validate_conflicts()?;
        Ok(keymap)
    }

    fn validate_conflicts(&self) -> Result<(), KeyMapError> {
        for (index, left) in self.bindings.iter().enumerate() {
            for right in self.bindings.iter().skip(index + 1) {
                if left.context == right.context
                    && left.chord == right.chord
                    && left.action != right.action
                {
                    return Err(KeyMapError::Conflict {
                        context: left.context,
                        chord: left.chord.label(),
                        first: left.id.config_name(),
                        second: right.id.config_name(),
                    });
                }
            }
        }
        Ok(())
    }
}

impl Default for KeyMap {
    fn default() -> Self {
        Self {
            bindings: vec![
                KeyBinding::global(
                    BindingId::OpenInbox,
                    KeyChord::character("i"),
                    KeyAction::OpenInbox,
                ),
                KeyBinding::global(
                    BindingId::OpenSelectedSession,
                    KeyChord::character("o"),
                    KeyAction::OpenSelectedSession,
                ),
                KeyBinding::global(
                    BindingId::ShowSelectedSession,
                    KeyChord::named(Named::Enter),
                    KeyAction::ShowSelectedSession,
                ),
                KeyBinding::global(
                    BindingId::OpenKeymapHelp,
                    KeyChord::character("?").with_modifiers(Modifiers::SHIFT),
                    KeyAction::OpenKeymapHelp,
                ),
                KeyBinding::global(
                    BindingId::NewSession,
                    KeyChord::character("n"),
                    KeyAction::NewSession,
                ),
                KeyBinding::global(
                    BindingId::OpenAssistant,
                    KeyChord::character("a"),
                    KeyAction::OpenAssistant,
                ),
                KeyBinding::modal(
                    BindingId::ModalBack,
                    KeyChord::named(Named::Escape),
                    KeyAction::ModalBack,
                ),
                KeyBinding::modal(
                    BindingId::ModalPrimary,
                    KeyChord::named(Named::Enter),
                    KeyAction::ModalPrimary,
                ),
                KeyBinding::modal(
                    BindingId::ModalPrimaryWithTerminal,
                    KeyChord::shift_named(Named::Enter),
                    KeyAction::ModalPrimaryWithTerminal,
                ),
                KeyBinding::modal(
                    BindingId::ModalListUp,
                    KeyChord::character("k"),
                    KeyAction::ListUp,
                ),
                KeyBinding::modal(
                    BindingId::ModalListUpArrow,
                    KeyChord::named(Named::ArrowUp),
                    KeyAction::ListUp,
                ),
                KeyBinding::modal(
                    BindingId::ModalListDown,
                    KeyChord::character("j"),
                    KeyAction::ListDown,
                ),
                KeyBinding::modal(
                    BindingId::ModalListDownArrow,
                    KeyChord::named(Named::ArrowDown),
                    KeyAction::ListDown,
                ),
                KeyBinding::modal(
                    BindingId::ModalOpenLinkedSession,
                    KeyChord::character("o"),
                    KeyAction::OpenLinkedSession,
                ),
            ],
        }
    }
}

#[derive(Clone, Debug)]
struct KeyBinding {
    id: BindingId,
    context: KeyContext,
    chord: KeyChord,
    action: KeyAction,
}

impl KeyBinding {
    fn global(id: BindingId, chord: KeyChord, action: KeyAction) -> Self {
        Self {
            id,
            context: KeyContext::Global,
            chord,
            action,
        }
    }

    fn modal(id: BindingId, chord: KeyChord, action: KeyAction) -> Self {
        Self {
            id,
            context: KeyContext::Modal,
            chord,
            action,
        }
    }
}

pub(crate) fn subscription() -> Subscription<Message> {
    keyboard::listen().filter_map(|event| match event {
        keyboard::Event::KeyPressed { key, modifiers, .. } => {
            Some(Message::KeyPressed { key, modifiers })
        }
        keyboard::Event::KeyReleased { .. } | keyboard::Event::ModifiersChanged(_) => None,
    })
}

pub(crate) fn route_key_press(app: &PohunekApp, key: &Key, modifiers: Modifiers) -> Vec<Message> {
    let context = if app.modal == ModalView::None {
        KeyContext::Global
    } else {
        KeyContext::Modal
    };
    let chord = KeyChord::from_key(context, key, modifiers);
    app.keymap
        .action_for(context, &chord)
        .map_or_else(Vec::new, |action| action_messages(app, action))
}

/// Handles conventional Tab traversal inside launch-form modals.
pub(crate) fn form_focus_task(
    app: &PohunekApp,
    key: &Key,
    modifiers: Modifiers,
) -> Option<Task<Message>> {
    let direction = form_focus_direction(app, key, modifiers)?;
    let fields = form_fields(app);
    let text_fields = fields
        .iter()
        .copied()
        .filter_map(|field| field_text_id(field).map(|id| (field, id)))
        .collect();
    Some(query_form_focus(text_fields, 0, direction))
}

fn form_focus_direction(
    app: &PohunekApp,
    key: &Key,
    modifiers: Modifiers,
) -> Option<ListDirection> {
    if !matches!(app.modal, ModalView::Start | ModalView::Assistant)
        || !matches!(key.as_ref(), Key::Named(Named::Tab))
        || modifiers.control()
        || modifiers.alt()
        || modifiers.logo()
    {
        return None;
    }

    Some(if modifiers.shift() {
        ListDirection::Up
    } else {
        ListDirection::Down
    })
}

fn query_form_focus(
    fields: Vec<(FormField, Id)>,
    index: usize,
    direction: ListDirection,
) -> Task<Message> {
    if fields.is_empty() {
        return Task::done(Message::TraverseFormFocus {
            focused: None,
            direction,
        });
    }
    let (field, id) = fields[index].clone();
    operation::is_focused(id).then(move |focused| {
        if focused {
            Task::done(Message::TraverseFormFocus {
                focused: Some(field),
                direction,
            })
        } else if index + 1 < fields.len() {
            query_form_focus(fields.clone(), index + 1, direction)
        } else {
            Task::done(Message::TraverseFormFocus {
                focused: None,
                direction,
            })
        }
    })
}

pub(crate) fn next_form_field(
    app: &PohunekApp,
    focused: Option<FormField>,
    direction: ListDirection,
) -> FormField {
    let fields = form_fields(app);
    let current = focused
        .filter(|field| fields.contains(field))
        .unwrap_or(app.form_focus);
    let index = fields.iter().position(|field| *field == current);
    let target = relative_focus_index(index, fields.len(), direction);
    fields[target]
}

fn relative_focus_index(
    focused: Option<usize>,
    field_count: usize,
    direction: ListDirection,
) -> usize {
    match (focused, direction) {
        (None, ListDirection::Down) => 0,
        (None | Some(0), ListDirection::Up) => field_count - 1,
        (Some(index), ListDirection::Down) => (index + 1) % field_count,
        (Some(index), ListDirection::Up) => index - 1,
    }
}

pub(crate) fn form_field_focus_task(field: FormField) -> Task<Message> {
    operation::focus(form_field_id(field))
}

fn form_field_id(field: FormField) -> Id {
    match field {
        FormField::StartProject => start_project_select_id(),
        FormField::StartAgent => start_agent_select_id(),
        FormField::StartTemplate => start_template_select_id(),
        FormField::StartName => start_name_input_id(),
        FormField::StartPrompt => start_prompt_input_id(),
        FormField::StartBranch => start_branch_input_id(),
        FormField::StartBaseBranch => start_base_branch_input_id(),
        FormField::AssistantProject => assistant_project_select_id(),
        FormField::AssistantIntent => assistant_intent_select_id(),
        FormField::AssistantAgent => assistant_agent_select_id(),
        FormField::AssistantRequest => assistant_request_input_id(),
        FormField::AssistantBranch => assistant_branch_input_id(),
        FormField::AssistantBaseBranch => assistant_base_branch_input_id(),
    }
}

fn field_text_id(field: FormField) -> Option<Id> {
    match field {
        FormField::StartName
        | FormField::StartPrompt
        | FormField::StartBranch
        | FormField::StartBaseBranch
        | FormField::AssistantRequest
        | FormField::AssistantBranch
        | FormField::AssistantBaseBranch => Some(form_field_id(field)),
        FormField::StartProject
        | FormField::StartAgent
        | FormField::StartTemplate
        | FormField::AssistantProject
        | FormField::AssistantIntent
        | FormField::AssistantAgent => None,
    }
}

fn form_fields(app: &PohunekApp) -> Vec<FormField> {
    match app.modal {
        ModalView::Start => {
            let mut fields = vec![
                FormField::StartProject,
                FormField::StartAgent,
                FormField::StartTemplate,
                FormField::StartName,
                FormField::StartPrompt,
            ];
            if app.start.show_advanced && app.start.template.is_none() {
                fields.push(FormField::StartBranch);
                fields.push(FormField::StartBaseBranch);
            }
            fields
        }
        ModalView::Assistant => {
            let mut fields = vec![
                FormField::AssistantProject,
                FormField::AssistantIntent,
                FormField::AssistantAgent,
                FormField::AssistantRequest,
            ];
            if app.assistant.show_advanced {
                fields.push(FormField::AssistantBranch);
                fields.push(FormField::AssistantBaseBranch);
            }
            fields
        }
        ModalView::None
        | ModalView::Session
        | ModalView::ConfirmDeleteSession
        | ModalView::Keymap
        | ModalView::Hosts
        | ModalView::Inbox => Vec::new(),
    }
}

pub(crate) fn form_field_is_visible(app: &PohunekApp, field: FormField) -> bool {
    form_fields(app).contains(&field)
}

const ASSISTANT_INTENTS: [AssistantIntent; 5] = [
    AssistantIntent::Help,
    AssistantIntent::Setup,
    AssistantIntent::Project,
    AssistantIntent::Update,
    AssistantIntent::Debug,
];

pub(crate) fn form_select_options(app: &PohunekApp, field: FormField) -> Vec<String> {
    match field {
        FormField::StartProject | FormField::AssistantProject => project_picker_labels(app),
        FormField::StartAgent => project_host(app, app.start.project.as_ref())
            .map_or_else(Vec::new, pohunek_gui_core::HostView::launchable_agents),
        FormField::StartTemplate => {
            let mut options = vec![BLANK_TEMPLATE_LABEL.to_owned()];
            options.extend(available_actions(app, &ProviderKind::None));
            options
        }
        FormField::AssistantIntent => ASSISTANT_INTENTS.iter().map(ToString::to_string).collect(),
        FormField::AssistantAgent => {
            let mut options = vec![ASSISTANT_AUTO_AGENT_LABEL.to_owned()];
            if let Some(host) = project_host(app, app.assistant.project.as_ref()) {
                options.extend(host.launchable_assistant_agents());
            }
            options
        }
        FormField::StartName
        | FormField::StartPrompt
        | FormField::StartBranch
        | FormField::StartBaseBranch
        | FormField::AssistantRequest
        | FormField::AssistantBranch
        | FormField::AssistantBaseBranch => Vec::new(),
    }
}

/// One selectable row of an open form select.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SelectEntry {
    /// Position in the unfiltered option list.
    pub(crate) index: usize,
    pub(crate) label: String,
    /// Muted secondary text shown after the label, such as the owning host.
    pub(crate) detail: Option<String>,
    /// The option's host is not connected, so it is shown dimmed.
    pub(crate) dimmed: bool,
    /// The option is the field's current value.
    pub(crate) is_current: bool,
}

/// Whether `field`'s open select shows a search box.
pub(crate) fn form_select_is_searchable(app: &PohunekApp, field: FormField) -> bool {
    matches!(field, FormField::StartProject | FormField::AssistantProject)
        || form_select_options(app, field).len() > SELECT_SEARCH_MIN_OPTIONS
}

/// Rows of `field`'s select that match the fuzzy `query`, best match first;
/// every option, in list order, for an empty query.
pub(crate) fn form_select_entries(
    app: &PohunekApp,
    field: FormField,
    query: &str,
) -> Vec<SelectEntry> {
    let entries = match field {
        FormField::StartProject => {
            project_entries(&app.workspace.project_choices(), app.start.project.as_ref())
        }
        FormField::AssistantProject => project_entries(
            &app.workspace.project_choices(),
            app.assistant.project.as_ref(),
        ),
        _ => {
            let current = form_select_label(app, field);
            form_select_options(app, field)
                .into_iter()
                .enumerate()
                .map(|(index, label)| SelectEntry {
                    index,
                    is_current: label == current,
                    label,
                    detail: None,
                    dimmed: false,
                })
                .collect()
        }
    };
    let haystacks: Vec<String> = match field {
        FormField::StartProject | FormField::AssistantProject => app
            .workspace
            .project_choices()
            .iter()
            .map(|choice| {
                format!(
                    "{} {} {}",
                    choice.label, choice.host_label, choice.project.project_id
                )
            })
            .collect(),
        _ => entries.iter().map(|entry| entry.label.clone()).collect(),
    };
    fuzzy_rank(query, haystacks.iter().map(String::as_str))
        .into_iter()
        .map(|position| entries[position].clone())
        .collect()
}

/// Project rows in `project_choices` order: the project label, with the host
/// and session count as detail. The project id is appended only where one host
/// holds several projects with the same label.
fn project_entries(choices: &[ProjectChoice], current: Option<&ProjectRef>) -> Vec<SelectEntry> {
    choices
        .iter()
        .enumerate()
        .map(|(index, choice)| {
            let duplicate = choices.iter().filter(|other| {
                other.project.host_id == choice.project.host_id && other.label == choice.label
            });
            let mut label = choice.label.clone();
            if duplicate.count() > 1 {
                label.push_str("  ·  ");
                label.push_str(&choice.project.project_id);
            }
            let mut detail = choice.host_label.clone();
            if !choice.host_connected {
                detail = format!("{detail}  ·  offline");
            } else if choice.session_count > 0 {
                let noun = if choice.session_count == 1 {
                    "session"
                } else {
                    "sessions"
                };
                detail = format!("{detail}  ·  {} {noun}", choice.session_count);
            }
            SelectEntry {
                index,
                label,
                detail: Some(detail),
                dimmed: !choice.host_connected,
                is_current: current == Some(&choice.project),
            }
        })
        .collect()
}

/// Picker labels in `project_choices` order: `label · host`, plus the project
/// id when one host holds several projects with the same label.
fn project_picker_labels(app: &PohunekApp) -> Vec<String> {
    project_choice_labels(&app.workspace.project_choices(), true)
}

fn project_select_label(app: &PohunekApp, project: Option<&ProjectRef>) -> String {
    if app.workspace.project_choices().is_empty() {
        return PROJECTS_LOADING_LABEL.to_owned();
    }
    project
        .and_then(|project| {
            let choices = app.workspace.project_choices();
            let index = choices
                .iter()
                .position(|choice| &choice.project == project)?;
            project_picker_labels(app).into_iter().nth(index)
        })
        .unwrap_or_else(|| PROJECT_PLACEHOLDER_LABEL.to_owned())
}

pub(crate) fn form_select_label(app: &PohunekApp, field: FormField) -> String {
    match field {
        FormField::StartProject => project_select_label(app, app.start.project.as_ref()),
        FormField::AssistantProject => project_select_label(app, app.assistant.project.as_ref()),
        FormField::StartAgent => app.start.agent.clone(),
        FormField::StartTemplate => app
            .start
            .template
            .clone()
            .unwrap_or_else(|| BLANK_TEMPLATE_LABEL.to_owned()),
        FormField::AssistantIntent => app.assistant.intent.to_string(),
        FormField::AssistantAgent => app
            .assistant
            .agent
            .clone()
            .unwrap_or_else(|| ASSISTANT_AUTO_AGENT_LABEL.to_owned()),
        FormField::StartName
        | FormField::StartPrompt
        | FormField::StartBranch
        | FormField::StartBaseBranch
        | FormField::AssistantRequest
        | FormField::AssistantBranch
        | FormField::AssistantBaseBranch => String::new(),
    }
}

pub(crate) fn form_select_cursor(app: &PohunekApp, field: FormField) -> usize {
    let current_project = match field {
        FormField::StartProject => app.start.project.as_ref(),
        FormField::AssistantProject => app.assistant.project.as_ref(),
        _ => None,
    };
    if let Some(project) = current_project {
        return app
            .workspace
            .project_choices()
            .iter()
            .position(|choice| &choice.project == project)
            .unwrap_or(0);
    }
    let selected = form_select_label(app, field);
    form_select_options(app, field)
        .iter()
        .position(|option| option == &selected)
        .unwrap_or(0)
}

pub(crate) fn form_select_key_message(
    app: &PohunekApp,
    key: &Key,
    modifiers: Modifiers,
) -> Option<Message> {
    if !matches!(app.modal, ModalView::Start | ModalView::Assistant)
        || modifiers.control()
        || modifiers.alt()
        || modifiers.logo()
        || !matches!(
            app.form_focus,
            FormField::StartProject
                | FormField::StartAgent
                | FormField::StartTemplate
                | FormField::AssistantProject
                | FormField::AssistantIntent
                | FormField::AssistantAgent
        )
    {
        return None;
    }
    let is_open = app
        .form_select
        .as_ref()
        .is_some_and(|select| select.field == app.form_focus);
    match key.as_ref() {
        Key::Named(Named::ArrowUp) if is_open => Some(Message::MoveFormSelect(ListDirection::Up)),
        Key::Named(Named::ArrowDown) if is_open => {
            Some(Message::MoveFormSelect(ListDirection::Down))
        }
        Key::Named(Named::ArrowUp | Named::ArrowDown | Named::Enter) if !is_open => {
            Some(Message::ToggleFormSelect(app.form_focus))
        }
        Key::Named(Named::Enter) => Some(Message::ConfirmFormSelect),
        Key::Named(Named::Escape) if is_open => Some(Message::CloseFormSelect),
        _ => None,
    }
}

/// Whether `key` with `modifiers` is the launch-form submit chord.
///
/// Ctrl+Enter submits on every platform. On macOS, where Command is the
/// platform-native modifier, Command+Enter submits as well. Alt never combines
/// with either, and Ctrl+Command together is not a submit chord.
pub(crate) fn is_submit_chord(key: &Key, modifiers: Modifiers, macos: bool) -> bool {
    matches!(key.as_ref(), Key::Named(Named::Enter))
        && !modifiers.alt()
        && ((modifiers.control() && !modifiers.logo())
            || (macos && modifiers.logo() && !modifiers.control()))
}

pub(crate) fn form_submit_message(
    app: &PohunekApp,
    key: &Key,
    modifiers: Modifiers,
) -> Option<Message> {
    form_submit_message_for(app, key, modifiers, cfg!(target_os = "macos"))
}

fn form_submit_message_for(
    app: &PohunekApp,
    key: &Key,
    modifiers: Modifiers,
    macos: bool,
) -> Option<Message> {
    if !is_submit_chord(key, modifiers, macos) {
        return None;
    }
    match app.modal {
        ModalView::Start => Some(Message::CreateSession),
        ModalView::Assistant => Some(Message::LaunchAssistant),
        ModalView::None
        | ModalView::Session
        | ModalView::ConfirmDeleteSession
        | ModalView::Keymap
        | ModalView::Hosts
        | ModalView::Inbox => None,
    }
}

pub(crate) fn form_reserves_enter(app: &PohunekApp, key: &Key) -> bool {
    matches!(app.modal, ModalView::Start | ModalView::Assistant)
        && matches!(key.as_ref(), Key::Named(Named::Enter))
}

pub(crate) fn form_select_choice_message(app: &PohunekApp, select: &FormSelect) -> Option<Message> {
    let entry = form_select_entries(app, select.field, &select.query)
        .into_iter()
        .nth(select.cursor)?;
    let option = form_select_options(app, select.field)
        .into_iter()
        .nth(entry.index)?;
    match select.field {
        FormField::StartProject => project_choice_at(app, entry.index)
            .map(|choice| Message::StartProjectSelected(choice.project)),
        FormField::AssistantProject => project_choice_at(app, entry.index)
            .map(|choice| Message::AssistantProjectSelected(choice.project)),
        FormField::StartAgent => Some(Message::StartAgentSelected(option)),
        FormField::StartTemplate => Some(Message::StartTemplateSelected(option)),
        FormField::AssistantIntent => ASSISTANT_INTENTS
            .get(entry.index)
            .copied()
            .map(Message::AssistantIntentSelected),
        FormField::AssistantAgent => Some(Message::AssistantAgentSelected(option)),
        FormField::StartName
        | FormField::StartPrompt
        | FormField::StartBranch
        | FormField::StartBaseBranch
        | FormField::AssistantRequest
        | FormField::AssistantBranch
        | FormField::AssistantBaseBranch => None,
    }
}

fn project_choice_at(app: &PohunekApp, index: usize) -> Option<ProjectChoice> {
    app.workspace.project_choices().into_iter().nth(index)
}

fn action_messages(app: &PohunekApp, action: KeyAction) -> Vec<Message> {
    match action {
        KeyAction::OpenInbox => vec![Message::OpenInbox],
        KeyAction::OpenSelectedSession => open_selected_session(app),
        KeyAction::ShowSelectedSession => show_selected_session(app),
        KeyAction::OpenKeymapHelp => vec![Message::OpenKeymapModal],
        KeyAction::NewSession => {
            if app.workspace.project_choices().is_empty() {
                Vec::new()
            } else {
                vec![Message::OpenStartModal]
            }
        }
        KeyAction::OpenAssistant => vec![Message::OpenAssistantModal],
        KeyAction::ModalBack => vec![escape_message(app)],
        KeyAction::ModalPrimary => modal_primary(app, false),
        KeyAction::ModalPrimaryWithTerminal => modal_primary(app, true),
        KeyAction::OpenLinkedSession => selected_inbox_notification_link(app),
        KeyAction::ListUp => vec![Message::MoveListSelection(ListDirection::Up)],
        KeyAction::ListDown => vec![Message::MoveListSelection(ListDirection::Down)],
    }
}

/// Rows a session key may act on: the filtered overview while it is the
/// foreground, every row while a modal (e.g. one opened from a notification
/// link) owns the selection.
fn actionable_session_rows(app: &PohunekApp) -> Vec<pohunek_gui_core::SessionRow> {
    let filter = (app.modal == ModalView::None)
        .then_some(app.project_filter.as_ref())
        .flatten();
    app.workspace.session_rows_filtered(filter)
}

fn open_selected_session(app: &PohunekApp) -> Vec<Message> {
    selected_session(app).map_or_else(Vec::new, |(host_id, session)| {
        let can_open = actionable_session_rows(app).into_iter().any(|row| {
            row.host_id == *host_id
                && row.session_id == session.id
                && matches!(
                    row.access,
                    pohunek_gui_core::SessionAccess::Attach
                        | pohunek_gui_core::SessionAccess::Resume
                )
        });
        if can_open {
            vec![Message::OpenSession {
                host_id: host_id.clone(),
                session_id: session.id.clone(),
            }]
        } else {
            Vec::new()
        }
    })
}

fn show_selected_session(app: &PohunekApp) -> Vec<Message> {
    selected_session(app).map_or_else(Vec::new, |(host_id, session)| {
        let listed = actionable_session_rows(app)
            .iter()
            .any(|row| row.host_id == *host_id && row.session_id == session.id);
        if listed {
            vec![Message::SelectSession {
                host_id: host_id.clone(),
                session_id: session.id.clone(),
            }]
        } else {
            Vec::new()
        }
    })
}

fn escape_message(app: &PohunekApp) -> Message {
    if app.modal == ModalView::Inbox && matches!(app.inbox_view, InboxView::Message { .. }) {
        Message::InboxBack
    } else {
        Message::CloseModal
    }
}

fn modal_primary(app: &PohunekApp, open_terminal: bool) -> Vec<Message> {
    match app.modal {
        ModalView::Start => vec![Message::CreateSession],
        ModalView::Assistant => vec![Message::LaunchAssistant],
        ModalView::Session => open_selected_session(app),
        ModalView::ConfirmDeleteSession => vec![Message::ConfirmDeleteSession],
        ModalView::Inbox => inbox_primary(app, open_terminal),
        ModalView::Keymap | ModalView::Hosts | ModalView::None => Vec::new(),
    }
}

fn inbox_primary(app: &PohunekApp, open_terminal: bool) -> Vec<Message> {
    let InboxView::Message {
        host_id,
        notification_id,
    } = &app.inbox_view
    else {
        return selected_inbox_notification(app);
    };
    let Some(record) = app.workspace.notification(host_id, notification_id) else {
        return Vec::new();
    };
    let Some(session_id) = record.session_id.clone() else {
        return Vec::new();
    };
    let exists = app
        .workspace
        .hosts
        .get(host_id)
        .is_some_and(|host| host.sessions.contains_key(&session_id.0));
    if !exists {
        return Vec::new();
    }
    let mut messages = vec![Message::OpenNotificationLink {
        host_id: host_id.clone(),
        notification_id: notification_id.clone(),
    }];
    if open_terminal {
        messages.push(Message::OpenSession {
            host_id: host_id.clone(),
            session_id,
        });
    }
    messages
}

fn selected_inbox_notification(app: &PohunekApp) -> Vec<Message> {
    selected_inbox_row(app).map_or_else(Vec::new, |row| {
        vec![Message::SelectNotification {
            host_id: row.host_id,
            notification_id: row.record.id,
        }]
    })
}

fn selected_inbox_notification_link(app: &PohunekApp) -> Vec<Message> {
    if app.modal != ModalView::Inbox || !matches!(app.inbox_view, InboxView::List) {
        return Vec::new();
    }
    selected_inbox_row(app).map_or_else(Vec::new, |row| {
        let exists = row.record.session_id.as_ref().is_some_and(|session_id| {
            app.workspace
                .hosts
                .get(&row.host_id)
                .is_some_and(|host| host.sessions.contains_key(&session_id.0))
        });
        if exists {
            vec![Message::OpenNotificationLink {
                host_id: row.host_id,
                notification_id: row.record.id,
            }]
        } else {
            Vec::new()
        }
    })
}

fn selected_inbox_row(app: &PohunekApp) -> Option<pohunek_gui_core::NotificationRow> {
    let rows = app
        .workspace
        .inbox_rows(app.inbox_scope, &app.notification_filter);
    app.inbox_cursor
        .as_ref()
        .and_then(|(host_id, id)| {
            rows.iter()
                .find(|row| &row.host_id == host_id && &row.record.id == id)
        })
        .or_else(|| rows.first())
        .cloned()
}

pub(crate) fn focus_task(app: &PohunekApp) -> Task<Message> {
    match app.modal {
        ModalView::Start | ModalView::Assistant => form_field_focus_task(app.form_focus),
        ModalView::None
        | ModalView::Session
        | ModalView::ConfirmDeleteSession
        | ModalView::Keymap
        | ModalView::Hosts
        | ModalView::Inbox => Task::none(),
    }
}
