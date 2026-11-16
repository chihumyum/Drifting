//! A v3 timeline has no manuscript axis or synthetic lanes.
use dr_shell::book::v3::BookV3;
use dr_workspace::commands::v3::types::{
    EntryTemplate, FieldValue, TimelinePlacement, TimelineView,
};
use gpui::{Font, Hsla, Pixels, SharedString, TextRun, Window};
use std::collections::{BTreeMap, BTreeSet};

pub const UNIT: f32 = 20.0;
pub const DEFAULT_SPAN: f64 = 4.0;
pub const SHORT_ACT_SPAN: f64 = 0.9;
pub const RAIL: f32 = 148.0;
pub const HEAD: f32 = 30.0;
pub const RULER: f32 = 40.0;
pub const ROW: f32 = 36.0;

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
