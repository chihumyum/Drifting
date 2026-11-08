//! Synthetic media for image and PDF materials (M19): made here, from
//! code, so no picture or document is committed and nothing comes from
//! anyone's library.
//!
//! - [`png`]: a drawn map (paper, a lake, blocks, a river), any size;
//! - [`pdf`]: a PDF of pages written as content streams, with Helvetica
//!   (a standard font, never embedded) and a Chinese font that is not
//!   embedded either (`STSong-Light`, Adobe-GB1), so a renderer has to find
//!   both itself;
//! - [`sample_pdf`]: three A5 pages of a field notebook.

/// A PNG of `width` × `height`: warm paper, a lake, a few blocks and a
/// river, the same every time.
pub fn png(width: u32, height: u32) -> Vec<u8> {
    let (w, h) = (width.max(1) as usize, height.max(1) as usize);
    let mut rgba = vec![0u8; w * h * 4];
    let paper = [240.0, 233.0, 218.0];
    let ink = [74.0, 84.0, 104.0];
    let lake = [150.0, 182.0, 196.0];
    let block = [196.0, 170.0, 140.0];
    let (fw, fh) = (w as f32, h as f32);
    for y in 0..h {
        for x in 0..w {
            let (u, v) = (x as f32 / fw, y as f32 / fh);
            // Paper with a little grain.
            let grain = ((x * 31 + y * 17) % 7) as f32 - 3.0;
            let mut c = [paper[0] + grain, paper[1] + grain, paper[2] + grain];
            // The lake: an ellipse in the upper left.
            let (dx, dy) = ((u - 0.3) / 0.2, (v - 0.32) / 0.16);
            if dx * dx + dy * dy < 1.0 {
                c = lake;
            }
            // Blocks: a grid in the lower right.
            let (bx, by) = ((u - 0.55) / 0.08, (v - 0.55) / 0.08);
            if (0.0..5.0).contains(&bx)
                && (0.0..5.0).contains(&by)
                && bx.fract() < 0.78
                && by.fract() < 0.78
            {
                c = block;
            }
            // The river: a band along a sine.
            let river = 0.75 + 0.08 * (u * 9.0).sin();
            if (v - river).abs() < 0.012 {
                c = ink;
            }
            let i = (y * w + x) * 4;
            rgba[i] = c[0].clamp(0.0, 255.0) as u8;
            rgba[i + 1] = c[1].clamp(0.0, 255.0) as u8;
            rgba[i + 2] = c[2].clamp(0.0, 255.0) as u8;
            rgba[i + 3] = 255;
        }
    }
    let mut out = Vec::new();
    let mut encoder = ::png::Encoder::new(&mut out, w as u32, h as u32);
    encoder.set_color(::png::ColorType::Rgba);
    encoder.set_depth(::png::BitDepth::Eight);
    let mut writer = encoder.write_header().expect("an in-memory PNG header");
    writer
        .write_image_data(&rgba)
        .expect("an in-memory PNG body");
    writer.finish().expect("an in-memory PNG end");
    out
}

/// One page: its size in points and its content stream. The resources are
/// `/F1` (Helvetica) and `/F2` (a Chinese font, not embedded, text as
/// UCS-2 hex: see [`ucs2`]).
#[derive(Clone, Debug)]
pub struct PdfPage {
    pub width: f32,
    pub height: f32,
    pub content: String,
}

/// `text` as the hex string `/F2` reads (`<6F6E…>`).
pub fn ucs2(text: &str) -> String {
    let hex: String = text.encode_utf16().map(|u| format!("{u:04X}")).collect();
    format!("<{hex}>")
}

/// A PDF of `pages`, with a correct cross-reference table.
pub fn pdf(pages: &[PdfPage]) -> Vec<u8> {
    let n = pages.len();
    let mut objects: Vec<String> = vec![
        "<< /Type /Catalog /Pages 2 0 R >>".into(),
        format!(
            "<< /Type /Pages /Kids [{}] /Count {n} >>",
            (0..n)
                .map(|i| format!("{} 0 R", 7 + i * 2))
                .collect::<Vec<_>>()
                .join(" ")
        ),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".into(),
        "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H \
         /DescendantFonts [5 0 R] >>"
            .into(),
        "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo \
         << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 6 0 R /DW 1000 >>"
            .into(),
        "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] \
         /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>"
            .into(),
    ];
    for (i, page) in pages.iter().enumerate() {
        objects.push(format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {} {}] \
             /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents {} 0 R >>",
            page.width,
            page.height,
            8 + i * 2
        ));
        objects.push(format!(
            "<< /Length {} >>\nstream\n{}\nendstream",
            page.content.len(),
            page.content
        ));
    }
    let mut out = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n".to_vec();
    let mut offsets = Vec::with_capacity(objects.len());
    for (i, object) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend(format!("{} 0 obj\n{object}\nendobj\n", i + 1).as_bytes());
    }
    let xref = out.len();
    out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for offset in offsets {
        out.extend(format!("{offset:010} 00000 n \n").as_bytes());
    }
    out.extend(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    out
}

