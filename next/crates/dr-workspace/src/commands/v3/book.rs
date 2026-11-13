//! Versioned homepage metadata; word targets live in `project.book`.
use super::*;
use crate::dto::BookInfo;

op! {
    BookGet = "book.get", Read, Shared,
    "Read book metadata and project word targets; aggregate counts use the statistics adapter.",
    fn(cx, input: BookIn) -> BookInfo {
        let slot = cx.book_v3(&input.book)?;
        let v = slot.reader_v3.view();
        Ok(BookInfo::from_book(&v.meta(), &v.project()))
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
}

op! {
    BookUpdate = "book.update", Write, Book,
    "Update selected book metadata fields without replacing other book data.",
    fn(cx, input: BookUpdateIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        if let Some(n) = &input.name { name_ok(n)?; }
        let m = slot.reader_v3.view().meta();
        let mut change = input.clone();
        change.name = change.name.map(|n| n.trim().to_owned()).filter(|n| *n != m.name);
        change.summary = change.summary.filter(|s| *s != m.summary);
        if change.name.is_none() && change.summary.is_none() {
            cx.undo_nothing();
            return Ok(Done { id: input.book });
        }
        let old = BookUpdateIn {
            book: input.book.clone(),
            name: change.name.as_ref().map(|_| m.name),
            summary: change.summary.as_ref().map(|_| m.summary),
        };
        let replaced = [
            ("name", change.name.is_some()),
            ("summary", change.summary.is_some()),
        ]
        .into_iter()
        .filter(|(_, set)| *set)
        .map(|(field, _)| rec(CollectionV3::Meta, field));
        cx.write_book_v3(&slot, Replaces::records(replaced), move |txn| {
            let w = txn.meta();
            if let Some(n) = &change.name { w.name(n)?; }
            if let Some(s) = &change.summary { w.summary(s)?; }
            Ok(())
        })?;
        cx.effect(EffectAction::Updated, "book", &input.book, input.name.as_deref());
        cx.undo_with(Invocation::new("book.update", old));
        Ok(Done { id: input.book })
    }
}
