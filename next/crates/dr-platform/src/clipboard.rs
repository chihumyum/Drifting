//! The formatted text on the system clipboard, as HTML: what GPUI's own
//! clipboard does not read (it gives plain text, pictures and files). The
//! editor's ⌘V keeps the formatting of what other programs copied with it
//! (dr-editor, `gpui_prose::html`).
//!
//! - **macOS**: the general pasteboard's `public.html` (browsers, Word);
//!   without it, its `public.rtf` (Pages, TextEdit, Scrivener and every
//!   other Cocoa text view, which write RTF and no HTML), turned into HTML by
//!   AppKit's own converter, as the 0.1 client's web view did. Nothing is
//!   fetched and nothing runs: RTF in, HTML text out.
//! - **Windows**: the clipboard's `HTML Format` (CF_HTML), from where its
//!   header says the HTML starts.
//! - Elsewhere: none.
//!
//! Reading never fails: anything unreadable, or larger than [`MAX_BYTES`],
//! is `None`, and the paste is plain text. Call it on the main thread, right
//! after GPUI read the plain text, so both are the same copy.

/// The largest HTML or RTF read (8 MiB, as `gpui_prose::html`).
pub const MAX_BYTES: usize = 8 << 20;

/// The HTML the clipboard holds besides its plain text, if any.
pub fn read_html() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        mac::read_html()
    }
    #[cfg(windows)]
    {
        win::read_html()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        None
    }
}

/// Appends `html` (`public.html` on macOS, `HTML Format` / CF_HTML on Windows)
/// to the system clipboard alongside what GPUI just wrote (plain text and
/// custom metadata), so pasting into Word, Pages, browsers, or Notion preserves
/// formatting while Drifting's own paste still reads GPUI's metadata.
pub fn write_html(html: &str) {
    if html.is_empty() || html.len() > MAX_BYTES {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        mac::write_html(html);
    }
    #[cfg(windows)]
    {
        win::write_html(html);
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = html;
    }
}

/// Wraps an HTML fragment in a Windows `CF_HTML` (`HTML Format`) payload
/// (UTF-8, NUL-terminated).
pub fn encode_cf_html(fragment: &str) -> Vec<u8> {
    const PREFIX: &str = "<html>\r\n<body>\r\n<!--StartFragment-->";
    const SUFFIX: &str = "<!--EndFragment-->\r\n</body>\r\n</html>";
    let header = |start_html: usize, end_html: usize, start_frag: usize, end_frag: usize| {
        format!(
            "Version:0.9\r\nStartHTML:{start_html:010}\r\nEndHTML:{end_html:010}\r\nStartFragment:{start_frag:010}\r\nEndFragment:{end_frag:010}\r\n"
        )
    };
    let hlen = header(0, 0, 0, 0).len();
    let start_html = hlen;
    let start_frag = start_html + PREFIX.len();
    let end_frag = start_frag + fragment.len();
    let end_html = end_frag + SUFFIX.len();
    let mut out = String::with_capacity(end_html + 1);
    out.push_str(&header(start_html, end_html, start_frag, end_frag));
    out.push_str(PREFIX);
    out.push_str(fragment);
    out.push_str(SUFFIX);
    out.push('\0');
    out.into_bytes()
}

/// HTML bytes as text: UTF-8 (its byte-order mark dropped), UTF-16 with a
/// byte-order mark, else (bytes that are not UTF-8, from an old program)
/// Windows-1252.
pub fn decode_html(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    let utf16 = |rest: &[u8], le: bool| {
        let units: Vec<u16> = rest
            .as_chunks::<2>()
            .0
            .iter()
            .map(|p| {
                if le {
                    u16::from_le_bytes(*p)
                } else {
                    u16::from_be_bytes(*p)
                }
            })
            .collect();
        String::from_utf16_lossy(&units)
    };
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return utf16(rest, true);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return utf16(rest, false);
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_owned(),
        // Cut off in the middle of a character: UTF-8 all the same.
        Err(e) if e.error_len().is_none() => String::from_utf8_lossy(bytes).into_owned(),
        Err(_) => bytes.iter().map(|b| windows_1252(*b)).collect(),
    }
}

/// One byte of Windows-1252.
fn windows_1252(b: u8) -> char {
    const HIGH: [u16; 32] = [
        0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160,
        0x2039, 0x0152, 0x8D, 0x017D, 0x8F, 0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013,
        0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178,
    ];
    match b {
        0x80..=0x9F => char::from_u32(u32::from(HIGH[usize::from(b - 0x80)])).unwrap_or('\u{fffd}'),
        b => char::from(b),
    }
}

