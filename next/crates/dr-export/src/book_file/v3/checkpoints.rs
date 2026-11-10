//! Rebase complete entry checkpoints along with their operation history.
//! A manifest is structured data, not authored text. Its title/reason and
//! unknown fields stay literal; only its declared identities/versions move.

use super::*;
use dr_workspace::{commands::v3::snapshots as api, naming};

fn frontiers(encoded: &str) -> Result<loro::Frontiers> {
    // The shared hex reader indexes byte pairs. Reject non-ASCII before it
    // sees an untrusted archive string, including a split UTF-8 code point.
    if !encoded.is_ascii() {
        return Err(damaged("checkpoint version is not hex"));
    }
    naming::frontiers_from_hex(encoded).map_err(damaged)
}

fn mapped_version(rw: &Rewrite, encoded: &str) -> Result<String> {
    let mapped = frontiers(encoded)?
        .iter()
        .map(|mut id| {
            rw.id(&mut id);
            id
        })
        .collect();
    Ok(naming::frontiers_hex(&mapped))
}

fn document<'a>(
    cache: &'a mut HashMap<String, LoroDoc>,
    read: &Contents,
    rewrite: Option<&Rewrite>,
    id: &str,
) -> Result<&'a LoroDoc> {
    if !cache.contains_key(id) {
        let (_, bytes) = read
            .docs
            .iter()
            .find(|(entry, _)| entry.id == id)
            .ok_or_else(|| damaged(format!("checkpoint document is missing: {id}")))?;
        let doc = if let Some(rw) = rewrite {
            rw.doc(bytes)?
        } else {
            let doc = LoroDoc::new();
            schema::configure(&doc);
            doc.import(bytes).map_err(damaged)?;
            doc
        };
        cache.insert(id.into(), doc);
    }
    Ok(&cache[id])
}

pub(super) fn prepare(
    read: &Contents,
    rw: &mut Rewrite,
    changes: &[JsonChange],
    paths: &Paths,
) -> Result<()> {
    let mut source_docs = HashMap::new();
    let mut rewritten_docs = HashMap::new();
    // Include past inserts even when a later retention operation deleted the
    // point: archive import carries complete history, not only today's map.
    for change in changes {
        for op in &change.ops {
            let JsonOpContent::Map(MapOp::Insert {
                key,
                value: LoroValue::String(encoded),
            }) = &op.content
            else {
                continue;
            };
            if paths.path(&op.container) != ["entry_checkpoints"] {
                continue;
            }
            let mut payload: serde_json::Value = serde_json::from_str(encoded).map_err(damaged)?;
            let point: api::Point = serde_json::from_value(payload.clone()).map_err(damaged)?;
            if point.format != 1
                || point.id != *key
                || point.book != read.manifest.book
                || api::checkpoint_manifest_checksum(&point).map_err(damaged)? != point.checksum
            {
                return Err(damaged(
                    "checkpoint format, identity or checksum is invalid",
                ));
            }
            for id in point.bodies.keys() {
                if !matches!(DocId::parse(id), Ok(DocId::Body(body)) if body.entry().as_str() == point.entry)
                {
                    return Err(damaged("checkpoint contains a foreign body"));
                }
            }
            let identity = |id: &str| {
                rw.ids
                    .get(id)
                    .cloned()
                    .ok_or_else(|| damaged(format!("checkpoint identity is missing: {id}")))
            };
            let mut mapped = point.clone();
            mapped.id = identity(&point.id)?;
            mapped.book = identity(&point.book)?;
            mapped.entry = identity(&point.entry)?;
            mapped.book_version = mapped_version(rw, &point.book_version)?;
            mapped.bodies = point
                .bodies
                .iter()
                .map(|(id, version)| {
                    let id = rw
                        .doc_id(id)
                        .ok_or_else(|| damaged("missing body identity"))?;
                    Ok((id, mapped_version(rw, version)?))
                })
                .collect::<Result<_>>()?;

            let mut original = BTreeMap::new();
            let mut rewritten = BTreeMap::new();
            for (id, version) in
                std::iter::once((format!("book:{}", point.book), point.book_version.clone()))
                    .chain(point.bodies.clone())
            {
                let old = document(&mut source_docs, read, None, &id)?
                    .fork_at(&frontiers(&version)?)
                    .map_err(damaged)?;
                let new = document(&mut rewritten_docs, read, Some(rw), &id)?
                    .fork_at(&frontiers(&mapped_version(rw, &version)?)?)
                    .map_err(damaged)?;
                original.insert(id.clone(), old);
                rewritten.insert(
                    rw.doc_id(&id)
                        .ok_or_else(|| damaged("missing checkpoint document"))?,
                    new,
                );
            }
            if api::checkpoint_history_fingerprint(
                &original,
                &api::EntryIn {
                    book: point.book,
                    entry: point.entry,
                },
            )
            .map_err(damaged)?
                != point.content_hash
            {
                return Err(damaged(
                    "checkpoint historical content does not match its manifest",
                ));
            }
            // Cached book copies still contain the original checkpoint strings.
            // The shared fingerprint deliberately covers entry-owned state and
            // body versions, not this independent checkpoint root.
            mapped.content_hash = api::checkpoint_history_fingerprint(
                &rewritten,
                &api::EntryIn {
                    book: mapped.book.clone(),
                    entry: mapped.entry.clone(),
                },
            )
            .map_err(damaged)?;
            mapped.checksum = api::checkpoint_manifest_checksum(&mapped).map_err(damaged)?;
            let fields = serde_json::to_value(mapped).map_err(damaged)?;
            payload
                .as_object_mut()
                .ok_or_else(|| damaged("checkpoint manifest is not an object"))?
                .extend(fields.as_object().expect("Point is an object").clone());
            rw.checkpoints.insert(
                encoded.to_string(),
                serde_json::to_string(&payload).map_err(damaged)?,
            );
        }
    }
    Ok(())
}
