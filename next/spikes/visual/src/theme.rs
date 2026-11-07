//! The colour tokens the prototype needs, copied from the renderer's
//! `src/styles/index.css` and `src/styles/materials.css` (light and dark).

use gpui::{Hsla, Rgba};

/// An sRGB colour, 0–1 per channel, straight alpha.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgb {
    pub r: f32,
    pub g: f32,
    pub b: f32,
}

impl Rgb {
    pub const WHITE: Rgb = Rgb {
        r: 1.0,
        g: 1.0,
        b: 1.0,
    };

    pub fn hex(value: u32) -> Rgb {
        Rgb {
            r: ((value >> 16) & 0xff) as f32 / 255.0,
            g: ((value >> 8) & 0xff) as f32 / 255.0,
            b: (value & 0xff) as f32 / 255.0,
        }
    }

    /// CSS `hsl(h s% l%)`.
    pub fn hsl(h: f32, s: f32, l: f32) -> Rgb {
        let s = s / 100.0;
        let l = l / 100.0;
        let q = if l < 0.5 {
            l * (1.0 + s)
        } else {
            l + s - l * s
        };
        let p = 2.0 * l - q;
        let channel = |t: f32| {
            let t = t.rem_euclid(1.0);
            if t < 1.0 / 6.0 {
                p + (q - p) * 6.0 * t
            } else if t < 0.5 {
                q
            } else if t < 2.0 / 3.0 {
                p + (q - p) * (2.0 / 3.0 - t) * 6.0
            } else {
                p
            }
        };
        let h = h / 360.0;
        Rgb {
            r: channel(h + 1.0 / 3.0),
            g: channel(h),
            b: channel(h - 1.0 / 3.0),
        }
    }

    /// `color-mix(in srgb, self, other t)`: `t` of `other`.
    pub fn mix(self, other: Rgb, t: f32) -> Rgb {
        Rgb {
            r: self.r + (other.r - self.r) * t,
            g: self.g + (other.g - self.g) * t,
            b: self.b + (other.b - self.b) * t,
        }
    }

    /// Channel by channel, as `mix-blend-mode: multiply` lays a colour on a flat ground.
    pub fn multiply(self, other: Rgb) -> Rgb {
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
        [
            (self.r.clamp(0.0, 1.0) * 255.0 + 0.5) as u8,
            (self.g.clamp(0.0, 1.0) * 255.0 + 0.5) as u8,
            (self.b.clamp(0.0, 1.0) * 255.0 + 0.5) as u8,
        ]
    }
}

#[derive(Clone, Debug)]
pub struct Theme {
    pub dark: bool,
    pub paper_deep: Rgb,
    pub paper: Rgb,
    pub page: Rgb,
    pub ink: [Rgb; 6],
    pub rule: Rgb,
    pub accent: Rgb,
    pub comment: Rgb,
    pub destructive: Rgb,
    pub story: [Rgb; 6],
    pub glass_clear: Rgb,
    /// How far a glass bleed is lifted toward white (`--glass-bleed-lift`).
    pub bleed_lift: f32,
    /// Shadow colour and the strengths of the page and menu shadows.
    pub shadow_ink: Rgb,
    pub page_shadow: (f32, f32),
    pub menu_shadow: f32,
    /// Sand: opacity, and how far its colour is lifted toward white in the dark.
    pub pigment: f32,
    pub pigment_lift: f32,
}

impl Theme {
    pub fn light() -> Theme {
        Theme {
            dark: false,
            paper_deep: Rgb::hsl(40.0, 9.0, 94.5),
            paper: Rgb::hsl(42.0, 14.0, 97.0),
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
            accent: Rgb::hsl(218.0, 22.0, 52.0),
            comment: Rgb::hsl(18.0, 55.0, 57.0),
            destructive: Rgb::hsl(14.0, 55.0, 38.0),
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
        }
    }

    pub fn dark() -> Theme {
        Theme {
            dark: true,
            paper_deep: Rgb::hsl(220.0, 6.0, 11.5),
            paper: Rgb::hsl(220.0, 6.0, 12.5),
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
            accent: Rgb::hsl(218.0, 35.0, 65.0),
            comment: Rgb::hsl(20.0, 58.0, 66.0),
            destructive: Rgb::hsl(14.0, 45.0, 50.0),
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
            shadow_ink: Rgb {
                r: 0.0,
                g: 0.0,
                b: 0.0,
            },
            page_shadow: (0.28, 0.55),
            menu_shadow: 0.62,
            pigment: 0.85,
            pigment_lift: 0.14,
        }
    }

    pub fn get(dark: bool) -> Theme {
        if dark { Theme::dark() } else { Theme::light() }
    }

    /// The colour a sand mask is drawn in over a flat `ground`, so plain alpha
    /// blending gives what the renderer's `.sand` does: `multiply` on the
    /// light paper, a lifted colour laid on in the dark.
    pub fn sand_on(&self, color: Rgb, ground: Rgb) -> Rgb {
        if self.dark {
            color.mix(Rgb::WHITE, self.pigment_lift)
        } else {
            color.multiply(ground)
        }
    }
}
