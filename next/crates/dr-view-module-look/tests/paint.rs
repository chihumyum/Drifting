//! The look drawn on GPUI's test platform: the four sample modules at the
//! three sizes in the light and the dark theme, read-only (with their
//! sample and with nothing), a broken copy's placeholder, and the hover
//! card's 一行 element. Nothing here may need an open book.

use std::sync::Arc;

use dr_model::custom_module::{LookSize, ModuleValue};
use dr_ui::Appearance;
use dr_view_module_look::{Blanks, Line, Scope, placeholder, render};
use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement, ParentElement as _, Render,
    Styled as _, TestAppContext, VisualTestContext, Window, div, px, size,
};

struct Host {
    module: Option<ModuleValue>,
    values: Scope,
    size: LookSize,
    blanks: Blanks,
}

impl Render for Host {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let look: AnyElement = match &self.module {
            Some(module) => render(
                "look",
                module,
                &self.values,
                self.size,
                self.blanks,
                None,
                window,
                cx,
            ),
            None => placeholder("look", "伏笔追踪", window, cx),
        };
        div().size_full().p(px(40.0)).child(
            div()
                .debug_selector(|| "look".into())
                .w(px(560.0))
                .child(look),
        )
    }
}

fn init(cx: &mut TestAppContext, appearance: Appearance) {
    cx.update(|cx| {
        if let Err(missing) = dr_ui::init(cx)
            && std::env::var_os("DR_UI_REQUIRE_FONTS").is_some()
        {
            panic!("{missing}");
        }
        dr_ui::theme::force_appearance(Some(appearance), cx);
    });
}

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

#[gpui::test]
fn every_sample_draws_at_every_size_in_both_themes(cx: &mut TestAppContext) {
    for appearance in [Appearance::Light, Appearance::Dark] {
        init(cx, appearance);
        for module in dr_testkit::samples::modules() {
            for size_ in [LookSize::Line, LookSize::Block, LookSize::Full] {
                for (values, blanks, room) in [
                    (Scope::sample(&module), Blanks::Dash, true),
                    (Scope::blank(&module), Blanks::Names, true),
                    // An entry that keeps nothing yet: a list with no
                    // items draws nothing of its own.
                    (Scope::empty(), Blanks::Dash, false),
                ] {
                    let host = Host {
                        module: Some(module.clone()),
                        values,
                        size: size_,
                        blanks,
                    };
                    let (_, vcx) = cx.add_window_view(move |_, _| host);
                    vcx.simulate_resize(size(px(800.0), px(900.0)));
                    draw(vcx);
                    let bounds = vcx
                        .debug_bounds("look")
                        .unwrap_or_else(|| panic!("{} {size_:?} is drawn", module.name));
                    assert!(
                        !room || bounds.size.height > px(0.0),
                        "{} {size_:?} {appearance:?} {blanks:?} takes room",
                        module.name
                    );
                }
            }
        }
    }
}

#[gpui::test]
fn a_broken_copy_is_its_name_alone(cx: &mut TestAppContext) {
    init(cx, Appearance::Light);
    let (_, vcx) = cx.add_window_view(|_, _| Host {
        module: None,
        values: Scope::empty(),
        size: LookSize::Block,
        blanks: Blanks::Dash,
    });
    draw(vcx);
    assert!(vcx.debug_bounds("look").is_some());
}

struct LineHost(Arc<ModuleValue>, Arc<Scope>);

impl Render for LineHost {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(
            div()
                .debug_selector(|| "line".into())
                .w(px(220.0))
                .child(Line::new("line", self.0.clone(), self.1.clone())),
        )
    }
}

#[gpui::test]
fn a_line_draws_without_the_apps_words(cx: &mut TestAppContext) {
    init(cx, Appearance::Dark);
    // Without the App's words a count is said the English way (CR): the
    // list's name, then the number.
    cx.update(|cx| {
        use dr_view_module_look::{AppWords, Words as _};
        assert_eq!(AppWords(cx).count_of(3, "伏笔"), "伏笔: 3");
    });
    for module in dr_testkit::samples::modules() {
        let values = Arc::new(Scope::sample(&module));
        let module = Arc::new(module);
        let (_, vcx) = cx.add_window_view(move |_, _| LineHost(module, values));
        draw(vcx);
        let b = vcx.debug_bounds("line").expect("the line is drawn");
        assert!(b.size.height > px(0.0));
    }
}
