//! How Drifting's marks on the prose look, from the design system's palette
//! and sand masks (docs/design-system/materials.md, 砂笔进正文).
//!
//! gpui-prose paints whatever it is given; this is where Drifting says what
//! that is. Sand is laid on the paper with plain alpha, so its colour is
//! multiplied into the paper beforehand in light themes and lifted toward
//! white in dark ones (`Palette::sand_on`), which gives the old client's
//! `multiply` / `screen` pixels; dark themes also thin prose sand to 0.72.

use std::rc::Rc;

use dr_ui::sand::SandMask;
use dr_ui::tokens::{Palette, Rgb, Story};
use gpui::Hsla;
use gpui_prose::render::{BlockStyle, SandTexture, Strength, Underline, Wash};

thread_local! {
    /// The masks, made once: each keeps its own stretched variants.
    static TEXTURES: Textures = Textures::new();
}

#[derive(Clone)]
struct Textures {
    swash: Rc<SandTexture>,
    swash_hot: Rc<SandTexture>,
    underline: Rc<SandTexture>,
    seals: Vec<Rc<SandTexture>>,
}

impl Textures {
    fn new() -> Textures {
        let mask = |m: SandMask| {
            Rc::new(SandTexture::from_png(m.path(), m.png()).expect("dr-ui's sand masks are PNGs"))
        };
        Textures {
            swash: mask(SandMask::Hl),
            swash_hot: mask(SandMask::HlHot),
            underline: mask(SandMask::Ul),
            seals: [
                SandMask::Blob0,
                SandMask::Blob1,
                SandMask::Blob2,
                SandMask::Blob3,
                SandMask::Blob4,
                SandMask::Blob5,
            ]
            .into_iter()
            .map(mask)
            .collect(),
        }
    }
}

/// Everything the paint layers of one editor need from the theme.
#[derive(Clone)]
pub struct DecorLooks {
    pub dark: bool,
    /// A comment's swash (`--comment`), and a TODO's (`--story-4`, a little
    /// deeper), already laid on the paper.
    pub comment: Hsla,
    pub todo: Hsla,
    /// The TODO keyword's ink.
    pub todo_ink: Hsla,
    /// Entity links (the link colour) and links to something gone.
    pub entity: Hsla,
    pub entity_dead: Hsla,
    /// Find hits.
    pub find: Hsla,
    /// Agent inks: new words, rewritten words, another editor's words.
    pub agent_new: Hsla,
    pub agent_changed: Hsla,
    pub external: Hsla,
    /// Prose sand's strength in this theme (light 1, dark 0.72).
    pub strength: f32,
    pub block: BlockStyle,
    pub reduce_motion: bool,
    textures: Textures,
}

impl DecorLooks {
    /// The looks in `palette`; `link` is the editor's link colour.
    pub fn new(palette: &Palette, link: Hsla, reduce_motion: bool) -> DecorLooks {
        let paper = palette.page;
        let sand = |c: Rgb| palette.sand_on(c, paper).solid();
        let todo = palette.story(Story::S4).mix(palette.ink(1), 0.16);
        // The Agent's inks are the old client's (comments-review.css):
        // story green and purple, deep enough to read on the paper, and a
        // deep blue for edits made in another editor.
        let (agent_new, agent_changed, external) = if palette.dark {
            (
                Rgb::hsl(148.0, 40.0, 66.0),
                Rgb::hsl(252.0, 60.0, 78.0),
                Rgb::hsl(210.0, 72.0, 74.0),
            )
        } else {
            (
                Rgb::hsl(148.0, 42.0, 34.0),
                Rgb::hsl(258.0, 42.0, 52.0),
                Rgb::hsl(214.0, 62.0, 40.0),
            )
        };
        DecorLooks {
            dark: palette.dark,
            comment: sand(palette.comment),
            todo: sand(todo),
            todo_ink: todo.solid(),
            entity: link,
            entity_dead: palette.muted().solid(),
            find: palette.accent.solid(),
            agent_new: agent_new.solid(),
            agent_changed: agent_changed.solid(),
            external: external.solid(),
            strength: if palette.dark { 0.72 } else { 1.0 },
            block: block_style(palette),
            reduce_motion,
            textures: TEXTURES.with(Textures::clone),
        }
    }

    /// A comment's swash at rest 0.27, pointed at 0.61.
    pub fn comment_wash(&self) -> Wash {
        self.swash(self.comment, Strength::new(0.27, 0.61))
    }

    /// A TODO's swash at rest 0.29, pointed at 0.66.
    pub fn todo_wash(&self) -> Wash {
        self.swash(self.todo, Strength::new(0.29, 0.66))
    }

    fn swash(&self, color: Hsla, s: Strength) -> Wash {
        Wash::sand(
            self.textures.swash.clone(),
            Some(self.textures.swash_hot.clone()),
            color,
            Strength::new(s.rest * self.strength, s.hot * self.strength),
        )
    }

    /// An entity link's dry underline: 0.7, under the pointer 0.95.
    pub fn entity_underline(&self, alive: bool) -> Underline {
        if alive {
            Underline::sand(
                self.textures.underline.clone(),
                self.entity,
                Strength::new(0.7, 0.95),
            )
        } else {
            Underline::sand(
                self.textures.underline.clone(),
                self.entity_dead,
                Strength::new(0.5, 0.6),
            )
        }
    }

    /// A suggested link: only the grains of the stroke.
    pub fn suggestion(&self) -> Underline {
        Underline::dotted(self.entity, Strength::new(0.55, 0.85))
    }

    /// Find hits: the accent at 0.16, the current one 0.34.
    pub fn find_wash(&self) -> Wash {
        Wash::flat(self.find, Strength::new(0.16, 0.34))
    }

    /// The scrollbar seals (`blob-0..5`).
    pub fn seals(&self) -> Vec<Rc<SandTexture>> {
        self.textures.seals.clone()
    }
}

/// Quotes, rules, lists, code blocks and callouts in `palette`'s inks (the
/// old client's `material-workbench.css`): the one block style the shell and
/// the paint layers both hand the editor.
pub fn block_style(palette: &Palette) -> BlockStyle {
    BlockStyle {
        quote_wash: Some(palette.desk.alpha(if palette.dark { 0.7 } else { 0.5 })),
        quote_ink: Some(palette.ink(2).solid()),
        rule: palette.rule_strong.solid(),
        // Lists (notes): marks in the second ink, a task's box in the rule
        // colour, done in the accent with a paper tick, its text in the
        // muted ink.
        list_ink: Some(palette.ink(2).solid()),
        task_box: palette.rule_strong.solid(),
        task_done: palette.accent.solid(),
        task_tick: palette.page.solid(),
        task_done_ink: Some(palette.muted().solid()),
        // Code (notes): on the paper's deeper tone, in the first ink.
        code_wash: Some(palette.desk.solid()),
        code_ink: Some(palette.ink(1).solid()),
        // Callouts (notes): a washed aside with a faint edge, both the
        // accent.
        callout_wash: Some(palette.accent.alpha(0.09)),
        callout_edge: Some(palette.accent.alpha(0.18)),
        // Washes keep the design system's small corner.
        block_radius: gpui::px(dr_ui::tokens::radius::MD),
        ..BlockStyle::default()
    }
}
