//! A v3 timeline has no manuscript axis or synthetic lanes.
use dr_shell::book::v3::BookV3;
use dr_workspace::commands::v3::types::{TimelinePlacement, TimelineView};
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
            if !book.is_lane(&l.entry) {
                return None;
            }
            let members = membership.get(l.entry.as_str());
            let clips = view
                .placements
                .iter()
                .filter(|p| {
                    members.is_some_and(|ms| ms.contains(p.entry.as_str()))
                        && book.entry(&p.entry).is_some_and(|e| e.deleted_at.is_none())
                })
                .cloned()
                .collect();
            Some(Lane {
                id: l.entry.clone(),
                title: e.title.clone(),
                color: book.appearance(&e.id).and_then(|a| a.color),
                act_track: l.act_track == Some(true),
                members: members.map_or(0, BTreeSet::len),
                clips,
            })
        })
        .collect();
    out.sort_by_key(|l| !l.act_track);
    out
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