/// A5 in points.
pub const A5: (f32, f32) = (420.0, 595.0);

/// Three A5 pages of a field notebook: a title in Helvetica and a line in
/// Chinese over a sketched coast; a table of tides; a page of boxes.
pub fn sample_pdf() -> Vec<u8> {
    let (w, h) = A5;
    let page = |content: String| PdfPage {
        width: w,
        height: h,
        content,
    };
    let first = format!(
        "0.94 0.91 0.85 rg 30 300 360 250 re f\n\
         0.25 0.33 0.45 RG 2 w 40 330 m 120 520 250 300 380 470 c S\n\
         0.55 0.68 0.75 rg 230 340 m 300 340 330 400 300 430 c 260 470 200 420 230 340 c f\n\
         0.15 0.15 0.18 rg BT /F1 22 Tf 40 250 Td (Tide notebook) Tj ET\n\
         BT /F2 16 Tf 40 215 Td {} Tj ET\n\
         BT /F1 11 Tf 40 180 Td (Field sketches of the east coast, kept for chapter four.) Tj ET\n",
        ucs2("潮汐笔记：东岸速写，第四章用。")
    );
    let mut table = String::from("0.15 0.15 0.18 rg BT /F1 18 Tf 40 540 Td (High water) Tj ET\n");
    table.push_str("0.4 0.4 0.45 RG 0.6 w\n");
    for row in 0..9 {
        let y = 500.0 - row as f32 * 36.0;
        table.push_str(&format!("40 {y} m 380 {y} l S\n"));
        table.push_str(&format!(
            "BT /F1 12 Tf 48 {} Td (Day {}) Tj 140 0 Td ({}:{:02}) Tj 120 0 Td ({}.{} m) Tj ET\n",
            y - 24.0,
            row + 1,
            5 + row,
            (row * 13) % 60,
            2 + row % 3,
            (row * 7) % 10
        ));
    }
    let mut boxes = String::new();
    for (i, (r, g, b)) in [(0.75, 0.35, 0.3), (0.35, 0.55, 0.45), (0.3, 0.4, 0.7)]
        .into_iter()
        .enumerate()
    {
        let x = 50.0 + i as f32 * 115.0;
        boxes.push_str(&format!("{r} {g} {b} rg {x} 360 95 140 re f\n"));
    }
    boxes.push_str(&format!(
        "0.15 0.15 0.18 rg BT /F2 14 Tf 50 320 Td {} Tj ET\n",
        ucs2("三处礁石")
    ));
    pdf(&[page(first), page(table), page(boxes)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_png_is_a_png_of_its_size() {
        let bytes = png(64, 40);
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        // IHDR width and height.
        assert_eq!(u32::from_be_bytes(bytes[16..20].try_into().unwrap()), 64);
        assert_eq!(u32::from_be_bytes(bytes[20..24].try_into().unwrap()), 40);
        assert_eq!(bytes, png(64, 40), "the same every time");
    }

    #[test]
    fn the_pdf_cross_references_point_at_its_objects() {
        let bytes = sample_pdf();
        assert!(bytes.starts_with(b"%PDF-1.7"));
        // Offsets are bytes (the header's second line is binary on purpose).
        let tail = String::from_utf8_lossy(&bytes[bytes.len() - 40..]).into_owned();
        let start: usize = tail
            .rsplit("startxref\n")
            .next()
            .and_then(|t| t.lines().next())
            .and_then(|n| n.trim().parse().ok())
            .unwrap();
        assert!(bytes[start..].starts_with(b"xref"));
        let table = String::from_utf8(bytes[start..].to_vec()).unwrap();
        // Every in-use entry points at `<n> 0 obj`.
        for (n, line) in table.lines().skip(3).enumerate() {
            if !line.ends_with(" n ") {
                break;
            }
            let at: usize = line[..10].parse().unwrap();
            assert!(bytes[at..].starts_with(format!("{} 0 obj", n + 1).as_bytes()));
        }
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("/Count 3"));
        assert_eq!(ucs2("潮"), "<6F6E>");
    }
}
