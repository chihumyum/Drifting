//! A canonical writer may skip only exact original, non-alias text clocks.
//! Receipts are immutable across activation namespaces; they never own text.
use super::*;
use std::collections::BTreeSet;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SafeClockSpan {
    alias_id: String,
    source_text: Id,
    source: Id,
    parent_text: Id,
    text: String,
}

fn normalize(
    mut spans: Vec<SafeClockSpan>,
    record: &AliasRecord,
) -> Result<Vec<SafeClockSpan>, String> {
    let mut units = BTreeMap::new();
    for span in spans.drain(..) {
        let len = u32::try_from(span.text.encode_utf16().count())
            .map_err(|_| refused("Safe clock span overflow"))?;
        if span.alias_id != record.id
            || span.source_text != record.source_text
            || span.parent_text == record.source_text
            || span.parent_text == record.target_text
            || span.source.client > MAX_CLIENT
            || span.parent_text.client > MAX_CLIENT
            || len == 0
            || span.source.plus(len).is_none()
        {
            return Err(refused("Invalid safe clock receipt"));
        }
        let mut offset = 0;
        for scalar in span.text.chars() {
            let part = SafeClockSpan {
                source: span.source.plus(offset).unwrap(),
                text: scalar.to_string(),
                ..span.clone()
            };
            if units.get(&part.source).is_some_and(|old| old != &part) {
                return Err(refused("Conflicting safe clock receipt"));
            }
            units.insert(part.source, part);
            offset += scalar.len_utf16() as u32;
        }
    }
    let mut out: Vec<SafeClockSpan> = Vec::new();
    for part in units.into_values() {
        if let Some(previous) = out.last_mut() {
            let len = previous.text.encode_utf16().count() as u32;
            if previous.source.client == part.source.client {
                let end = previous.source.clock + len;
                if part.source.clock < end {
                    return Err(refused("Overlapping safe clock Unicode evidence"));
                }
                if part.source.clock == end && previous.parent_text == part.parent_text {
                    previous.text.push_str(&part.text);
                    continue;
                }
            }
        }
        out.push(part);
    }
    Ok(out)
}

pub(super) fn read<T: ReadTxn>(
    txn: &T,
    record: &AliasRecord,
) -> Result<Vec<SafeClockSpan>, String> {
    normalize(read_prefix(txn, &format!("skip/{}/", record.id))?, record)
}
pub(super) fn write(txn: &mut yrs::TransactionMut, span: &SafeClockSpan) -> Result<(), String> {
    immutable(
        txn,
        format!(
            "skip/{}/{}/{}",
            span.alias_id,
            span.source.key(),
            span.text.encode_utf16().count()
        ),
        span,
    )
}

fn overlap(a: Id, length: u32, b: Id, blen: u32) -> bool {
    a.client == b.client && a.clock < b.clock + blen && b.clock < a.clock + length
}

/// Whole gap proof, made against a complete raw candidate. Existing marks on
/// safe text are irrelevant: these original items are not rewritten.
pub(super) fn prove(
    doc: &Doc,
    record: &AliasRecord,
    mapped_sources: &[Span],
    source: Id,
    length: u32,
) -> Result<Option<Vec<SafeClockSpan>>, String> {
    let end = source
        .clock
        .checked_add(length)
        .ok_or_else(|| refused("Safe clock range overflow"))?;
    let mut txn = doc.transact_mut();
    if txn.has_missing_updates() {
        return Err(refused("Safe clock proof requires complete dependencies"));
    }
    let definitions = defs(&txn)?;
    let active = active_records(&txn)?;
    if definitions.len() != 1
        || active.len() != 1
        || definitions[0].id != record.id
        || active[0].id != record.id
    {
        return Err(refused("Safe clock proof requires one unambiguous alias"));
    }
    let mut excluded = BTreeSet::from([record.source_text, record.target_text]);
    for item in definitions.iter().chain(active.iter()) {
        excluded.extend([item.source_text, item.target_text]);
    }
    for render in all_rendered(&txn)? {
        if let Some(offset) =
            StickyIndex::from_id(render.target.yrs(), Assoc::After).get_offset(&txn)
        {
            if let BranchID::Nested(id) = offset.branch.id() {
                excluded.insert(Id::from_yrs(id));
            }
        }
    }
    let persisted = read(&txn, record)?;
    let sources = evidence(&txn, record.source_text)?;
    for span in &persisted {
        let len = span.text.encode_utf16().count() as u32;
        if excluded.contains(&span.parent_text)
            || mapped_sources
                .iter()
                .any(|s| overlap(span.source, len, s.source, s.length))
            || sources
                .iter()
                .any(|s| overlap(span.source, len, s.id, s.text.encode_utf16().count() as u32))
        {
            return Err(refused("Safe clock receipt overlaps alias graph"));
        }
    }
    if mapped_sources
        .iter()
        .any(|s| overlap(source, length, s.source, s.length))
    {
        return Err(refused("Canonical gap overlaps translated source"));
    }
    let root = txn
        .get_xml_fragment("default")
        .ok_or_else(|| refused("Missing document root"))?;
    let texts: Vec<_> = root
        .successors(&txn)
        .filter_map(|node| match node {
            XmlOut::Text(text) => Some(text),
            _ => None,
        })
        .collect();
    let mut visible = Vec::new();
    for text in texts {
        let parent = type_id(&text)?;
        for run in tape(&mut txn, &text)? {
            if run.id.client != source.client {
                continue;
            }
            let a = run.id.clock.max(source.clock);
            let b = (run.id.clock + run.length).min(end);
            if a >= b {
                continue;
            }
            if excluded.contains(&parent) {
                return Err(refused("Safe clock gap belongs to alias graph"));
            }
            visible.push(SafeClockSpan {
                alias_id: record.id.clone(),
                source_text: record.source_text,
                source: Id {
                    client: source.client,
                    clock: a,
                },
                parent_text: parent,
                text: slice(&run.text, a - run.id.clock, b - a)?,
            });
        }
    }
    // Normalize current observations together with earlier proof. Any visible
    // original item contradicting a persisted parent/text receipt is rejected.
    let mut joined = persisted.clone();
    joined.extend(visible);
    let normalized = normalize(joined, record)?;
    let mut result = Vec::new();
    let mut cursor = source.clock;
    for span in normalized {
        let len = span.text.encode_utf16().count() as u32;
        if span.source.client != source.client {
            continue;
        }
        let a = span.source.clock.max(source.clock);
        let b = (span.source.clock + len).min(end);
        if a >= b {
            continue;
        }
        if a != cursor {
            return Ok(None);
        }
        result.push(SafeClockSpan {
            source: Id {
                client: source.client,
                clock: a,
            },
            text: slice(&span.text, a - span.source.clock, b - a)?,
            ..span
        });
        cursor = b;
    }
    if cursor != end {
        return Ok(None);
    }
    Ok(Some(result))
}

