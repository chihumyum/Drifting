//! Colour tokens, light and dark, copied from the renderer's
//! `src/styles/index.css` (`:root` and `.dark`), `materials.css` and
//! `desktop-typography.css`. Every value is a compile-time constant; a view
//! reads them through [`Palette`] (see `theme.rs`), never by name.

use gpui::{Hsla, Rgba};

/// An sRGB colour, 0–1 per channel, straight alpha applied when it is drawn.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgb {
    pub r: f32,
    pub g: f32,
    pub b: f32,
}

impl Rgb {
    pub const WHITE: Rgb = Rgb::new(1.0, 1.0, 1.0);
    pub const BLACK: Rgb = Rgb::new(0.0, 0.0, 0.0);

    pub const fn new(r: f32, g: f32, b: f32) -> Rgb {
        Rgb { r, g, b }
    }

    /// `#rrggbb`.
    pub const fn hex(value: u32) -> Rgb {
        Rgb {
            r: ((value >> 16) & 0xff) as f32 / 255.0,
            g: ((value >> 8) & 0xff) as f32 / 255.0,
            b: (value & 0xff) as f32 / 255.0,
        }
    }

    /// CSS `hsl(h s% l%)`, as the renderer's tokens are written.
    pub const fn hsl(h: f32, s: f32, l: f32) -> Rgb {
        let s = s / 100.0;
        let l = l / 100.0;
        let q = if l < 0.5 {
            l * (1.0 + s)
        } else {
            l + s - l * s
        };
        let p = 2.0 * l - q;
        let h = h / 360.0;
        Rgb {
            r: hue(p, q, h + 1.0 / 3.0),
            g: hue(p, q, h),
            b: hue(p, q, h - 1.0 / 3.0),
        }
    }

    /// `color-mix(in srgb, self, other t)`: `t` of `other`.
    pub const fn mix(self, other: Rgb, t: f32) -> Rgb {
        Rgb {
            r: self.r + (other.r - self.r) * t,
            g: self.g + (other.g - self.g) * t,
            b: self.b + (other.b - self.b) * t,
        }
    }

    /// Channel by channel: how `mix-blend-mode: multiply` lays a colour on a
    /// flat ground.
    pub const fn multiply(self, other: Rgb) -> Rgb {
        Rgb {
            r: self.r * other.r,
            g: self.g * other.g,
            b: self.b * other.b,
        }
    }

    pub fn alpha(self, a: f32) -> Hsla {
        Rgba {
            r: self.r,
            g: self.g,
            b: self.b,
            a: a.clamp(0.0, 1.0),
        }
        .into()
    }

    pub fn solid(self) -> Hsla {
        self.alpha(1.0)
    }

    pub fn to_u8(self) -> [u8; 3] {
        let c = |v: f32| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        [c(self.r), c(self.g), c(self.b)]
    }

    /// Relative luminance (WCAG), for picking ink on a coloured ground.
    pub fn luminance(self) -> f32 {
        let lin = |c: f32| {
            if c <= 0.039_28 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * lin(self.r) + 0.7152 * lin(self.g) + 0.0722 * lin(self.b)
    }
}

const fn hue(p: f32, q: f32, t: f32) -> f32 {
    let t = if t < 0.0 {
        t + 1.0
    } else if t > 1.0 {
        t - 1.0
    } else {
        t
    };
    if t < 1.0 / 6.0 {
        p + (q - p) * 6.0 * t
    } else if t < 0.5 {
        q
    } else if t < 2.0 / 3.0 {
        p + (q - p) * (2.0 / 3.0 - t) * 6.0
    } else {
        p
    }
}

/// The six storyline colours (`--story-1` … `--story-6`), also the element
/// kinds' colours (`--el-person` = 1, place = 3, item = 4, period = 2, lex = 5).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Story {
    S1,
    S2,
    S3,
    S4,
    S5,
    S6,
}

impl Story {
    pub const ALL: [Story; 6] = [
        Story::S1,
        Story::S2,
        Story::S3,
        Story::S4,
        Story::S5,
        Story::S6,
    ];

    pub const fn index(self) -> usize {
        self as usize
    }
}

