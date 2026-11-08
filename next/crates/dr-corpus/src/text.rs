//! Synthetic Chinese prose: no manuscript text, only the original sentences
//! the 0.1 client's seed wrote (`sample-project/prose.ts`), recombined by a
//! seeded generator.
//!
//! **Words.** A body's size is counted the way Drifting counts Chinese: one
//! word per Han character (CJK Unified Ideographs and Extension A).
//! Punctuation, quotes and newlines are not words. The corpus has no Latin
//! text, so this equals the product's word count on it.

use dr_model::prose::Heading;

/// Paragraphs, links and their plain text are dr-samples' (the samples are
/// made of them too).
pub use crate::para::{Link, Para, plain};

use crate::rng::Rng;

/// Whether `c` counts as one word (a Han character).
pub fn is_word_char(c: char) -> bool {
    matches!(c, '\u{3400}'..='\u{4DBF}' | '\u{4E00}'..='\u{9FFF}')
}

/// Words in `s`.
pub fn words(s: &str) -> usize {
    s.chars().filter(|c| is_word_char(*c)).count()
}

/// The prefix of `s` holding at most `limit` words: it stops just before
/// the word that would exceed the limit (punctuation after the last word is
/// kept). The old seed's `takeWords`.
pub fn take_words(s: &str, limit: usize) -> &str {
    let mut n = 0;
    for (i, c) in s.char_indices() {
        if is_word_char(c) {
            if n == limit {
                return &s[..i];
            }
            n += 1;
        }
    }
    s
}

pub(crate) const PLACES: &[&str] = &[
    "北岬灯塔",
    "旧码头",
    "盐仓",
    "气象站",
    "白沙湾",
    "档案室",
    "防波堤",
    "修船厂",
];
pub(crate) const PEOPLE: &[&str] = &[
    "林潮",
    "老船长",
    "值班员",
    "档案员",
    "领航员",
    "修灯人",
    "邮递员",
    "观潮员",
];
const OBJECTS: &[&str] = &[
    "航海日志",
    "潮位记录",
    "黄铜钥匙",
    "旧海图",
    "玻璃浮标",
    "未寄出的信",
    "值班表",
    "检修手册",
];
const DETAILS: &[&str] = &[
    "门框上新留下的盐渍",
    "窗玻璃中一闪而过的倒影",
    "钟摆停止时指向的刻度",
    "船票背面被折起的蓝边",
    "绳结中夹着的一小片贝壳",
    "抽屉里没有寄出的便笺",
    "石阶上被潮水抹平的脚印",
    "灯镜边缘反复擦拭的痕迹",
];
/// Short titles the seed gives chapters and ideas.
pub const HEADINGS: &[&str] = &[
    "潮声与记录",
    "尚待核对的证词",
    "灯下的观察",
    "返航之前",
    "档案中的时间差",
    "沿着堤岸寻访",
];
const SENTENCES: &[&str] = &[
    "潮水正在退去，远处的灯塔亮了一下，又被低云遮住。",
    "屋里有盐、柴油和旧纸混在一起的气味，窗外的海面看不见边。",
    "这还不能算作证据，至多说明原来的解释遗漏了一段没有被记录的航程。",
    "她把可以确认的事实写在左边，把没有答案的问题留在右边，中间隔着一道窄窄的空白。",
    "那人说话前先看了一眼海，似乎只有等到下一阵浪声过去，才能继续说下去。",
    "如果两份抄本出自同一只手，那么字迹的差异就不能简单归咎于匆忙。",
    "灯光每隔九秒扫过一次窗户，这是整件事里少数可以重复核对的事实。",
    "她决定沿着旧路线再走一遍，把每一个转角与纸上的标记分别对照。",
    "雨停以后，堤岸上的水线还会留下片刻，但没有人能保证它一直等在那里。",
    "“先不要替别人补上答案。”她合起笔记本，示意对方把刚才的话从头再说一遍。",
];
const TASKS: &[&str] = &[
    "核对值班记录与潮位变化",
    "补充现场光线和人物动作",
    "检查证词之间尚未解释的时间差",
];
const SURNAMES: &str = "林沈顾陆苏叶许程韩唐宋萧白江秦温";
const GIVEN: &str = "潮岚默青远立晚禾川舟知微安澜若水星河月明清风远山晴云雪松竹";

/// What a body may contain.
#[derive(Clone, Copy, Debug, Default)]
pub struct BodyShape<'a> {
    /// Names that link to an entity (people first, then places, any order):
    /// paragraphs mention them and record a [`Link`] for each mention.
    pub names: &'a [&'a str],
    /// A three-item task list after the first heading (material notes).
    pub tasks: bool,
}