/// Sparse source evidence uses Skip. Canonical repairs use GC only for a
/// validated exact coverage plan. Neither mode silently renumbers items.
pub(super) fn encode(
    strings: &[WireString],
    coverage: &IdSet,
    deleted: &IdSet,
    source_replay: bool,
) -> Result<Vec<u8>, String> {
    let mut clients: BTreeMap<u64, Vec<&WireString>> = BTreeMap::new();
    for value in strings {
        clients.entry(value.id.client).or_default().push(value);
    }
    let mut encoder = EncoderV1::new();
    encoder.write_var(clients.len() as u32);
    for (client, mut values) in clients.into_iter().rev() {
        values.sort_by_key(|v| v.id.clock);
        let first = values[0].id.clock;
        // The proof plan contains only gaps before the last string. Its first
        // range can precede the first string, including a known capture prefix.
        let mut start = first;
        if !source_replay {
            if let Some(ranges) = coverage.get(&ClientID::new(client)) {
                if let Some(range) = ranges.iter().next() {
                    start = start.min(range.0.start);
                }
            }
        }
        let mut count = 0u32;
        let mut cursor = start;
        for value in &values {
            if value.id.clock < cursor {
                return Err(refused("Overlapping encoded alias strings"));
            }
            if value.id.clock > cursor {
                if !source_replay {
                    let mut span = IdSet::new();
                    span.insert(
                        ID::new(ClientID::new(client), cursor),
                        value.id.clock - cursor,
                    );
                    if !span.diff(coverage).is_empty() {
                        return Err(refused("Unproved encoded canonical gap"));
                    }
                }
                count += 1;
            }
            count += 1;
            cursor = value
                .id
                .plus(value.text.encode_utf16().count() as u32)
                .ok_or_else(|| refused("Encoded alias clock overflow"))?
                .clock;
        }
        encoder.write_var(count);
        encoder.write_client(ClientID::new(client));
        encoder.write_var(start);
        cursor = start;
        for value in values {
            if value.id.clock > cursor {
                encoder.write_info(if source_replay {
                    BLOCK_SKIP_REF_NUMBER
                } else {
                    BLOCK_GC_REF_NUMBER
                });
                if source_replay {
                    encoder.write_var(value.id.clock - cursor);
                } else {
                    encoder.write_len(value.id.clock - cursor);
                }
            }
            let mut info = yrs::block::BLOCK_ITEM_STRING_REF_NUMBER;
            if value.origin.is_some() {
                info |= HAS_ORIGIN;
            }
            if value.right.is_some() {
                info |= HAS_RIGHT_ORIGIN;
            }
            encoder.write_info(info);
            if let Some(id) = value.origin {
                encoder.write_left_id(&id.yrs());
            }
            if let Some(id) = value.right {
                encoder.write_right_id(&id.yrs());
            }
            if value.origin.is_none() && value.right.is_none() {
                encoder.write_parent_info(false);
                encoder.write_left_id(
                    &value
                        .parent
                        .ok_or_else(|| refused("Missing encoded alias parent"))?
                        .yrs(),
                );
            }
            encoder.write_string(&value.text);
            cursor = value.id.clock + value.text.encode_utf16().count() as u32;
        }
    }
    deleted.encode(&mut encoder);
    Ok(encoder.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record() -> AliasRecord {
        AliasRecord {
            id: "test-alias".into(),
            incarnation: "joined".into(),
            source_text: Id {
                client: 1,
                clock: 0,
            },
            target_text: Id {
                client: 2,
                clock: 0,
            },
            source_len: 1,
            retained_len: 1,
            namespace: 1 << 40,
            source_state: vec![],
            spans: vec![Span {
                source: Id {
                    client: 1,
                    clock: 1,
                },
                target: Id {
                    client: 2,
                    clock: 1,
                },
                length: 1,
            }],
            right_boundary: None,
        }
    }
    fn receipt(start: u32, text: &str) -> SafeClockSpan {
        SafeClockSpan {
            alias_id: "test-alias".into(),
            source_text: Id {
                client: 1,
                clock: 0,
            },
            source: Id {
                client: 9,
                clock: start,
            },
            parent_text: Id {
                client: 3,
                clock: 0,
            },
            text: text.into(),
        }
    }
    #[test]
    fn safe_clock_gaps_receipts_normalize_unicode_and_reject_conflicts() {
        let record = record();
        let full = receipt(3, "远🙂e\u{301}");
        assert_eq!(
            normalize(
                vec![
                    full.clone(),
                    receipt(3, "远"),
                    receipt(4, "🙂"),
                    receipt(6, "e\u{301}")
                ],
                &record
            )
            .unwrap(),
            vec![full.clone()]
        );
        for mut bad in [
            receipt(4, "🙂"),
            receipt(3, "近"),
            receipt(5, "x"),
            receipt(u32::MAX, "🙂"),
        ] {
            if bad.text == "🙂" && bad.source.clock == 4 {
                bad.parent_text = Id {
                    client: 4,
                    clock: 0,
                };
            }
            assert!(normalize(vec![full.clone(), bad], &record).is_err());
        }
        let mut other = full.clone();
        other.alias_id = "different".into();
        assert!(normalize(vec![other], &record).is_err());
        let mut other = full.clone();
        other.parent_text = record.target_text;
        assert!(normalize(vec![other], &record).is_err());
    }
    #[test]
    fn safe_clock_gaps_receipt_key_is_immutable_and_unknown_fields_reject() {
        let doc = Doc::new();
        let r = record();
        let value = receipt(0, "远🙂");
        write(&mut doc.transact_mut(), &value).unwrap();
        write(&mut doc.transact_mut(), &value).unwrap();
        let mut bad = value.clone();
        bad.text = "近🙂".into();
        assert!(write(&mut doc.transact_mut(), &bad).is_err());
        assert_eq!(read(&doc.transact(), &r).unwrap(), vec![value.clone()]);
        let mut future = serde_json::to_value(value).unwrap();
        future["future"] = json!(true);
        doc.get_or_insert_map(ROOT).insert(
            &mut doc.transact_mut(),
            "skip/test-alias/extra",
            future.to_string(),
        );
        assert!(read(&doc.transact(), &r).is_err());
    }
    #[test]
    fn safe_clock_gaps_source_skip_is_not_canonical_gc_authority() {
        let strings = vec![
            WireString {
                id: Id {
                    client: 9,
                    clock: 0,
                },
                text: "保".into(),
                origin: None,
                right: None,
                parent: Some(Id {
                    client: 1,
                    clock: 0,
                }),
            },
            WireString {
                id: Id {
                    client: 9,
                    clock: 4,
                },
                text: "续".into(),
                origin: Some(Id {
                    client: 9,
                    clock: 0,
                }),
                right: None,
                parent: Some(Id {
                    client: 1,
                    clock: 0,
                }),
            },
        ];
        let source = encode(&strings, &IdSet::new(), &IdSet::new(), true).unwrap();
        let parsed = parse(&source).unwrap();
        assert_eq!(
            parsed
                .strings
                .iter()
                .map(|s| s.id.clock)
                .collect::<Vec<_>>(),
            vec![0, 4]
        );
        assert!(parsed.other.is_empty());
        assert!(encode(&strings, &IdSet::new(), &IdSet::new(), false).is_err());
        let mut coverage = IdSet::new();
        coverage.insert(ID::new(ClientID::new(9), 1), 3);
        let canonical = parse(&encode(&strings, &coverage, &IdSet::new(), false).unwrap()).unwrap();
        assert!(canonical.other.contains(&ID::new(ClientID::new(9), 2)));
        assert_eq!(
            canonical
                .strings
                .iter()
                .map(|s| s.id.clock)
                .collect::<Vec<_>>(),
            vec![0, 4]
        );
        let mut incomplete = IdSet::new();
        incomplete.insert(ID::new(ClientID::new(9), 1), 2);
        assert!(encode(&strings, &incomplete, &IdSet::new(), false).is_err());
    }
}
