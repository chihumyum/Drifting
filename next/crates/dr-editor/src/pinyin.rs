//! Pinyin initials for the @ picker (拼音首字母筛选): `yg` finds 约格.
//!
//! Each character of a name stands for the letters it can begin with: a
//! Chinese character for the first letter of each of its readings (重 for
//! `c` and `z`), a Latin letter or a digit for itself; spaces and marks
//! (the · in 安娜·约格) are skipped. A query of letters and digits matches
//! when it runs along consecutive characters of the name, anywhere in it
//! (`yg`, `ny` and `anyg` all find 安娜·约格).
//!
//! The table is the `pinyin` crate's (MIT; mozillazg's pinyin-data, MIT,
//! drawn from Unihan), plain spellings and every reading only.

use pinyin::ToPinyinMulti;

/// The letters each character of a name can begin with, as bit sets
/// (`a`–`z` bits 0–25, `0`–`9` bits 26–35).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Initials(Box<[u64]>);

fn bit(c: char) -> Option<u64> {
    match c.to_ascii_lowercase() {
        c @ 'a'..='z' => Some(1 << (c as u32 - 'a' as u32)),
        c @ '0'..='9' => Some(1 << (26 + c as u32 - '0' as u32)),
        _ => None,
    }
}

impl Initials {
    pub fn of(name: &str) -> Initials {
        let sets: Vec<u64> = name
            .chars()
            .filter_map(|c| {
                if let Some(b) = bit(c) {
                    return Some(b);
                }
                let readings = c.to_pinyin_multi()?;
                let set = readings
                    .into_iter()
                    .filter_map(|p| p.first_letter().chars().next().and_then(bit))
                    .fold(0, |set, b| set | b);
                (set != 0).then_some(set)
            })
            .collect();
        Initials(sets.into())
    }

    /// Whether `query` (letters and digits, any case) runs along
    /// consecutive characters of the name. Anything else in the query
    /// (a Chinese character, a space) never matches here.
    pub fn matches(&self, query: &str) -> bool {
        let Some(bits) = query.chars().map(bit).collect::<Option<Vec<u64>>>() else {
            return false;
        };
        if bits.is_empty() || bits.len() > self.0.len() {
            return false;
        }
        self.0
            .windows(bits.len())
            .any(|w| w.iter().zip(&bits).all(|(set, b)| set & b != 0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initials_run_along_the_name() {
        let yue = Initials::of("约格");
        assert!(yue.matches("yg") && yue.matches("YG") && yue.matches("g"));
        assert!(!yue.matches("gy") && !yue.matches("ygx") && !yue.matches(""));
        // The middle dot is skipped; any stretch matches.
        let anna = Initials::of("安娜·约格");
        assert!(anna.matches("anyg") && anna.matches("ny") && !anna.matches("ay"));
    }

    #[test]
    fn every_reading_of_a_polyphone_counts() {
        let city = Initials::of("重庆");
        assert!(city.matches("cq") && city.matches("zq"));
        let chang = Initials::of("长街");
        assert!(chang.matches("cj") && chang.matches("zj"));
    }

    #[test]
    fn latin_letters_and_digits_stand_for_themselves() {
        let q = Initials::of("阿Q");
        assert!(q.matches("aq"));
        let room = Initials::of("307 房间");
        assert!(room.matches("307fj") && room.matches("7f"));
        // A query that is not letters and digits is not initials.
        assert!(!q.matches("阿") && !q.matches("a q"));
    }
}
