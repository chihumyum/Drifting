//! Position conversion: for any text, the three units agree with each other
//! and with Loro's own index, every boundary converts both ways, and nothing
//! inside a character is accepted.

use dr_doc::prose::ProseDoc;
use dr_doc::{PosError, TextPos, Unit};
use dr_model::{DocId, Origin};
use proptest::prelude::*;

/// Characters of every UTF-8 / UTF-16 width, CJK and emoji included.
fn text() -> impl Strategy<Value = String> {
    prop::collection::vec(
        prop_oneof![
            Just('a'),
            Just('é'),
            Just('中'),
            Just('文'),
            Just('😀'),
            Just('\u{20000}'),
            Just('\u{2028}'),
            Just('·'),
        ],
        0..40,
    )
    .prop_map(|v| v.into_iter().collect())
}

proptest! {
    #[test]
    fn units_agree_in_a_string(s in text()) {
        let mut at = TextPos::ZERO;
        for (i, c) in s.chars().enumerate() {
            prop_assert_eq!(at.chars, i);
            for unit in [Unit::Char, Unit::Utf8, Unit::Utf16] {
                prop_assert_eq!(TextPos::in_str(&s, unit, at.get(unit)), Ok(at));
            }
            // Inside a multi-unit character nothing converts.
            for k in 1..c.len_utf8() {
                let is_not_a_boundary = matches!(
                    TextPos::in_str(&s, Unit::Utf8, at.utf8 + k),
                    Err(PosError::NotABoundary { .. })
                );
                prop_assert!(is_not_a_boundary);
            }
            if c.len_utf16() == 2 {
                let is_not_a_boundary = matches!(
                    TextPos::in_str(&s, Unit::Utf16, at.utf16 + 1),
                    Err(PosError::NotABoundary { .. })
                );
                prop_assert!(is_not_a_boundary);
            }
            at = at.advance_char(c);
        }
        prop_assert_eq!(at, TextPos::end_of(&s));
        let past_the_end = matches!(
            TextPos::in_str(&s, Unit::Utf8, at.utf8 + 1),
            Err(PosError::OutOfRange { .. })
        );
        prop_assert!(past_the_end);
    }

    #[test]
    fn document_positions_match_string_positions(s in text(), cut in any::<u16>()) {
        let mut d = ProseDoc::create(DocId::parse("node:pos").unwrap(), 1).unwrap();
        // Two paragraphs, so the conversion crosses a newline.
        let chars: Vec<char> = s.chars().collect();
        let cut = cut as usize % (chars.len() + 1);
        let (a, b): (String, String) = (chars[..cut].iter().collect(), chars[cut..].iter().collect());
        let (r, _) = d.edit(Origin::User, |t| {
            t.insert_text(0, &a)?;
            let c = t.split(a.chars().count())?;
            t.insert_text(c, &b)
        });
        r.unwrap();
        let v = d.view();
        let plain = v.plain_text();
        prop_assert_eq!(&plain, &format!("{a}\n{b}\n"));
        let mut at = TextPos::ZERO;
        for c in plain.chars() {
            for unit in [Unit::Char, Unit::Utf8, Unit::Utf16] {
                prop_assert_eq!(v.pos(unit, at.get(unit)), Ok(at));
            }
            if c.len_utf8() > 1 {
                prop_assert!(v.pos(Unit::Utf8, at.utf8 + 1).is_err());
            }
            if c.len_utf16() == 2 {
                prop_assert!(v.pos(Unit::Utf16, at.utf16 + 1).is_err());
            }
            at = at.advance_char(c);
        }
        prop_assert_eq!(v.pos(Unit::Char, at.chars), Ok(at));
        prop_assert_eq!((v.len(), v.len_utf8(), v.len_utf16()), (at.chars, at.utf8, at.utf16));
    }
}