/// A body of exactly `words` words (at least 20): a heading first, a
/// heading every nine paragraphs after it (cycling H2, H3, H1, so every
/// level occurs in a long body), and paragraphs of two to seven sentences.
pub fn body(rng: &mut Rng, words_wanted: usize, shape: BodyShape<'_>) -> Vec<Para> {
    assert!(words_wanted >= 20, "a seeded body has at least 20 words");
    let mut out = Vec::new();
    let mut remaining = words_wanted;
    let mut headings = 0usize;
    let push = |out: &mut Vec<Para>, remaining: &mut usize, mut para: Para| {
        let cut = take_words(&para.text, *remaining).to_string();
        let len = cut.chars().count();
        para.links.retain(|l| l.start + l.len <= len);
        *remaining -= words(&cut);
        para.text = cut;
        out.push(para);
    };
    let heading = |rng: &mut Rng, k: usize| Para {
        text: rng.pick(HEADINGS).to_string(),
        heading: Some([Heading::H2, Heading::H3, Heading::H1][k % 3]),
        ..Para::default()
    };
    let h = heading(rng, headings);
    headings += 1;
    push(&mut out, &mut remaining, h);
    if shape.tasks && remaining > 60 {
        for (i, t) in TASKS.iter().enumerate() {
            let checked = rng.below(3) == 0 || i == 0;
            push(
                &mut out,
                &mut remaining,
                Para {
                    text: (*t).to_string(),
                    task: Some(checked),
                    ..Para::default()
                },
            );
        }
    }
    let mut paragraphs = 0usize;
    while remaining > 0 {
        if paragraphs > 0 && paragraphs.is_multiple_of(9) && remaining > 40 {
            let h = heading(rng, headings);
            headings += 1;
            push(&mut out, &mut remaining, h);
        }
        let mut text = String::new();
        let mut links = Vec::new();
        let mut name = |rng: &mut Rng, text: &mut String, fallback: &[&str]| {
            if shape.names.is_empty() {
                text.push_str(rng.pick(fallback));
            } else {
                let target = rng.below(shape.names.len() as u64) as usize;
                let start = text.chars().count();
                let n = shape.names[target];
                text.push_str(n);
                links.push(Link {
                    start,
                    len: n.chars().count(),
                    target,
                });
            }
        };
        name(rng, &mut text, PEOPLE);
        text.push_str("到达");
        name(rng, &mut text, PLACES);
        text.push_str("时，先记下了");
        text.push_str(rng.pick(DETAILS));
        text.push_str("。她翻开");
        text.push_str(rng.pick(OBJECTS));
        text.push_str("，把眼前的情形与上一次的记录放在一起。");
        for _ in 0..rng.range(2, 7) {
            text.push_str(rng.pick(SENTENCES));
        }
        push(
            &mut out,
            &mut remaining,
            Para {
                text,
                links,
                ..Para::default()
            },
        );
        paragraphs += 1;
    }
    out
}

/// `n` distinct two- or three-character personal names.
pub fn person_names(rng: &mut Rng, n: usize) -> Vec<String> {
    let surnames: Vec<char> = SURNAMES.chars().collect();
    let given: Vec<char> = GIVEN.chars().collect();
    let mut seen = std::collections::BTreeSet::new();
    let mut out = Vec::with_capacity(n);
    while out.len() < n {
        let mut s = String::new();
        s.push(*rng.pick(&surnames));
        for _ in 0..rng.range(1, 2) {
            s.push(*rng.pick(&given));
        }
        if seen.insert(s.clone()) {
            out.push(s);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn take_words_stops_before_the_extra_word() {
        assert_eq!(take_words("潮水，退去。", 2), "潮水，");
        assert_eq!(take_words("潮水，退去。", 4), "潮水，退去。");
        assert_eq!(take_words("“先不要", 1), "“先");
        assert_eq!(words("“先不要替别人补上答案。”"), 10);
    }

    #[test]
    fn bodies_have_the_exact_size_and_every_heading_level() {
        for words_wanted in [20, 37, 500, 2_000, 9_999] {
            let mut rng = Rng::new(words_wanted as u64);
            let names = ["沈知微", "白沙湾"];
            let paras = body(
                &mut rng,
                words_wanted,
                BodyShape {
                    names: &names,
                    tasks: true,
                },
            );
            assert_eq!(
                paras.iter().map(|p| words(&p.text)).sum::<usize>(),
                words_wanted
            );
            for p in &paras {
                for l in &p.links {
                    let got: String = p.text.chars().skip(l.start).take(l.len).collect();
                    assert_eq!(got, names[l.target]);
                }
            }
            if words_wanted >= 9_999 {
                for h in Heading::ALL {
                    assert!(paras.iter().any(|p| p.heading == Some(h)), "{h:?}");
                }
                assert_eq!(paras.iter().filter(|p| p.task.is_some()).count(), 3);
            }
        }
    }
}