/// Every colour a view paints with in one appearance.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Palette {
    pub dark: bool,
    /// `--paper-deep`: the desk. Sidebars, the timeline dock, menus, hover
    /// cards and dialogs (`--workspace-ui-bg`, `--menu-surface-bg`).
    pub desk: Rgb,
    /// `--paper`: the slightly lighter rail under the timeline's acts.
    pub paper: Rgb,
    /// `--surface`.
    pub surface: Rgb,
    /// `--page`: the manuscript page, the one raised work surface, and the
    /// fill of floating glass and of fields.
    pub page: Rgb,
    /// `--ink-1` … `--ink-6`, darkest (light theme) first.
    pub ink: [Rgb; 6],
    /// `--rule`, `--rule-strong`.
    pub rule: Rgb,
    pub rule_strong: Rgb,
    /// `--accent` and the ink laid on it (`--accent-foreground`).
    pub accent: Rgb,
    pub accent_ink: Rgb,
    /// `--comment`: a comment's sand.
    pub comment: Rgb,
    /// `--destructive`.
    pub danger: Rgb,
    pub story: [Rgb; 6],
    /// `--glass-clear`: glass that belongs to nothing.
    pub glass_clear: Rgb,
    /// `--glass-bleed-lift`: how far a bleed is lifted toward white.
    pub bleed_lift: f32,
    /// `--shadow-ink`: ink in the light, black in the dark.
    pub shadow_ink: Rgb,
    /// `--page-elevation`: the 1px edge and the soft fall under the page.
    pub page_shadow: (f32, f32),
    /// `--menu-shadow` strength.
    pub menu_shadow: f32,
    /// `--pigment` (sand opacity) and `--pigment-lift` (dark themes lift sand
    /// toward white instead of multiplying it into the ground).
    pub pigment: f32,
    pub pigment_lift: f32,
    /// The mist behind a dialog: the desk at this strength.
    pub dialog_mist: f32,
}

impl Palette {
    pub const LIGHT: Palette = Palette {
        dark: false,
        desk: Rgb::hsl(40.0, 9.0, 94.5),
        paper: Rgb::hsl(42.0, 14.0, 97.0),
        surface: Rgb::hsl(0.0, 0.0, 100.0),
        page: Rgb::hsl(45.0, 30.0, 99.5),
        ink: [
            Rgb::hsl(30.0, 6.0, 12.0),
            Rgb::hsl(30.0, 4.0, 26.0),
            Rgb::hsl(30.0, 3.0, 48.0),
            Rgb::hsl(30.0, 3.0, 64.0),
            Rgb::hsl(30.0, 4.0, 84.0),
            Rgb::hsl(30.0, 5.0, 89.0),
        ],
        rule: Rgb::hsl(30.0, 6.0, 92.0),
        rule_strong: Rgb::hsl(30.0, 6.0, 84.0),
        accent: Rgb::hsl(218.0, 22.0, 52.0),
        accent_ink: Rgb::hsl(0.0, 0.0, 100.0),
        comment: Rgb::hsl(18.0, 55.0, 57.0),
        danger: Rgb::hsl(14.0, 55.0, 38.0),
        story: [
            Rgb::hsl(252.0, 62.0, 72.0),
            Rgb::hsl(208.0, 70.0, 66.0),
            Rgb::hsl(148.0, 38.0, 60.0),
            Rgb::hsl(45.0, 82.0, 66.0),
            Rgb::hsl(282.0, 50.0, 72.0),
            Rgb::hsl(182.0, 42.0, 58.0),
        ],
        glass_clear: Rgb::hex(0xb4b6ae),
        bleed_lift: 0.0,
        shadow_ink: Rgb::hsl(30.0, 6.0, 12.0),
        page_shadow: (0.05, 0.13),
        menu_shadow: 0.38,
        pigment: 0.85,
        pigment_lift: 0.0,
        dialog_mist: 0.58,
    };

