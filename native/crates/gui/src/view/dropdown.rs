//! Dropdown: a trigger with a menu drawn as an overlay above the window.
//!
//! The menu does not take part in the parent layout, so opening it never
//! resizes the dialog that holds the trigger, and a scrollable ancestor does
//! not clip it.

// Rust guideline compliant 2026-10-01

use iced::advanced::layout::{self, Layout};
use iced::advanced::overlay;
use iced::advanced::renderer;
use iced::advanced::widget::tree::{self, Tree};
use iced::advanced::widget::Operation;
use iced::advanced::{Clipboard, Shell, Widget};
use iced::keyboard::key::Named;
use iced::keyboard::{self, Key};
use iced::{mouse, Element, Event, Length, Point, Rectangle, Size, Vector};

use crate::message::Message;

/// Space between the trigger and its menu.
const MENU_GAP: f32 = 4.0;

/// Messages a dropdown menu publishes for the keys it owns while open.
#[derive(Debug, Clone)]
pub(crate) struct MenuKeys {
    pub(crate) up: Message,
    pub(crate) down: Message,
    pub(crate) confirm: Message,
    pub(crate) dismiss: Message,
}

/// Creates a dropdown. `menu` is only laid out and drawn while `open`.
pub(crate) fn dropdown<'a>(
    trigger: impl Into<Element<'a, Message>>,
    menu: impl Into<Element<'a, Message>>,
    open: bool,
    keys: MenuKeys,
) -> Dropdown<'a> {
    Dropdown {
        trigger: trigger.into(),
        menu: menu.into(),
        open,
        keys,
    }
}

/// A trigger widget that can show a menu overlay below (or above) itself.
///
/// While open the menu owns the keys in [`MenuKeys`] (Enter only without
/// modifiers, so the form submit chord still reaches the form) and a click
/// outside the menu dismisses it without reaching the widgets underneath.
pub(crate) struct Dropdown<'a> {
    trigger: Element<'a, Message>,
    menu: Element<'a, Message>,
    open: bool,
    keys: MenuKeys,
}

impl std::fmt::Debug for Dropdown<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Dropdown")
            .field("open", &self.open)
            .finish_non_exhaustive()
    }
}

impl Widget<Message, iced::Theme, iced::Renderer> for Dropdown<'_> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::stateless()
    }

    fn children(&self) -> Vec<Tree> {
        vec![Tree::new(&self.trigger), Tree::new(&self.menu)]
    }

    fn diff(&self, tree: &mut Tree) {
        tree.diff_children(&[&self.trigger, &self.menu]);
    }

    fn size(&self) -> Size<Length> {
        self.trigger.as_widget().size()
    }

    fn layout(
        &mut self,
        tree: &mut Tree,
        renderer: &iced::Renderer,
        limits: &layout::Limits,
    ) -> layout::Node {
        self.trigger
            .as_widget_mut()
            .layout(&mut tree.children[0], renderer, limits)
    }

    fn draw(
        &self,
        tree: &Tree,
        renderer: &mut iced::Renderer,
        theme: &iced::Theme,
        style: &renderer::Style,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        viewport: &Rectangle,
    ) {
        self.trigger.as_widget().draw(
            &tree.children[0],
            renderer,
            theme,
            style,
            layout,
            cursor,
            viewport,
        );
    }

    fn operate(
        &mut self,
        tree: &mut Tree,
        layout: Layout<'_>,
        renderer: &iced::Renderer,
        operation: &mut dyn Operation,
    ) {
        self.trigger
            .as_widget_mut()
            .operate(&mut tree.children[0], layout, renderer, operation);
    }

    fn update(
        &mut self,
        tree: &mut Tree,
        event: &Event,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        renderer: &iced::Renderer,
        clipboard: &mut dyn Clipboard,
        shell: &mut Shell<'_, Message>,
        viewport: &Rectangle,
    ) {
        self.trigger.as_widget_mut().update(
            &mut tree.children[0],
            event,
            layout,
            cursor,
            renderer,
            clipboard,
            shell,
            viewport,
        );
    }

    fn mouse_interaction(
        &self,
        tree: &Tree,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        viewport: &Rectangle,
        renderer: &iced::Renderer,
    ) -> mouse::Interaction {
        self.trigger.as_widget().mouse_interaction(
            &tree.children[0],
            layout,
            cursor,
            viewport,
            renderer,
        )
    }

    fn overlay<'b>(
        &'b mut self,
        tree: &'b mut Tree,
        layout: Layout<'b>,
        _renderer: &iced::Renderer,
        _viewport: &Rectangle,
        translation: Vector,
    ) -> Option<overlay::Element<'b, Message, iced::Theme, iced::Renderer>> {
        if !self.open {
            return None;
        }
        let bounds = layout.bounds();
        let trigger_bounds = Rectangle {
            x: bounds.x + translation.x,
            y: bounds.y + translation.y,
            ..bounds
        };
        let (_, menu_tree) = tree.children.split_at_mut(1);
        Some(overlay::Element::new(Box::new(MenuOverlay {
            menu: &mut self.menu,
            tree: &mut menu_tree[0],
            trigger_bounds,
            keys: &self.keys,
        })))
    }
}

