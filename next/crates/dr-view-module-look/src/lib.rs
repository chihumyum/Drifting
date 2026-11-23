//! A custom module's look (`docs/rust-rewrite/custom-modules.md` §4, CM2):
//! its box tree drawn with a set of values at one of its three sizes.
//!
//! The input is a module value (`dr_model::custom_module::ModuleValue`), the
//! values to draw ([`Scope`]: an entry's, the module's sample, or none), a
//! size (一行、一块、铺满) and whether the host edits them ([`Edit`]). No open
//! book is needed: the entry page is one host (`dr-view-page`), an entry
//! name's hover card another (`dr-editor`), the module workbench's preview
//! (CM3) the next.
//!
//! - [`plan`]: the layout, pure: every node with its style resolved to the
//!   §4 vocabulary, every value with what it shows and where it is kept.
//! - [`paint`]: the layout as GPUI elements, every step on a dr-ui token.
//! - [`render`]: the two together.
//! - [`placeholder`]: what stands for a copy this build cannot read (§16
//!   item 6): an empty block with only the module's name.

pub mod paint;
pub mod plan;
pub mod values;

pub use paint::{Blanks, Edit, Picking};
pub use plan::{
    Content, Fill, NodePath, PBox, PEach, PItem, PMark, PNode, PText, PValue, Plan, Words,
};
pub use values::{EntryName, Item, Names, NoNames, Picture, Scope, Shown};

use std::rc::Rc;
use std::sync::Arc;

use dr_model::custom_module::{LookSize, ModuleValue};
use dr_ui::{Theme, fonts::Role, style::DrStyled, tokens::surface};
use gpui::{
    AnyElement, App, ElementId, Global, InteractiveElement as _, IntoElement, ParentElement as _,
    RenderOnce, Styled as _, Window, div, px,
};

/// The words the layout writes, as the App says them (registered once by
/// the host that has the App's strings, `dr-view-page`).
struct WordsHost(Rc<CountOf>);

/// How a list's count is said (「3 个伏笔」).
type CountOf = dyn Fn(usize, &str, &App) -> String;

impl Global for WordsHost {}

/// Registers how the layout's own words are said in the App's language.
pub fn set_words(cx: &mut App, count_of: impl Fn(usize, &str, &App) -> String + 'static) {
    cx.set_global(WordsHost(Rc::new(count_of)));
}

/// The App's words ([`set_words`]); without them, a count and the list's
/// name.
pub struct AppWords<'a>(pub &'a App);

impl Words for AppWords<'_> {
    fn count_of(&self, count: usize, list: &str) -> String {
        match self.0.try_global::<WordsHost>() {
            Some(host) => (host.0)(count, list, self.0),
            None => format!("{count} {list}"),
        }
    }
}

/// A module's 一行, read-only (an entry name's hover card, §4 「一行」):
/// laid out when it is drawn, in the App's words.
#[derive(IntoElement)]
pub struct Line {
    id: ElementId,
    module: Arc<ModuleValue>,
    values: Arc<Scope>,
}

impl Line {
    pub fn new(id: impl Into<ElementId>, module: Arc<ModuleValue>, values: Arc<Scope>) -> Line {
        Line {
            id: id.into(),
            module,
            values,
        }
    }
}

impl RenderOnce for Line {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let laid = plan::plan(&self.module, &self.values, LookSize::Line, &AppWords(cx));
        div()
            .debug_selector(|| "module-line".into())
            .min_w_0()
            .overflow_hidden()
            .child(paint::paint(self.id, &laid, Blanks::Dash, None, window, cx))
    }
}

/// `module` drawn at `size` with `values`, in the App's words
/// ([`set_words`]). `edit`, when given, is the host that puts its controls
/// in the value nodes and list items; without it the look is read-only and
/// a value with nothing kept shows as `blanks` says.
#[allow(clippy::too_many_arguments)]
pub fn render(
    id: impl Into<ElementId>,
    module: &ModuleValue,
    values: &Scope,
    size: LookSize,
    blanks: Blanks,
    edit: Option<&dyn Edit>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let laid = plan::plan(module, values, size, &AppWords(cx));
    paint::paint(id, &laid, blanks, edit, window, cx)
}

/// What stands for a copy this build cannot read (§16 item 6), or a module
/// the book has no copy of: an empty block holding only the module's name.
/// Its values stay in the book, untouched.
pub fn placeholder(
    id: impl Into<ElementId>,
    name: &str,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    div()
        .id(id.into())
        .debug_selector(|| "module-placeholder".into())
        .w_full()
        .min_h(px(s.row_height * 2.0))
        .px(px(12.0))
        .py(px(8.0))
        .rounded(px(2.0))
        .border(px(surface::HAIRLINE))
        .border_color(p.hairline())
        .bg(p.ink(1).alpha(paint::WASH))
        .flex()
        .items_center()
        .font_role(Role::Ui)
        .type_px(s.secondary, s.line_body)
        .text_color(p.ink(3).solid())
        .child(name.to_owned())
        .into_any_element()
}
