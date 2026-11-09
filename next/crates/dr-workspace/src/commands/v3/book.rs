//! Versioned homepage metadata; aggregate counts belong to the v3 read adapters.
use super::*;
use crate::dto::BookInfo;

op! {
    BookGet = "book.get", Read, Shared,
    "Read v3 book metadata and word targets; aggregate counts use the v3 statistics adapter.",
    fn(cx, input: BookIn) -> BookInfo {
        let slot = cx.book_v3(&input.book)?;
        let m = slot.reader_v3.view().meta();
        Ok(BookInfo {
            id: m.id.to_string(),
            name: m.name.clone(),
            summary: m.summary.clone(),
            trashed: m.deleted_at.is_some(),
            word_target: m.word_target(),
            daily_word_target: m.daily_word_target(),
            created_at: m.created_at.map(|t| t.0),
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "BookUpdateInV3")]
pub struct BookUpdateIn {
    pub book: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Omit to keep it, zero to turn it off, null to restore the default.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub word_target: Option<Option<i64>>,
    /// Omit to keep it, zero to turn it off, null to restore the default.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub daily_word_target: Option<Option<i64>>,
}
impl From<crate::commands::book::BookUpdateIn> for BookUpdateIn {
    fn from(i: crate::commands::book::BookUpdateIn) -> Self {
        Self {
            book: i.book,
            name: i.name,
            summary: i.summary,
            word_target: i.word_target.map(Some),
            daily_word_target: i.daily_word_target.map(Some),
        }
    }
}
op! {
    BookUpdate = "book.update", Write, Book,
    "Update selected v3 book metadata fields without replacing other book data.",
    fn(cx, input: BookUpdateIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        if let Some(n) = &input.name { name_ok(n)?; }
        if [input.word_target, input.daily_word_target]
            .into_iter().flatten().flatten().any(|n| n < 0)
        {
            return Err(WsError::invalid("a word target cannot be negative"));
        }
        let m = slot.reader_v3.view().meta();
        let mut change = input.clone();
        change.name = change.name.map(|n| n.trim().to_owned()).filter(|n| *n != m.name);
        change.summary = change.summary.filter(|s| *s != m.summary);
        change.word_target = change.word_target.filter(|v| *v != m.word_target_set);
        change.daily_word_target = change.daily_word_target.filter(|v| *v != m.daily_word_target_set);
        if change.name.is_none() && change.summary.is_none()
            && change.word_target.is_none() && change.daily_word_target.is_none()
        {
            cx.undo_nothing();
            return Ok(Done { id: input.book });
        }
        let old = BookUpdateIn {
            book: input.book.clone(),
            name: change.name.as_ref().map(|_| m.name),
            summary: change.summary.as_ref().map(|_| m.summary),
            word_target: change.word_target.map(|_| m.word_target_set),
            daily_word_target: change.daily_word_target.map(|_| m.daily_word_target_set),
        };
        cx.write_book_v3(&slot, move |txn| {
            let w = txn.meta();
            if let Some(n) = &change.name { w.name(n)?; }
            if let Some(s) = &change.summary { w.summary(s)?; }
            if let Some(t) = change.word_target { w.word_target(t)?; }
            if let Some(t) = change.daily_word_target { w.daily_word_target(t)?; }
            Ok(())
        })?;
        cx.effect(EffectAction::Updated, "book", &input.book, input.name.as_deref());
        cx.undo_with(Invocation::new("book.update", old));
        Ok(Done { id: input.book })
    }
}