impl<'a> From<Dropdown<'a>> for Element<'a, Message> {
    fn from(dropdown: Dropdown<'a>) -> Self {
        Element::new(dropdown)
    }
}

/// Which side of the trigger the menu opens on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Placement {
    Below,
    Above,
}

/// Opens below unless the menu does not fit there and the room above is larger.
fn choose_placement(natural_height: f32, space_below: f32, space_above: f32) -> Placement {
    if natural_height > space_below && space_above > space_below {
        Placement::Above
    } else {
        Placement::Below
    }
}

struct MenuOverlay<'a, 'b> {
    menu: &'b mut Element<'a, Message>,
    tree: &'b mut Tree,
    trigger_bounds: Rectangle,
    keys: &'b MenuKeys,
}

impl overlay::Overlay<Message, iced::Theme, iced::Renderer> for MenuOverlay<'_, '_> {
    fn layout(&mut self, renderer: &iced::Renderer, bounds: Size) -> layout::Node {
        let width = self.trigger_bounds.width.min(bounds.width);
        let space_below =
            bounds.height - (self.trigger_bounds.y + self.trigger_bounds.height) - MENU_GAP;
        let space_above = self.trigger_bounds.y - MENU_GAP;

        let mut measure = |available: f32| {
            let limits = layout::Limits::new(Size::ZERO, Size::new(width, available.max(0.0)))
                .width(Length::Fixed(width));
            self.menu
                .as_widget_mut()
                .layout(self.tree, renderer, &limits)
        };

        // A menu laid out within one side's room can never report more height
        // than that room, so the natural height is measured with the larger
        // side's limit, the side is chosen from it, and only then is the menu
        // laid out within the chosen side.
        let natural = measure(space_below.max(space_above)).size().height;
        let placement = choose_placement(natural, space_below, space_above);
        let node = measure(match placement {
            Placement::Below => space_below,
            Placement::Above => space_above,
        });
        let y = match placement {
            Placement::Below => self.trigger_bounds.y + self.trigger_bounds.height + MENU_GAP,
            Placement::Above => self.trigger_bounds.y - MENU_GAP - node.size().height,
        };
        let x = self.trigger_bounds.x.min(bounds.width - width).max(0.0);
        node.move_to(Point::new(x, y.max(0.0)))
    }

    fn draw(
        &self,
        renderer: &mut iced::Renderer,
        theme: &iced::Theme,
        style: &renderer::Style,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
    ) {
        self.menu.as_widget().draw(
            self.tree,
            renderer,
            theme,
            style,
            layout,
            cursor,
            &Rectangle::with_size(Size::INFINITE),
        );
    }

    fn operate(
        &mut self,
        layout: Layout<'_>,
        renderer: &iced::Renderer,
        operation: &mut dyn Operation,
    ) {
        self.menu
            .as_widget_mut()
            .operate(self.tree, layout, renderer, operation);
    }

    fn update(
        &mut self,
        event: &Event,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        renderer: &iced::Renderer,
        clipboard: &mut dyn Clipboard,
        shell: &mut Shell<'_, Message>,
    ) {
        if let Some(message) = self.owned_message(event, layout, cursor) {
            shell.publish(message);
            shell.capture_event();
            return;
        }
        self.menu.as_widget_mut().update(
            self.tree,
            event,
            layout,
            cursor,
            renderer,
            clipboard,
            shell,
            &layout.bounds(),
        );
    }

    fn mouse_interaction(
        &self,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        renderer: &iced::Renderer,
    ) -> mouse::Interaction {
        self.menu.as_widget().mouse_interaction(
            self.tree,
            layout,
            cursor,
            &layout.bounds(),
            renderer,
        )
    }
}

impl MenuOverlay<'_, '_> {
    /// Message for an event the menu owns: its navigation keys, or a press
    /// outside the menu.
    fn owned_message(
        &self,
        event: &Event,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
    ) -> Option<Message> {
        match event {
            Event::Keyboard(keyboard::Event::KeyPressed { key, modifiers, .. }) => {
                if modifiers.control() || modifiers.alt() || modifiers.logo() {
                    return None;
                }
                match key.as_ref() {
                    Key::Named(Named::ArrowUp) => Some(self.keys.up.clone()),
                    Key::Named(Named::ArrowDown) => Some(self.keys.down.clone()),
                    Key::Named(Named::Enter) => Some(self.keys.confirm.clone()),
                    Key::Named(Named::Escape) => Some(self.keys.dismiss.clone()),
                    _ => None,
                }
            }
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left))
                if !cursor.is_over(layout.bounds()) =>
            {
                Some(self.keys.dismiss.clone())
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_that_fits_below_opens_below() {
        assert_eq!(choose_placement(200.0, 300.0, 600.0), Placement::Below);
    }

    #[test]
    fn menu_that_does_not_fit_below_opens_above_when_there_is_more_room() {
        assert_eq!(choose_placement(300.0, 120.0, 500.0), Placement::Above);
    }

    #[test]
    fn menu_stays_below_when_neither_side_has_more_room() {
        assert_eq!(choose_placement(500.0, 300.0, 200.0), Placement::Below);
    }
}