    pub const DARK: Palette = Palette {
        dark: true,
        desk: Rgb::hsl(220.0, 6.0, 11.5),
        paper: Rgb::hsl(220.0, 6.0, 12.5),
        surface: Rgb::hsl(220.0, 6.0, 14.0),
        page: Rgb::hsl(220.0, 6.0, 14.0),
        ink: [
            Rgb::hsl(220.0, 8.0, 93.0),
            Rgb::hsl(220.0, 6.0, 82.0),
            Rgb::hsl(220.0, 5.0, 62.0),
            Rgb::hsl(220.0, 4.0, 48.0),
            Rgb::hsl(220.0, 5.0, 28.0),
            Rgb::hsl(220.0, 5.0, 22.0),
        ],
        rule: Rgb::hsl(220.0, 6.0, 22.0),
        rule_strong: Rgb::hsl(220.0, 6.0, 30.0),
        accent: Rgb::hsl(218.0, 35.0, 65.0),
        accent_ink: Rgb::hsl(220.0, 6.0, 11.0),
        comment: Rgb::hsl(20.0, 58.0, 66.0),
        danger: Rgb::hsl(14.0, 45.0, 50.0),
        story: [
            Rgb::hsl(252.0, 50.0, 74.0),
            Rgb::hsl(208.0, 58.0, 68.0),
            Rgb::hsl(148.0, 34.0, 62.0),
            Rgb::hsl(45.0, 68.0, 68.0),
            Rgb::hsl(282.0, 44.0, 74.0),
            Rgb::hsl(182.0, 38.0, 60.0),
        ],
        glass_clear: Rgb::hex(0x6b6d67),
        bleed_lift: 0.45,
        shadow_ink: Rgb::BLACK,
        page_shadow: (0.28, 0.55),
        menu_shadow: 0.62,
        pigment: 0.85,
        pigment_lift: 0.14,
        dialog_mist: 0.58,
    };

    /// `--ink-1` … `--ink-6` by number, as the renderer names them.
    pub const fn ink(&self, n: usize) -> Rgb {
        self.ink[n - 1]
    }

    pub const fn story(&self, story: Story) -> Rgb {
        self.story[story.index()]
    }

    /// `--ui-text-muted`: readable secondary text.
    pub const fn muted(&self) -> Rgb {
        self.ink[2].mix(self.ink[1], 0.4)
    }

    /// The hairline of a top-level module (`--workspace-border`, also
    /// `--menu-separator`): ink at 14%.
    pub fn hairline(&self) -> Hsla {
        self.ink[0].alpha(0.14)
    }

    /// `--workspace-local-border`: ink at 12%.
    pub fn local_hairline(&self) -> Hsla {
        self.ink[0].alpha(0.12)
    }

    /// `--workspace-subtle-border`: ink at 7%.
    pub fn subtle_hairline(&self) -> Hsla {
        self.ink[0].alpha(0.07)
    }

    /// The colour sand is drawn in over a flat `ground`, so plain alpha
    /// blending gives what the renderer's `.sand` does: `multiply` on the
    /// light paper, a lifted colour laid on in the dark. GPUI has no blend
    /// modes; on a flat ground the two agree exactly.
    pub const fn sand_on(&self, color: Rgb, ground: Rgb) -> Rgb {
        if self.dark {
            color.mix(Rgb::WHITE, self.pigment_lift)
        } else {
            color.multiply(ground)
        }
    }

    /// The bleed colour of a glass rim in `color` (dark themes lift it).
    pub const fn bleed(&self, color: Rgb) -> Rgb {
        color.mix(Rgb::WHITE, self.bleed_lift)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: Rgb, b: [u8; 3]) {
        let got = a.to_u8();
        for (g, w) in got.iter().zip(b) {
            assert!((*g as i32 - w as i32).abs() <= 1, "{got:?} vs {b:?}");
        }
    }

    #[test]
    fn hsl_matches_the_css_values() {
        // hsl(40 9% 94.5%) is the light desk: #f3f2ef in a browser.
        close(Palette::LIGHT.desk, [0xf3, 0xf2, 0xef]);
        // hsl(220 6% 11.5%), the dark desk: #1b1c1f.
        close(Palette::DARK.desk, [0x1b, 0x1c, 0x1f]);
        // hsl(218 22% 52%), the light accent: #6a7da0.
        close(Palette::LIGHT.accent, [0x6a, 0x7d, 0xa0]);
        close(Rgb::hsl(0.0, 0.0, 100.0), [255, 255, 255]);
    }

    #[test]
    fn sand_multiplies_on_light_and_lifts_on_dark() {
        let story = Palette::LIGHT.story[0];
        let on = Palette::LIGHT.sand_on(story, Palette::LIGHT.page);
        assert!(on.r <= story.r && on.g <= story.g && on.b <= story.b);
        let lifted = Palette::DARK.sand_on(story, Palette::DARK.page);
        assert!(lifted.r >= story.r && lifted.g >= story.g);
    }
}