/// The HTML of a CF_HTML buffer (`Version:0.9`, `StartHTML:…`, `EndHTML:…`
/// and the fragment's offsets, then the HTML; all UTF-8): from `StartHTML`
/// to `EndHTML` when they are right, else from the first `<` to the end.
/// The fragment's markers are comments to the HTML reader; what Word puts
/// around them (its styles and list definitions) is needed.
pub fn cf_html(bytes: &[u8]) -> Option<String> {
    let bytes = &bytes[..bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len())];
    let header_end = bytes.iter().position(|b| *b == b'<')?;
    let header = String::from_utf8_lossy(&bytes[..header_end]);
    let offset = |key: &str| {
        header.lines().find_map(|line| {
            let value = line.trim().strip_prefix(key)?.strip_prefix(':')?;
            usize::try_from(value.trim().parse::<i64>().ok()?).ok()
        })
    };
    let start = offset("StartHTML")
        .filter(|s| bytes.get(*s) == Some(&b'<'))
        .unwrap_or(header_end);
    let end = offset("EndHTML")
        .filter(|e| *e > start && *e <= bytes.len())
        .unwrap_or(bytes.len());
    let html = String::from_utf8_lossy(&bytes[start..end]).into_owned();
    (!html.trim().is_empty()).then_some(html)
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2::{AnyThread as _, runtime::AnyObject};
    use objc2_app_kit::{
        NSAttributedStringAppKitDocumentFormats as _, NSAttributedStringDocumentFormats as _,
        NSDocumentTypeDocumentAttribute, NSHTMLTextDocumentType, NSPasteboard,
        NSPasteboardTypeHTML, NSPasteboardTypeRTF,
    };
    use objc2_foundation::{NSArray, NSAttributedString, NSData, NSDictionary, NSRange};

    use super::{MAX_BYTES, decode_html};

    pub(super) fn read_html() -> Option<String> {
        read_from(&NSPasteboard::generalPasteboard())
    }

    pub(super) fn write_html(html: &str) {
        append_to(&NSPasteboard::generalPasteboard(), html);
    }

    /// Appends `public.html` to `pasteboard` without clearing existing types.
    pub(super) fn append_to(pasteboard: &NSPasteboard, html: &str) {
        // SAFETY: AppKit's constant pasteboard type; `addTypes:owner:` adds the
        // type to the current pasteboard item without discarding existing data.
        let kind = unsafe { NSPasteboardTypeHTML };
        unsafe {
            pasteboard.addTypes_owner(&NSArray::from_slice(&[kind]), None);
        }
        let _ = pasteboard.setData_forType(Some(&NSData::with_bytes(html.as_bytes())), kind);
    }

    /// The HTML of `pasteboard` (tests read their own, never the general
    /// one).
    pub(super) fn read_from(pasteboard: &NSPasteboard) -> Option<String> {
        let types = pasteboard.types()?;
        // SAFETY: AppKit's constant pasteboard types.
        let (html, rtf) = unsafe { (NSPasteboardTypeHTML, NSPasteboardTypeRTF) };
        if types.containsObject(html) {
            let data = pasteboard.dataForType(html)?;
            return (data.length() <= MAX_BYTES).then(|| decode_html(&data.to_vec()));
        }
        if types.containsObject(rtf) {
            let data = pasteboard.dataForType(rtf)?;
            return (data.length() <= MAX_BYTES)
                .then(|| rtf_to_html(&data))
                .flatten();
        }
        None
    }

    /// AppKit's reading of RTF, written out as HTML.
    fn rtf_to_html(rtf: &NSData) -> Option<String> {
        // SAFETY: `initWithRTF:documentAttributes:` with no attributes to
        // return; RTF has no scripts and refers to nothing outside itself.
        let text = unsafe {
            NSAttributedString::initWithRTF_documentAttributes(
                NSAttributedString::alloc(),
                rtf,
                None,
            )
        }?;
        // SAFETY: AppKit's constant keys and values.
        let (key, value) = unsafe { (NSDocumentTypeDocumentAttribute, NSHTMLTextDocumentType) };
        let value: &AnyObject = value.as_ref();
        let attributes = NSDictionary::from_slices(&[key], &[value]);
        // SAFETY: the dictionary maps a document attribute key to an
        // object, as the method takes.
        let html = unsafe {
            text.dataFromRange_documentAttributes_error(NSRange::new(0, text.length()), &attributes)
        }
        .ok()?;
        Some(decode_html(&html.to_vec()))
    }

    #[cfg(test)]
    mod tests {
        use objc2::{msg_send, rc::Retained};
        use objc2_app_kit::{
            NSPasteboard, NSPasteboardType, NSPasteboardTypeHTML, NSPasteboardTypeRTF,
        };
        use objc2_foundation::{NSArray, NSData};

        use super::read_from;

        /// A private pasteboard holding `items`: the general one (the
        /// author's clipboard) is never read or written.
        fn with_pasteboard(
            items: &[(&NSPasteboardType, &[u8])],
            check: impl FnOnce(&NSPasteboard),
        ) {
            let pasteboard: Retained<NSPasteboard> = NSPasteboard::pasteboardWithUniqueName();
            let types: Vec<&NSPasteboardType> = items.iter().map(|(t, _)| *t).collect();
            // SAFETY: no owner object.
            unsafe { pasteboard.declareTypes_owner(&NSArray::from_slice(&types), None) };
            for (kind, bytes) in items {
                assert!(pasteboard.setData_forType(Some(&NSData::with_bytes(bytes)), kind));
            }
            check(&pasteboard);
            // SAFETY: `releaseGlobally` takes nothing and returns nothing.
            let _: () = unsafe { msg_send![&*pasteboard, releaseGlobally] };
        }

        #[test]
        fn html_first() {
            // SAFETY: AppKit's constant pasteboard types.
            let (html, rtf) = unsafe { (NSPasteboardTypeHTML, NSPasteboardTypeRTF) };
            let page = "<p><b>粗体</b> and text</p>";
            with_pasteboard(&[(rtf, b"{\\rtf1 x}"), (html, page.as_bytes())], |p| {
                assert_eq!(read_from(p).as_deref(), Some(page));
            });
        }

        #[test]
        fn rtf_becomes_html() {
            // SAFETY: AppKit's constant pasteboard type.
            let rtf = unsafe { NSPasteboardTypeRTF };
            let doc = b"{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl\\f0\\fswiss Helvetica;}\\f0\\fs24 Plain {\\b bold} {\\i italic} {\\ul under}\\par\\qc \\uc0\\u20013\\u25991 \\par}";
            with_pasteboard(&[(rtf, doc)], |p| {
                let html = read_from(p).expect("HTML from RTF");
                assert!(html.contains("<b>bold</b>"), "{html}");
                assert!(html.contains("<i>italic</i>"), "{html}");
                assert!(html.contains("中文"), "{html}");
                // Underline and centring are class rules in the head.
                assert!(html.contains("text-decoration: underline"), "{html}");
                assert!(html.contains("text-align: center"), "{html}");
            });
        }

        #[test]
        fn nothing_rich_is_none() {
            with_pasteboard(&[], |p| assert_eq!(read_from(p), None));
            let plain = objc2_foundation::NSString::from_str("public.utf8-plain-text");
            with_pasteboard(&[(&plain, b"just text")], |p| {
                assert_eq!(read_from(p), None)
            });
            // SAFETY: AppKit's constant pasteboard type.
            let rtf = unsafe { NSPasteboardTypeRTF };
            with_pasteboard(&[(rtf, b"not rtf at all")], |p| {
                // Whatever AppKit makes of it, never a failure.
                let _ = read_from(p);
            });
        }

        #[test]
        fn too_large_is_none() {
            // SAFETY: AppKit's constant pasteboard type.
            let html = unsafe { NSPasteboardTypeHTML };
            let big = vec![b'a'; super::MAX_BYTES + 1];
            with_pasteboard(&[(html, &big)], |p| assert_eq!(read_from(p), None));
        }

        #[test]
        fn append_html_preserves_existing_types() {
            let plain = objc2_foundation::NSString::from_str("public.utf8-plain-text");
            let custom = objc2_foundation::NSString::from_str("cc.drifting.test.meta");
            with_pasteboard(&[(&plain, b"hello"), (&custom, b"{\"v\":1}")], |p| {
                super::append_to(p, "<p><b>hello</b></p>");
                assert_eq!(read_from(p).as_deref(), Some("<p><b>hello</b></p>"));
                assert_eq!(
                    p.dataForType(&plain).map(|d| d.to_vec()),
                    Some(b"hello".to_vec())
                );
                assert_eq!(
                    p.dataForType(&custom).map(|d| d.to_vec()),
                    Some(b"{\"v\":1}".to_vec())
                );
            });
        }
    }
}

