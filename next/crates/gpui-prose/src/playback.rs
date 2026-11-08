//! Post-commit playback. Only `refresh_chapter` can start it, from events
//! already applied by the source. It never queues writes or changes prose.
//! Layout, hit testing, copying and accessibility always use the full commit;
//! the painter alone reveals graphemes over a clipped copy of the old ink.

use std::{
    ops::Range,
    time::{Duration, Instant},
};

use gpui::{Context, SharedString, Task, TextRun};

use crate::{
    ProseEditor,
    text::{ChangeSet, Line, segment},
};

/// Opt-in for a source's committed origin prefix (for example `agent:`).
/// Empty prefixes disable playback. Mixed-origin batches and resyncs settle
/// immediately, so an author's concurrent edit is never animated as a tool's.
#[derive(Clone, Debug)]
pub struct CommitPlaybackOptions {
    pub origin_prefix: String,
    pub grapheme_interval: Duration,
    pub max_duration: Duration,
}

impl CommitPlaybackOptions {
    pub fn new(origin_prefix: impl Into<String>) -> Self {
        Self {
            origin_prefix: origin_prefix.into(),
            grapheme_interval: Duration::from_millis(24),
            max_duration: Duration::from_millis(1200),
        }
    }
}

/// Progress in the committed document's scalar coordinates. Selection never
/// follows this frontier; it stays where the actual commit moved it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitPlaybackStatus {
    pub chapter: usize,
    pub range: Range<usize>,
    pub revealed_to: usize,
    pub graphemes: usize,
    pub revealed_graphemes: usize,
}

#[derive(Default)]
pub(crate) struct PlaybackState {
    pub options: Option<CommitPlaybackOptions>,
    active: Option<Playback>,
    timer: Option<Task<()>>,
}

struct Playback {
    chapter: usize,
    before: Vec<Line>,
    old_range: Range<usize>,
    new_range: Range<usize>,
    first_old_line: usize,
    first_new_line: usize,
    /// Scalar boundaries, including the start and end.
    boundaries: Vec<usize>,
    started: Instant,
    duration: Duration,
}

pub(crate) struct ParagraphPlayback {
    pub hidden: Range<usize>,
    pub old: Option<OldInk>,
}

pub(crate) struct OldInk {
    pub text: SharedString,
    pub runs: Vec<TextRun>,
    pub visible: Range<usize>,
}

impl PlaybackState {
    pub fn cancel(&mut self) -> bool {
        self.timer = None;
        self.active.take().is_some()
    }
}

impl Playback {
    fn status(&self, now: Instant) -> CommitPlaybackStatus {
        let count = self.boundaries.len() - 1;
        let elapsed = now.saturating_duration_since(self.started);
        let revealed = if elapsed >= self.duration {
            count
        } else {
            (elapsed.as_secs_f64() / self.duration.as_secs_f64() * count as f64) as usize
        };
        CommitPlaybackStatus {
            chapter: self.chapter,
            range: self.new_range.clone(),
            revealed_to: self.boundaries[revealed],
            graphemes: count,
            revealed_graphemes: revealed,
        }
    }
}

