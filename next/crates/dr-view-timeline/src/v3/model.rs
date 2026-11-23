//! A v3 timeline has no manuscript axis or synthetic lanes.
use dr_shell::book::v3::BookV3;
use dr_workspace::commands::v3::types::{
    EntryTemplate, FieldValue, TimelinePlacement, TimelineView,
};
use gpui::{Font, Hsla, Pixels, SharedString, TextRun, Window};
use std::collections::{BTreeMap, BTreeSet};

/// How wide a card without a span is drawn; the kernel places entries at the
/// end of the scale after it (`dr_model::v3::timeline_scale_end`).
pub const DEFAULT_SPAN: f64 = dr_model::v3::DEFAULT_PLACEMENT_SPAN;
pub const SHORT_ACT_SPAN: f64 = 0.9;
/// The lane-name column in the bar (`W9Bottom`: `nameW` 96).
pub const RAIL: f32 = 96.0;
/// The lane-name column while the bottom panel fills (`W9Bottom`: 140).
pub const FILLED_RAIL: f32 = 140.0;
pub const HEAD: f32 = 30.0;
pub const RULER: f32 = 40.0;
pub const ROW: f32 = 36.0;
pub const FILLED_ROW: f32 = 76.0;
/// The narrowest card (`W9Bottom`: 14); it is wider when the title's first
/// character needs it ([`card_min_width`]).
pub const MIN_CARD: f32 = 14.0;

/// Units of the scale between two ticks of the ruler: one cell (`格`) of
/// `W9Bottom`'s scale.
pub const TICK: f64 = 5.0;

/// How the timeline is spread out: `step` px between two ticks of the
/// ruler (one `格` of `W9Bottom`, [`TICK`] units of the scale), `band` px
/// for one lane. The bar and the filled panel each keep their own
/// (`W9Bottom`: `zb`, `zf`), each pinched on its own.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Scale {
    pub step: f32,
    pub band: f32,
}

impl Scale {
    /// Px for one unit of the scale.
    pub fn unit(self) -> f32 {
        self.step / TICK as f32
    }

    /// Between `self` (at 0) and `to` (at 1).
    pub fn toward(self, to: Scale, t: f32) -> Scale {
        Scale {
            step: self.step + (to.step - self.step) * t,
            band: self.band + (to.band - self.band) * t,
        }
    }

    /// Kept within [`STEP_RANGE`] and [`BAND_RANGE`].
    pub fn clamped(self) -> Scale {
        Scale {
            step: self.step.clamp(STEP_RANGE.0, STEP_RANGE.1),
            band: self.band.clamp(BAND_RANGE.0, BAND_RANGE.1),
        }
    }
}

/// The bar's scale at first (`W9Bottom` `zb`: 24 px a tick, 36 a lane).
pub const BAR: Scale = Scale {
    step: 24.0,
    band: ROW,
};
/// The filled panel's scale at first (`W9Bottom` `zf`: 100 px a tick, 76 a
/// lane).
pub const FILLED: Scale = Scale {
    step: 100.0,
    band: FILLED_ROW,
};
/// How far a tick can be pinched (`W9Bottom`: 12–200 px).
pub const STEP_RANGE: (f32, f32) = (12.0, 200.0);
/// How far a lane can be pinched (`W9Bottom`: 28–140 px).
pub const BAND_RANGE: (f32, f32) = (28.0, 140.0);

#[derive(Clone, Debug)]
pub struct Lane {
    pub id: String,
    pub title: String,
    pub color: Option<String>,
    pub act_track: bool,
    pub members: usize,
    pub clips: Vec<TimelinePlacement>,
}

pub fn lanes(book: &BookV3, view: &TimelineView) -> Vec<Lane> {
    let mut membership: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for m in &book.memberships {
        membership.entry(&m.host).or_default().insert(&m.member);
    }
    let mut out: Vec<Lane> = view
        .lanes
        .iter()
        .filter_map(|l| {
            let e = book.entry(&l.entry).filter(|e| e.deleted_at.is_none())?;
            // A lane takes entries from elsewhere and holds what is hung on
            // it; what only lives under it is not on it (DV, 2026-11-16).
            if !book.accepts_members(&l.entry) {
                return None;
            }
            let mut in_lane: BTreeSet<&str> = BTreeSet::new();
            if let Some(ms) = membership.get(l.entry.as_str()) {
                for &m in ms {
                    if book.entry(m).is_some_and(|me| me.deleted_at.is_none()) {
                        in_lane.insert(m);
                    }
                }
            }
            let clips = view
                .placements
                .iter()
                .filter(|p| in_lane.contains(p.entry.as_str()))
                .cloned()
                .collect();
            Some(Lane {
                id: l.entry.clone(),
                title: e.title.clone(),
                color: book.appearance(&e.id).and_then(|a| a.color),
                act_track: l.act_track == Some(true),
                members: in_lane.len(),
                clips,
            })
        })
        .collect();
    out.sort_by_key(|l| !l.act_track);
    out
}

