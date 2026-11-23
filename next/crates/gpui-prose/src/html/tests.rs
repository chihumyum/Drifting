//! Reading clipboard HTML. Every sample here is made up for these tests, in
//! the shape the named program writes (no copied page or document).

use super::*;
use crate::text::PASTED_KEYS;

fn read(html: &str) -> Fragment {
    parse(html).expect("something to paste")
}

fn texts(f: &Fragment) -> Vec<&str> {
    f.paragraphs.iter().map(|p| p.text.as_str()).collect()
}

/// A paragraph's attributes as `key=value` (`key` for `true`), in the
/// order of [`PASTED_KEYS`]; empty for a body paragraph.
fn look(p: &FragmentParagraph) -> String {
    PASTED_KEYS
        .iter()
        .filter_map(|key| {
            Some(match p.attrs.get(key)? {
                LoroValue::Bool(true) => key.to_string(),
                LoroValue::I64(n) => format!("{key}={n}"),
                LoroValue::String(s) => format!("{key}={}", s.as_str()),
                other => format!("{key}={other:?}"),
            })
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn looks(f: &Fragment) -> Vec<String> {
    f.paragraphs.iter().map(look).collect()
}

/// The text each `key` mark covers: (paragraph, text).
fn marked(f: &Fragment, key: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    for (ix, p) in f.paragraphs.iter().enumerate() {
        for (range, k, _) in &p.marks {
            if k == key {
                out.push((
                    ix,
                    p.text.chars().skip(range.start).take(range.len()).collect(),
                ));
            }
        }
    }
    out
}

fn link_of(f: &Fragment, para: usize) -> Vec<String> {
    f.paragraphs[para]
        .marks
        .iter()
        .filter(|(_, k, _)| k == inline::LINK)
        .map(|(_, _, v)| match v {
            LoroValue::String(s) => s.to_string(),
            v => format!("{v:?}"),
        })
        .collect()
}

fn m(para: usize, text: &str) -> (usize, String) {
    (para, text.to_owned())
}

// ----- Word -----------------------------------------------------------------------

/// Word (Mac and Windows write the same): conditional markup, `o:p`,
/// `mso-` styles, lists as paragraphs with a hidden number.
const WORD: &str = r##"<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta http-equiv=Content-Type content="text/html; charset=utf-8">
<meta name=ProgId content=Word.Document>
<!--[if gte mso 9]><xml>
 <o:DocumentProperties><o:Author>Someone</o:Author></o:DocumentProperties>
</xml><![endif]-->
<style>
<!--
 /* Font Definitions */
 @font-face {font-family:"Cambria Math"; panose-1:2 4 5 3 5 4 6 3 2 4;}
 p.MsoNormal, li.MsoNormal, div.MsoNormal {margin:0in; font-size:12.0pt; font-family:"Calibri",sans-serif;}
 h1 {mso-style-priority:9; font-size:16.0pt; font-weight:normal;}
 span.MsoIntenseEmphasis {font-style:italic; color:#4472C4;}
 p.MsoListParagraph, li.MsoListParagraph {margin-left:.5in;}
 /* List Definitions */
 @list l0 {mso-list-id:1; mso-list-type:hybrid;}
 @list l0:level1 {mso-level-number-format:bullet; mso-level-text:\F0B7; mso-level-tab-stop:none; text-indent:-.25in; font-family:Symbol;}
 @list l0:level2 {mso-level-number-format:bullet; mso-level-text:o; font-family:"Courier New";}
 @list l1:level1 {mso-level-tab-stop:none; mso-level-number-position:left; text-indent:-.25in;}
 @list l2:level1 {mso-level-number-format:chinese-counting; mso-level-text:"%1\3001";}
-->
</style>
</head>
<body lang=ZH-CN style='tab-interval:21.0pt'>
<!--StartFragment-->
<h1>第一章<span style='font-family:"等线"'> 开端</span><o:p></o:p></h1>
<p class=MsoNormal align=center style='text-align:center'><b>粗体</b>和<i>斜
体</i>，<u>下划线</u>，<s>删除线</s>，<span class=MsoIntenseEmphasis>强调</span>。<o:p></o:p></p>
<p class=MsoNormal>中间<span style='mso-spacerun:yes'>&nbsp;&nbsp; </span>空格<span style='mso-tab-count:1'>&nbsp;&nbsp;&nbsp; </span>制表<span style='display:none;mso-hide:all'>隐藏</span><span style='background:yellow;mso-highlight:yellow'>荧光</span><a href="https://example.com/a?b=1&amp;c=2">链接</a><a style='mso-footnote-id:ftn1' href="#_ftn1" name="_ftnref1"><span class=MsoFootnoteReference>[1]</span></a><o:p></o:p></p>
<p class=MsoNormal><o:p>&nbsp;</o:p></p>
<p class=MsoListParagraphCxSpFirst style='text-indent:-.25in;mso-list:l0 level1 lfo1'><![if !supportLists]><span style='font-family:Symbol'><span style='mso-list:Ignore'>·<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><![endif]>圆点一<o:p></o:p></p>
<p class=MsoListParagraphCxSpMiddle style='margin-left:1.0in;mso-add-space:auto;text-indent:-.25in;mso-list:l0 level2 lfo1'><![if !supportLists]><span style='font-family:"Courier New"'><span style='mso-list:Ignore'>o<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp; </span></span></span><![endif]>圆点二<o:p></o:p></p>
<p class=MsoListParagraphCxSpLast style='mso-list:l1 level1 lfo2'><![if !supportLists]><span><span style='mso-list:Ignore'>1.<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><![endif]>编号一<o:p></o:p></p>
<p class=MsoNormal style='mso-list:l2 level1 lfo3'><![if !supportLists]><span><span style='mso-list:Ignore'>一、</span></span><![endif]>中文编号<o:p></o:p></p>
<h2 style='mso-list:l1 level1 lfo2'><![if !supportLists]><span style='mso-list:Ignore'>2.<span>&nbsp;&nbsp; </span></span><![endif]>编号标题<o:p></o:p></h2>
<!--EndFragment-->
</body>
</html>"##;

#[test]
fn word_keeps_its_formats_and_drops_its_markup() {
    let f = read(WORD);
    assert_eq!(
        texts(&f),
        [
            "第一章 开端",
            "粗体和斜体，下划线，删除线，强调。",
            "中间   空格\t制表荧光链接[1]",
            "",
            "圆点一",
            "圆点二",
            "编号一",
            "一、中文编号",
            "2. 编号标题",
        ]
    );
    assert_eq!(
        looks(&f),
        [
            "heading=1",
            "align=center",
            "",
            "",
            "list=bullet",
            "list=bullet list_level=1",
            "list=ordered",
            "",
            "heading=2",
        ]
    );
    assert_eq!(marked(&f, inline::BOLD), [m(1, "粗体")]);
    assert_eq!(marked(&f, inline::ITALIC), [m(1, "斜体"), m(1, "强调")]);
    assert_eq!(marked(&f, inline::UNDERLINE), [m(1, "下划线")]);
    assert_eq!(marked(&f, inline::STRIKE), [m(1, "删除线")]);
    // Word's highlighter is not this editor's highlight; a footnote's
    // `#_ftn1` is no link.
    assert!(marked(&f, inline::HIGHLIGHT).is_empty());
    assert_eq!(marked(&f, inline::LINK), [m(2, "链接")]);
    assert_eq!(link_of(&f, 2), ["https://example.com/a?b=1&c=2"]);
}

#[test]
fn word_lists_written_in_comment_syntax() {
    // The other way Word writes its conditional markup: as comments around
    // the number, which still shows to anything but Word. Without a number
    // the list's definition decides; without either, a bullet.
    let html = r#"<html><head><style>
@list l0:level1 {mso-level-number-format:bullet;}
@list l1:level1 {mso-level-tab-stop:none;}
</style></head><body>
<p class=MsoListParagraph style='mso-list:l0 level1 lfo1'><!--[if !supportLists]--><span style='font-family:Symbol'><span style='mso-list:Ignore'>·<span>&nbsp;&nbsp; </span></span></span><!--[endif]-->圆点<o:p></o:p></p>
<p class=MsoListParagraph style='mso-list:l1 level1 lfo2'><!--[if !supportLists]--><span><span style='mso-list:Ignore'>1.<span>&nbsp; </span></span></span><!--[endif]-->编号<o:p></o:p></p>
<p class=MsoListParagraph style='mso-list:l1 level1 lfo2'>没有编号</p>
<p class=MsoListParagraph style='mso-list:l9 level1 lfo9'>没有定义</p>
<p class=MsoNormal style='mso-list:none'>不是列表</p>
</body></html>"#;
    let f = read(html);
    assert_eq!(
        texts(&f),
        ["圆点", "编号", "没有编号", "没有定义", "不是列表"]
    );
    assert_eq!(
        looks(&f),
        [
            "list=bullet",
            "list=ordered",
            "list=ordered",
            "list=bullet",
            ""
        ]
    );
}

#[test]
fn word_list_markers_without_a_style_sheet() {
    assert_eq!(word_item(None, Some("·\u{a0}\u{a0} ")), WordItem::Bullet);
    assert_eq!(word_item(None, Some("\u{f0b7}")), WordItem::Bullet);
    assert_eq!(word_item(None, Some("o")), WordItem::Bullet);
    assert_eq!(word_item(None, Some("12.")), WordItem::Ordered);
    assert_eq!(word_item(None, Some("a)")), WordItem::Literal("a)".into()));
    assert_eq!(
        word_item(None, Some("（一）")),
        WordItem::Literal("（一）".into())
    );
    assert_eq!(
        word_item(None, Some("1、")),
        WordItem::Literal("1、".into())
    );
    assert_eq!(
        word_item(Some(("bullet".into(), None)), Some("x")),
        WordItem::Bullet
    );
    assert_eq!(
        word_item(Some(("decimal".into(), None)), None),
        WordItem::Ordered
    );
    assert_eq!(word_item(None, None), WordItem::Bullet);
    assert_eq!(with_separator("（一）".into()), "（一）");
    assert_eq!(with_separator("a)".into()), "a) ");
}

// ----- Google Docs ----------------------------------------------------------------------

#[test]
fn google_docs() {
    let span = |extra: &str, text: &str| {
        format!(
            r#"<span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;{extra}">{text}</span>"#
        )
    };
    let html = format!(
        r#"<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-0a0b0c0d-7fff-1234-5678-9abcdef01234"><h2 dir="ltr" style="line-height:1.38;margin-top:18pt;margin-bottom:6pt;">{h}</h2><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;">{plain}{bold}{italic}{under}{struck}</p><br><ul style="margin-top:0;margin-bottom:0;padding-inline-start:48px;"><li dir="ltr" style="list-style-type:disc;font-size:11pt;" aria-level="1"><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;" role="presentation">{first}</p></li><ul style="margin-top:0;margin-bottom:0;"><li dir="ltr" style="list-style-type:circle;" aria-level="2"><p dir="ltr" role="presentation">{nested}</p></li></ul></ul><ol style="margin-top:0;margin-bottom:0;"><li dir="ltr" style="list-style-type:decimal;" aria-level="1"><p dir="ltr" role="presentation">{one}</p></li></ol><p dir="ltr" style="line-height:1.38;text-align: center;margin-top:0pt;margin-bottom:0pt;"><a href="https://example.org/" style="text-decoration:none;">{link}</a></p></b>"#,
        h = span("font-size:16pt;", "Heading two"),
        plain = span("", "Plain  "),
        bold = span("font-weight:700;", "bold"),
        italic = span("font-style:italic;", "italic"),
        under = span("text-decoration:underline;", "under"),
        struck = span("text-decoration:line-through;", "struck"),
        first = span("", "first"),
        nested = span("", "nested"),
        one = span("", "one"),
        link = span("color:#1155cc;text-decoration:underline;", "a link"),
    );
    let f = read(&html);
    assert_eq!(
        texts(&f),
        [
            "Heading two",
            "Plain  bolditalicunderstruck",
            "",
            "first",
            "nested",
            "one",
            "a link"
        ]
    );
    assert_eq!(
        looks(&f),
        [
            "heading=2",
            "",
            "",
            "list=bullet",
            "list=bullet list_level=1",
            "list=ordered",
            "align=center"
        ]
    );
    assert_eq!(marked(&f, inline::BOLD), [m(1, "bold")]);
    assert_eq!(marked(&f, inline::ITALIC), [m(1, "italic")]);
    assert_eq!(
        marked(&f, inline::UNDERLINE),
        [m(1, "under")],
        "not the link's"
    );
    assert_eq!(marked(&f, inline::STRIKE), [m(1, "struck")]);
    assert_eq!(link_of(&f, 6), ["https://example.org/"]);
}

// ----- browsers -------------------------------------------------------------------------

#[test]
fn a_web_page_as_a_browser_copies_it() {
    let html = r#"<meta charset='utf-8'><h1 style="color: rgb(32, 33, 36); font-family: Georgia;">Page Title</h1><p style="font-size: 16px;">Some <strong>strong</strong> and <em>emphasis</em> with <code>inline_code()</code> and <a href="https://example.net/x" style="color: blue;">a link</a>.</p><blockquote><p>Quoted line</p></blockquote><pre><code class="language-rust">fn main() {
    println!("hi");

}
</code></pre><ul><li>Item <b>one</b></li><li>Item two<ul><li>Deep</li></ul></li></ul><hr><p>After <img src="https://example.net/i.png" alt="pic"> rule<script>alert(1)</script><span onclick="evil()">ok</span></p><h4>Small heading</h4><table><tbody><tr><th>Name</th><th>Age</th></tr><tr><td>Ann</td><td><b>30</b></td></tr></tbody></table>"#;
    let f = read(html);
    assert_eq!(
        texts(&f),
        [
            "Page Title",
            "Some strong and emphasis with inline_code() and a link.",
            "Quoted line",
            "fn main() {",
            "    println!(\"hi\");",
            "",
            "}",
            "Item one",
            "Item two",
            "Deep",
            "",
            "After ruleok",
            "Small heading",
            "Name\tAge",
            "Ann\t30",
        ]
    );
    assert_eq!(
        looks(&f),
        [
            "heading=1",
            "",
            "quote",
            "code_block=rust",
            "code_block=rust",
            "code_block=rust",
            "code_block=rust",
            "list=bullet",
            "list=bullet",
            "list=bullet list_level=1",
            "rule",
            "",
            "",
            "",
            "",
        ]
    );
    assert_eq!(
        marked(&f, inline::BOLD),
        [m(1, "strong"), m(7, "one"), m(14, "30")]
    );
    assert_eq!(marked(&f, inline::ITALIC), [m(1, "emphasis")]);
    assert_eq!(marked(&f, inline::CODE), [m(1, "inline_code()")]);
    assert_eq!(marked(&f, inline::LINK), [m(1, "a link")]);
}

#[test]
fn links_go_only_where_they_are_safe() {
    let f = read(
        r##"<p><a href="javascript:alert(1)">js</a> <a href="/relative">rel</a> <a href="#top">top</a> <a href="data:text/html,x">data</a> <a href=" mailto:a@example.com ">mail</a> <a href="tel:+100">tel</a> <a href="HTTPS://EXAMPLE.COM/
path">up</a></p>"##,
    );
    assert_eq!(texts(&f), ["js rel top data mail tel up"]);
    assert_eq!(
        marked(&f, inline::LINK),
        [m(0, "mail"), m(0, "tel"), m(0, "up")]
    );
    assert_eq!(
        link_of(&f, 0),
        [
            "mailto:a@example.com",
            "tel:+100",
            "HTTPS://EXAMPLE.COM/path"
        ]
    );
}

#[test]
fn bold_and_italic_by_style_and_back_off() {
    let f = read(
        r#"<p><b>on<span style="font-weight:normal">off</span><span style="font-weight:400">off</span><span style="font-weight:500">off</span></b><span style="font-weight:600">on</span><span style="font-weight:bolder">on</span></p><p><i>it<span style="font-style:normal">up</span></i><i style="font-style:normal">up</i><em>it</em><span style="FONT-STYLE: Italic !important">it</span></p>"#,
    );
    assert_eq!(texts(&f), ["onoffoffoffonon", "itupupitit"]);
    assert_eq!(marked(&f, inline::BOLD), [m(0, "on"), m(0, "onon")]);
    assert_eq!(marked(&f, inline::ITALIC), [m(1, "it"), m(1, "itit")]);
}

// ----- the system's RTF reader ---------------------------------------------------------

/// What macOS makes of RTF (Pages, TextEdit, Scrivener) when Drifting asks
/// for HTML: formats on classes in the head.
#[test]
fn cocoa_html_from_rtf() {
    let html = r#"<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<meta name="Generator" content="Cocoa HTML Writer">
<style type="text/css">
p.p1 {margin: 0.0px 0.0px 0.0px 0.0px; text-align: center; font: 24.0px Helvetica}
p.p2 {margin: 0.0px 0.0px 0.0px 0.0px; font: 12.0px Helvetica}
li.li2 {margin: 0.0px 0.0px 0.0px 0.0px; font: 12.0px Helvetica}
span.s1 {text-decoration: underline}
span.s2 {text-decoration: line-through}
span.Apple-tab-span {white-space:pre}
ul.ul1 {list-style-type: disc}
</style>
</head>
<body>
<p class="p1"><b>章节标题</b></p>
<p class="p2">Plain <b>bold</b> <i>italic</i> <span class="s1">underline</span> <span class="s2">struck</span><span class="Apple-converted-space">&nbsp; </span>end<span class="Apple-tab-span">	</span>tab</p>
<ul class="ul1">
  <li class="li2">one</li>
  <li class="li2">two</li>
</ul>
</body>
</html>"#;
    let f = read(html);
    assert_eq!(
        texts(&f),
        [
            "章节标题",
            "Plain bold italic underline struck  end\ttab",
            "one",
            "two"
        ]
    );
    assert_eq!(
        looks(&f),
        ["align=center", "", "list=bullet", "list=bullet"]
    );
    assert_eq!(marked(&f, inline::BOLD), [m(0, "章节标题"), m(1, "bold")]);
    assert_eq!(marked(&f, inline::UNDERLINE), [m(1, "underline")]);
    assert_eq!(marked(&f, inline::STRIKE), [m(1, "struck")]);
}

// ----- Drifting 0.1 ---------------------------------------------------------------------

#[test]
fn drifting_0_1_copies() {
    let html = r#"<meta charset='utf-8'><p data-pm-slice="1 1 []" data-block-id="b1">第一段<span data-target-id="e1" data-target-kind="element" class="entity-link entity-link--element" style="cursor: pointer;">约格</span></p><p data-indent="2" data-block-id="b2" style="text-align: center">缩进居中</p><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked="checked"><span></span></label><div><p>已完成</p></div></li><li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>未完成</p></div></li></ul><aside data-callout="" class="note-callout"><p>提示内容</p></aside><figure data-material-embed="" data-library-item-id="x"></figure><p><mark>高亮</mark></p>"#;
    let f = read(html);
    assert_eq!(
        texts(&f),
        [
            "第一段约格",
            "缩进居中",
            "已完成",
            "未完成",
            "提示内容",
            "高亮"
        ]
    );
    assert_eq!(
        looks(&f),
        [
            "",
            "indent=2 align=center",
            "list=task checked",
            "list=task",
            "callout=note",
            ""
        ]
    );
    assert!(f.paragraphs[0].marks.is_empty(), "no entity link from HTML");
    assert_eq!(marked(&f, inline::HIGHLIGHT), [m(5, "高亮")]);
}

#[test]
fn checkboxes_make_task_items() {
    let f = read(
        r#"<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled checked> done</li><li class="task-list-item"><input type="checkbox" disabled> open</li><li>plain <input type="checkbox"> later</li></ul>"#,
    );
    assert_eq!(texts(&f), ["done", "open", "plain later"]);
    assert_eq!(looks(&f), ["list=task checked", "list=task", "list=bullet"]);
}

// ----- white space and paragraphs ------------------------------------------------------

#[test]
fn white_space_collapses_as_in_a_browser() {
    let f = read(
        "<p>  a \n  b\t c  </p><p>中\n文 与\n English\n字</p><p>a<br>b<br><br></p><div><br></div><p>x&nbsp;y &nbsp; z&nbsp;</p><p>&nbsp;</p><p>　　缩进</p>",
    );
    assert_eq!(
        texts(&f),
        [
            "a b c",
            "中文 与 English 字",
            "a\u{2028}b",
            "",
            "x\u{a0}y   z\u{a0}",
            "",
            "　　缩进"
        ]
    );
}

#[test]
fn kept_white_space() {
    // A code editor's copy: lines as divs, spaces kept.
    let f = read(
        r#"<div style="color: #d4d4d4;font-family: Menlo, monospace;white-space: pre;"><div><span style="color: #569cd6;">fn</span> x() {</div><div>    y  z</div><div><br></div><div>}</div></div><p style="white-space:pre-line">one   two
three</p>"#,
    );
    assert_eq!(
        texts(&f),
        ["fn x() {", "    y  z", "", "}", "one two", "three"]
    );
    assert_eq!(looks(&f), ["", "", "", "", "", ""]);
}

#[test]
fn implied_ends_and_bad_nesting() {
    let f = read("<p>one<p>two<ul><li>a<li>b</ul><b><p>bold</b> still</p><i>open");
    assert_eq!(texts(&f), ["one", "two", "a", "b", "bold still", "open"]);
    assert_eq!(looks(&f), ["", "", "list=bullet", "list=bullet", "", ""]);
    assert_eq!(marked(&f, inline::ITALIC), [m(5, "open")]);
    // An `li`'s later blocks stay in the item.
    let f = read("<ol><li><p>first</p><p>more</p><pre>code</pre></li></ol>");
    assert_eq!(texts(&f), ["first\u{2028}more", "code"]);
    assert_eq!(looks(&f), ["list=ordered", "code_block="]);
}

#[test]
fn nothing_to_paste_is_none() {
    for html in [
        "",
        "<img src='https://example.com/a.png'>",
        "<script>alert(1)</script><style>p{}</style>",
        "<p></p><p> </p>",
        "<!-- only a comment -->",
        "<head><title>t</title></head>",
    ] {
        assert_eq!(parse(html), None, "{html:?}");
    }
    let f = read("<hr>");
    assert!(f.paragraphs[0].is_rule());
}

#[test]
fn hidden_and_dropped_content() {
    let f = read(
        r#"<p>a<span hidden>b</span><span style="display: none">c</span><span style="visibility:hidden">d</span><svg><text>e</text></svg><select><option>f</option></select><ruby>漢<rp>(</rp><rt>かん</rt><rp>)</rp></ruby><sup>2</sup><textarea>g</textarea><noscript>h</noscript>z</p>"#,
    );
    assert_eq!(texts(&f), ["a漢2z"]);
}

#[test]
fn objects_and_control_characters_never_reach_the_text() {
    let f = read("<p>a\u{fffc}b\u{0}c\u{7}d\u{feff}e\u{2028}f</p>");
    assert_eq!(texts(&f), ["abcde\u{2028}f"]);
}

#[test]
fn large_or_deep_input_is_bounded() {
    let big = "a".repeat(MAX_HTML_BYTES + 1);
    assert_eq!(parse(&big), None);
    // Ten thousand unclosed elements: read, no stack overflow.
    let deep = format!(
        "{}x{}",
        "<span><b>".repeat(5_000),
        "</b></span>".repeat(5_000)
    );
    let f = read(&deep);
    assert_eq!(texts(&f), ["x"]);
    assert_eq!(marked(&f, inline::BOLD), [m(0, "x")]);
    // Each `<div>` ends the `<p>` before it (an empty paragraph, as an
    // empty `<p></p>` is); past the depth limit the rest is the content of
    // the deepest element.
    let unclosed = format!("{}y", "<div><p><i>".repeat(10_000));
    let f = read(&unclosed);
    assert!(f.paragraphs.len() <= MAX_DEPTH, "{}", f.paragraphs.len());
    assert_eq!(texts(&f).last(), Some(&"y"));
    assert!(texts(&f).iter().rev().skip(1).all(|t| t.is_empty()));
}

#[test]
fn every_byte_sequence_is_read_without_failing() {
    // A cheap fuzz: slices of the samples at every char boundary.
    let mut n = 0usize;
    for sample in [
        WORD,
        "<p a='1\" b=2>x</p><!-- <p>y</p",
        "<<<>>>&&&;;<a href=x",
    ] {
        for (at, _) in sample.char_indices().step_by(7) {
            let _ = parse(&sample[at..]);
            let _ = parse(&sample[..at]);
            n += 1;
        }
    }
    assert!(n > 100);
}