#[cfg(windows)]
mod win {
    use windows::{
        Win32::{
            Foundation::{GlobalFree, HANDLE, HGLOBAL},
            System::{
                DataExchange::{
                    CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
                    RegisterClipboardFormatW, SetClipboardData,
                },
                Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock},
            },
        },
        core::w,
    };

    use super::{MAX_BYTES, cf_html, encode_cf_html};

    pub(super) fn write_html(html: &str) {
        let bytes = encode_cf_html(html);
        // SAFETY: registers the standard CF_HTML format and appends it to the
        // currently open clipboard without calling `EmptyClipboard`, preserving
        // GPUI's plain text and metadata.
        unsafe {
            let format = RegisterClipboardFormatW(w!("HTML Format"));
            if format == 0 || OpenClipboard(None).is_err() {
                return;
            }
            if let Ok(global) = GlobalAlloc(GMEM_MOVEABLE, bytes.len()) {
                let ptr = GlobalLock(global) as *mut u8;
                if !ptr.is_null() {
                    std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
                    let _ = GlobalUnlock(global);
                    if SetClipboardData(format, Some(HANDLE(global.0))).is_err() {
                        let _ = GlobalFree(Some(global));
                    }
                } else {
                    let _ = GlobalFree(Some(global));
                }
            }
            let _ = CloseClipboard();
        }
    }

    pub(super) fn read_html() -> Option<String> {
        // SAFETY: registering a format name is idempotent and has no other
        // effect; the clipboard is opened, read and closed here, its memory
        // only read while locked.
        unsafe {
            let format = RegisterClipboardFormatW(w!("HTML Format"));
            if format == 0 || IsClipboardFormatAvailable(format).is_err() {
                return None;
            }
            OpenClipboard(None).ok()?;
            let bytes = read(format);
            let _ = CloseClipboard();
            cf_html(&bytes?)
        }
    }

    /// The bytes of clipboard format `format` (the clipboard is open).
    unsafe fn read(format: u32) -> Option<Vec<u8>> {
        // SAFETY: the caller opened the clipboard; the handle is the
        // clipboard's and stays valid until it is closed.
        unsafe {
            let handle = GetClipboardData(format).ok()?;
            let global = HGLOBAL(handle.0);
            let size = GlobalSize(global);
            // The header comes on top of the HTML.
            if size == 0 || size > MAX_BYTES + 4096 {
                return None;
            }
            let ptr = GlobalLock(global);
            if ptr.is_null() {
                return None;
            }
            let bytes = std::slice::from_raw_parts(ptr as *const u8, size).to_vec();
            let _ = GlobalUnlock(global);
            Some(bytes)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodings() {
        assert_eq!(decode_html("<p>中文</p>".as_bytes()), "<p>中文</p>");
        assert_eq!(decode_html(b"\xEF\xBB\xBF<p>x</p>"), "<p>x</p>");
        let le: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain("<b>中</b>".encode_utf16().flat_map(u16::to_le_bytes))
            .collect();
        assert_eq!(decode_html(&le), "<b>中</b>");
        let be: Vec<u8> = [0xFE, 0xFF]
            .into_iter()
            .chain("<b>中</b>".encode_utf16().flat_map(u16::to_be_bytes))
            .collect();
        assert_eq!(decode_html(&be), "<b>中</b>");
        assert_eq!(decode_html(b"caf\xE9 \x93q\x94 \x80"), "café “q” €");
        // Cut off inside a character: still UTF-8.
        let cut = &"中文".as_bytes()[..4];
        assert_eq!(decode_html(cut), "中\u{fffd}");
    }

    fn cf(html: &str, fragment: &str) -> Vec<u8> {
        // The header has fixed-width numbers, so its length is known first.
        let header = |a: usize, b: usize, c: usize, d: usize| {
            format!(
                "Version:0.9\r\nStartHTML:{a:010}\r\nEndHTML:{b:010}\r\nStartFragment:{c:010}\r\nEndFragment:{d:010}\r\nSourceURL:https://example.com/\r\n"
            )
        };
        let len = header(0, 0, 0, 0).len();
        let at = html.find(fragment).unwrap();
        let out = header(len, len + html.len(), len + at, len + at + fragment.len()) + html;
        out.into_bytes()
    }

    #[test]
    fn cf_html_by_its_header() {
        let html = "<html><body>\r\n<!--StartFragment--><p>中文 <b>x</b></p><!--EndFragment-->\r\n</body></html>";
        let mut bytes = cf(html, "<p>中文 <b>x</b></p>");
        assert_eq!(cf_html(&bytes).as_deref(), Some(html));
        // A NUL ends it.
        bytes.extend_from_slice(b"\0garbage");
        assert_eq!(cf_html(&bytes).as_deref(), Some(html));
    }

    #[test]
    fn cf_html_with_a_wrong_header() {
        let html = "<p>x</p>";
        let bytes =
            format!("Version:0.9\r\nStartHTML:-1\r\nEndHTML:-1\r\nStartFragment:999\r\n{html}");
        assert_eq!(cf_html(bytes.as_bytes()).as_deref(), Some(html));
        let bytes = format!("Version:0.9\r\nStartHTML:3\r\nEndHTML:99999\r\n{html}");
        assert_eq!(cf_html(bytes.as_bytes()).as_deref(), Some(html));
        assert_eq!(cf_html(b"Version:0.9\r\nno html"), None);
        assert_eq!(cf_html(b""), None);
    }
}