fn plain(lines: &[Line]) -> String {
    lines
        .iter()
        .map(|l| l.text.as_ref())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The smallest single replacement at whole-grapheme boundaries. Disjoint
/// edits in the same committed batch play together, without replaying writes.
fn replacement(before: &str, after: &str) -> (Range<usize>, Range<usize>, Vec<usize>) {
    let old = segment::grapheme_boundaries(before);
    let new = segment::grapheme_boundaries(after);
    let a: Vec<_> = old.windows(2).map(|w| &before[w[0]..w[1]]).collect();
    let b: Vec<_> = new.windows(2).map(|w| &after[w[0]..w[1]]).collect();
    let prefix = a.iter().zip(&b).take_while(|(a, b)| a == b).count();
    let suffix = a[prefix..]
        .iter()
        .rev()
        .zip(b[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let old_bytes = old[prefix]..old[a.len() - suffix];
    let new_bytes = new[prefix]..new[b.len() - suffix];
    let start = after[..new_bytes.start].chars().count();
    let old_end = start + before[old_bytes].chars().count();
    let mut at = start;
    let mut boundaries = vec![at];
    for cluster in &b[prefix..b.len() - suffix] {
        at += cluster.chars().count();
        boundaries.push(at);
    }
    (start..old_end, start..at, boundaries)
}

fn line_at(lines: &[Line], offset: usize) -> usize {
    let mut start = 0;
    for (ix, line) in lines.iter().enumerate() {
        if offset <= start + line.chars {
            return ix;
        }
        start += line.chars + 1;
    }
    lines.len().saturating_sub(1)
}

impl ProseEditor {
    /// Enables playback for future external commits. Opening a document or
    /// changing this option never replays history. The host still refreshes
    /// the editor on its ordinary source notification; no settlement or
    /// durable write waits for this animation.
    pub fn set_commit_playback(
        &mut self,
        options: Option<CommitPlaybackOptions>,
        cx: &mut Context<Self>,
    ) {
        self.finish_commit_playback(cx);
        self.playback.options = options.filter(|o| !o.origin_prefix.is_empty());
    }

    pub fn commit_playback(&self, cx: &gpui::App) -> Option<CommitPlaybackStatus> {
        self.playback
            .active
            .as_ref()
            .map(|p| p.status(cx.background_executor().now()))
    }

    /// Reveals the entire committed result immediately, without a write or
    /// undo step. Input, selection changes, blur and later commits do this.
    pub fn finish_commit_playback(&mut self, cx: &mut Context<Self>) {
        if self.playback.cancel() {
            cx.notify();
        }
    }

    pub(crate) fn play_commit(
        &mut self,
        chapter: usize,
        before: Vec<Line>,
        changes: &[ChangeSet],
        cx: &mut Context<Self>,
    ) {
        if changes.is_empty() {
            return;
        }
        let Some(options) = &self.playback.options else {
            return;
        };
        if self.paint.reduce_motion
            || self.composition.is_some()
            || options.grapheme_interval.is_zero()
            || options.max_duration.is_zero()
            || changes
                .iter()
                .any(|c| c.origin == "resync" || !c.origin.starts_with(&options.origin_prefix))
        {
            return;
        }
        let after = self.book.chapters[chapter].doc.lines();
        let (old_range, new_range, boundaries) = replacement(&plain(&before), &plain(after));
        // Deletion/formatting has no new glyphs to reveal. It is already real.
        if new_range.is_empty() {
            return;
        }
        let duration = options
            .grapheme_interval
            .saturating_mul((boundaries.len() - 1).min(u32::MAX as usize) as u32)
            .min(options.max_duration)
            .min(Duration::from_secs(5));
        let first_old_line = line_at(&before, old_range.start);
        let first_new_line = line_at(after, new_range.start);
        self.playback.cancel();
        self.playback.active = Some(Playback {
            chapter,
            before,
            old_range,
            new_range,
            boundaries,
            first_old_line,
            first_new_line,
            started: cx.background_executor().now(),
            duration,
        });
        self.playback.timer = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(16))
                    .await;
                let done = this.update(cx, |this, cx| {
                    let Some(p) = &this.playback.active else {
                        return true;
                    };
                    let s = p.status(cx.background_executor().now());
                    let done = s.revealed_graphemes == s.graphemes;
                    if done {
                        this.playback.active = None;
                    }
                    cx.notify();
                    done
                });
                if !matches!(done, Ok(false)) {
                    break;
                }
            }
        }));
        cx.notify();
    }

    pub(crate) fn paragraph_playback(
        &self,
        chapter: usize,
        line_ix: usize,
        now: Instant,
    ) -> Option<ParagraphPlayback> {
        let playback = self
            .playback
            .active
            .as_ref()
            .filter(|p| p.chapter == chapter)?;
        let status = playback.status(now);
        let doc = &self.book.chapters[chapter].doc;
        let start = doc.line_start(line_ix);
        let line = doc.line(line_ix);
        let hidden = status.revealed_to.max(start)..status.range.end.min(start + line.chars);
        if hidden.is_empty() {
            return None;
        }
        let hidden = line.byte_of_char(hidden.start - start)..line.byte_of_char(hidden.end - start);
        let old_ix = playback.first_old_line + line_ix.saturating_sub(playback.first_new_line);
        let old = playback.before.get(old_ix).and_then(|old| {
            let start: usize = playback.before[..old_ix].iter().map(|l| l.chars + 1).sum();
            let range =
                playback.old_range.start.max(start)..playback.old_range.end.min(start + old.chars);
            if range.is_empty() {
                return None;
            }
            Some(OldInk {
                text: old.text.clone(),
                runs: self.paragraph_runs(old, &self.block_look(chapter, line_ix)),
                visible: old.byte_of_char(range.start - start)..old.byte_of_char(range.end - start),
            })
        });
        Some(ParagraphPlayback { hidden, old })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Book, Chapter, ProseDoc, ProseStyle, text::BlockKind};
    use gpui::{Entity, EntityInputHandler, TestAppContext, VisualTestContext};

    fn editor(cx: &mut TestAppContext) -> (Entity<ProseEditor>, &mut VisualTestContext) {
        let (editor, cx) = cx.add_window_view(|window, cx| {
            ProseEditor::new(
                Book::new(vec![Chapter {
                    title: "".into(),
                    doc: ProseDoc::from_paragraphs([(BlockKind::Body, "甲乙丙丁")]),
                }]),
                ProseStyle::default(),
                window,
                cx,
            )
        });
        cx.update(|window, _| window.activate_window());
        editor.update_in(cx, |e, window, cx| {
            window.focus(&e.focus, cx);
            e.set_commit_playback(Some(CommitPlaybackOptions::new("agent:")), cx);
        });
        cx.run_until_parked();
        (editor, cx)
    }

    fn write(editor: &Entity<ProseEditor>, text: &str, origin: &str, cx: &mut VisualTestContext) {
        editor.update(cx, |e, cx| {
            let source = e.book.chapters[0].doc.loro_source().unwrap();
            source.loro().set_next_commit_origin(origin);
            source.text().insert(1, text).unwrap();
            source.loro().commit();
            e.refresh_chapter(0, cx);
        });
    }

    #[gpui::test]
    fn playback_is_after_commit_with_full_layout_and_grapheme_frontiers(cx: &mut TestAppContext) {
        let (editor, cx) = editor(cx);
        editor.update(cx, |e, cx| {
            let source = e.book.chapters[0].doc.loro_source().unwrap();
            source.loro().set_next_commit_origin("agent:test");
            source.text().insert(1, "e\u{301}👨‍👩‍👧🇨🇳").unwrap();
            e.refresh_chapter(0, cx);
            assert!(
                e.commit_playback(cx).is_none(),
                "uncommitted input cannot play"
            );
            e.book.chapters[0]
                .doc
                .loro_source()
                .unwrap()
                .loro()
                .commit();
            e.refresh_chapter(0, cx);
        });
        let (frontiers, selection) = editor.update(cx, |e, cx| {
            let state = e.commit_playback(cx).unwrap();
            assert_eq!(state.graphemes, 3);
            assert_eq!(state.revealed_to, 1);
            assert_eq!(
                e.book.chapters[0].doc.plain_text(),
                "甲e\u{301}👨‍👩‍👧🇨🇳乙丙丁\n"
            );
            (
                e.book.chapters[0]
                    .doc
                    .loro_source()
                    .unwrap()
                    .loro()
                    .state_frontiers(),
                e.selection,
            )
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let geometry = editor.read_with(cx, |e, _| {
            let frame = e.frame.borrow();
            let line = frame.get(0, 0).unwrap();
            (line.text.clone(), line.bounds, line.layout.row_count())
        });
        cx.executor().advance_clock(Duration::from_millis(25));
        cx.run_until_parked();
        editor.update(cx, |e, cx| {
            let state = e.commit_playback(cx).unwrap();
            assert_eq!(state.revealed_graphemes, 1);
            assert_eq!(state.revealed_to, 3, "combining sequence is one step");
            assert_eq!(e.selection, selection);
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        editor.read_with(cx, |e, _| {
            let frame = e.frame.borrow();
            let line = frame.get(0, 0).unwrap();
            assert_eq!(
                (line.text.clone(), line.bounds, line.layout.row_count()),
                geometry
            );
        });
        cx.executor().advance_clock(Duration::from_secs(2));
        cx.run_until_parked();
        editor.update(cx, |e, cx| {
            assert!(e.commit_playback(cx).is_none());
            assert_eq!(e.selection, selection);
            assert_eq!(
                e.book.chapters[0]
                    .doc
                    .loro_source()
                    .unwrap()
                    .loro()
                    .state_frontiers(),
                frontiers
            );
            assert_eq!(e.book.chapters[0].doc.undo_count(), 0);
        });
    }

    #[gpui::test]
    fn later_commits_input_and_reduce_motion_reveal_immediately(cx: &mut TestAppContext) {
        let (editor, cx) = editor(cx);
        write(&editor, "雨夜", "agent:first", cx);
        assert!(editor.read_with(cx, |e, cx| e.commit_playback(cx).is_some()));
        write(&editor, "风", "user", cx);
        assert!(editor.read_with(cx, |e, cx| e.commit_playback(cx).is_none()));
        write(&editor, "雨夜", "agent:next", cx);
        editor.update_in(cx, |e, window, cx| {
            e.replace_and_mark_text_in_range(None, "ni", None, window, cx);
            assert!(e.commit_playback(cx).is_none());
            assert!(e.composition.is_some());
            e.cancel_composition();
        });
        write(&editor, "雨夜", "agent:next", cx);
        editor.update_in(cx, |e, window, cx| {
            e.select(0, 1..2, window, cx);
            assert!(e.commit_playback(cx).is_none());
        });
        write(&editor, "雨夜", "agent:next", cx);
        editor.update(cx, |e, cx| {
            e.set_reduce_motion(true, cx);
            assert!(e.commit_playback(cx).is_none());
        });
        write(&editor, "雨夜", "agent:next", cx);
        assert!(editor.read_with(cx, |e, cx| e.commit_playback(cx).is_none()));
    }

    #[gpui::test]
    fn replacement_keeps_only_old_ink_and_mixed_batches_do_not_play(cx: &mut TestAppContext) {
        let (editor, cx) = editor(cx);
        editor.update(cx, |e, cx| {
            let source = e.book.chapters[0].doc.loro_source().unwrap();
            source.loro().set_next_commit_origin("agent:replace");
            source.text().delete(1, 2).unwrap();
            source.text().insert(1, "雨夜风").unwrap();
            source.loro().commit();
            e.refresh_chapter(0, cx);
            let overlay = e
                .paragraph_playback(0, 0, cx.background_executor().now())
                .unwrap();
            let old = overlay.old.unwrap();
            assert_eq!(old.text.as_ref(), "甲乙丙丁");
            assert_eq!(&old.text[old.visible], "乙丙");
            assert_eq!(e.book.chapters[0].doc.plain_text(), "甲雨夜风丁\n");
            let source = e.book.chapters[0].doc.loro_source().unwrap();
            source.loro().set_next_commit_origin("agent:next");
            source.text().insert(1, "雨").unwrap();
            source.loro().commit();
            source.loro().set_next_commit_origin("user");
            source.text().insert(1, "风").unwrap();
            source.loro().commit();
            e.refresh_chapter(0, cx);
            assert!(e.commit_playback(cx).is_none());
            // Pure deletion has no replacement glyphs; it lands immediately.
            let source = e.book.chapters[0].doc.loro_source().unwrap();
            source.loro().set_next_commit_origin("agent:delete");
            source.text().delete(1, 2).unwrap();
            source.loro().commit();
            e.refresh_chapter(0, cx);
            assert!(e.commit_playback(cx).is_none());
        });
    }
}