/// Live templates whose new entries can serve as swimlanes: those whose
/// entries take entries from elsewhere by default (`settings.accept ==
/// Some(true)`, DV 2026-11-16; a template with only its level on is not one),
/// recognized by template data rather than ID.
pub fn lane_templates(book: &BookV3) -> Vec<&EntryTemplate> {
    book.templates
        .iter()
        .filter(|t| t.deleted_at.is_none() && t.settings.accept == Some(true))
        .collect()
}

/// Dropping a lane from a view retains its entry and memberships. Only
/// positions without any of this view's remaining lanes are removed.
pub fn remove_lane(
    view: &mut TimelineView,
    lane: &str,
    memberships: &[dr_workspace::commands::v3::types::Membership],
) {
    view.lanes.retain(|l| l.entry != lane);
    let hosts: BTreeSet<_> = view.lanes.iter().map(|l| l.entry.as_str()).collect();
    let members: BTreeSet<_> = memberships
        .iter()
        .filter(|m| hosts.contains(m.host.as_str()))
        .map(|m| m.member.as_str())
        .collect();
    view.placements
        .retain(|p| members.contains(p.entry.as_str()));
}

pub fn extent(view: &TimelineView) -> (f64, f64) {
    let min = view
        .placements
        .iter()
        .map(|p| p.at)
        .chain(view.pins.iter().map(|p| p.at))
        .fold(0.0, f64::min)
        .floor();
    let max = view
        .placements
        .iter()
        .map(|p| p.at + p.span.unwrap_or(DEFAULT_SPAN))
        .chain(view.pins.iter().map(|p| p.at))
        .fold(40.0, f64::max)
        .ceil()
        + 12.0;
    (min, max)
}

/// Extracts the configured summary text field of `entry_id`, if non-empty.
pub fn entry_summary(book: &BookV3, entry_id: &str) -> Option<String> {
    let entry = book.entry(entry_id)?;
    let tpl = book.template_of(entry_id)?;
    for m in &tpl.modules {
        if m.kind != "fields" {
            continue;
        }
        let Some(fmap) = entry.fields.get(&m.id) else {
            continue;
        };
        if let Some(sf) = m.config.summary_field.as_ref()
            && let Some(FieldValue::Text(s)) = fmap.get(sf)
        {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_owned());
            }
        }
    }
    None
}

/// The narrowest a card titled `title` may be drawn: its first whole
/// character with `pad_x` on each side, and never under [`MIN_CARD`]
/// (`kernel-v5.md` §17: the narrowest card still shows the title's first
/// whole characters).
pub fn card_min_width(
    title: &str,
    pad_x: f32,
    font_size: Pixels,
    font: Font,
    window: &Window,
) -> f32 {
    let Some(first) = title.chars().next() else {
        return MIN_CARD;
    };
    let text = SharedString::from(first.to_string());
    let run = TextRun {
        len: text.len(),
        font,
        color: Hsla::transparent_black(),
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    let line = window
        .text_system()
        .layout_line(&text, font_size, &[run], None);
    (f32::from(line.width).ceil() + 2.0 * pad_x).max(MIN_CARD)
}

/// Returns the longest prefix of whole characters in `title` whose laid-out
/// width fits within `avail_w` (`kernel-v5.md` §17, `v5-tracks.md` T9.6:
/// narrowest cards show whole leading characters without half-glyph clipping
/// and without `…`).
pub fn slice_whole_chars(
    title: &str,
    avail_w: f32,
    font_size: Pixels,
    font: Font,
    window: &Window,
) -> String {
    if title.is_empty() || avail_w <= 2.0 {
        return String::new();
    }
    let shared = SharedString::from(title.to_owned());
    let run = TextRun {
        len: shared.len(),
        font,
        color: Hsla::transparent_black(),
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    let line = window
        .text_system()
        .layout_line(&shared, font_size, &[run], None);
    if f32::from(line.width) <= avail_w + 0.5 {
        return title.to_owned();
    }
    let mut end = 0;
    for (idx, ch) in title.char_indices() {
        let next = idx + ch.len_utf8();
        if f32::from(line.x_for_index(next)) <= avail_w + 0.5 {
            end = next;
        } else {
            break;
        }
    }
    title[..end].to_owned()
}
