//! HEIC and AVIF through the system's codec (`image_codec`), on the test
//! kit's synthetic pictures: 600 × 400, four solid quadrants (red and green
//! above, blue and white below; `dr_testkit::media::QUADRANTS`), encoded on
//! macOS with `sips` (`dr-testkit/fixtures/README.md`). The files are read
//! by path so this crate does not build the test kit.

use dr_platform::image_codec::{self, CodecError, Decoded, SystemFormat};

const HEIC: &[u8] = include_bytes!("../../dr-testkit/fixtures/media/quadrants.heic");
const AVIF: &[u8] = include_bytes!("../../dr-testkit/fixtures/media/quadrants.avif");

/// The quadrants' colours: top left, top right, bottom left, bottom right.
const QUADRANTS: [[u8; 3]; 4] = [[200, 40, 40], [40, 160, 60], [40, 70, 190], [240, 240, 240]];

fn at(d: &Decoded, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * d.width + x) * 4) as usize;
    [d.rgba[i], d.rgba[i + 1], d.rgba[i + 2], d.rgba[i + 3]]
}

/// Each quadrant's middle is its colour, within what lossy coding and a
/// colour conversion move it, and opaque.
fn assert_quadrants(d: &Decoded) {
    let (w, h) = (d.width, d.height);
    let middles = [
        (w / 4, h / 4),
        (3 * w / 4, h / 4),
        (w / 4, 3 * h / 4),
        (3 * w / 4, 3 * h / 4),
    ];
    for ((x, y), want) in middles.into_iter().zip(QUADRANTS) {
        let got = at(d, x, y);
        assert_eq!(got[3], 255, "opaque at {x},{y}");
        for c in 0..3 {
            let diff = (i16::from(got[c]) - i16::from(want[c])).abs();
            assert!(diff <= 16, "at {x},{y}: {got:?}, want about {want:?}");
        }
    }
}

#[test]
fn the_fixtures_are_what_they_say() {
    assert_eq!(SystemFormat::sniff(HEIC), Some(SystemFormat::Heic));
    assert_eq!(SystemFormat::sniff(AVIF), Some(SystemFormat::Avif));
}

#[cfg(target_os = "macos")]
#[test]
fn heic_and_avif_decode_upright_at_full_size_and_bounded() {
    for (name, bytes) in [("heic", HEIC), ("avif", AVIF)] {
        assert_eq!(image_codec::dimensions(bytes), Ok((600, 400)), "{name}");
        let full = image_codec::decode(bytes, 4096).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!((full.width, full.height), (600, 400), "{name}");
        assert_eq!(full.rgba.len(), 600 * 400 * 4);
        assert_quadrants(&full);
        // Downsampled while decoding: the longest side as asked, the
        // proportions kept (ImageIO rounds 170.7 down), the quadrants where
        // they were.
        let small = image_codec::decode(bytes, 256).unwrap();
        assert_eq!(small.width, 256, "{name}");
        assert!((170..=171).contains(&small.height), "{name}: {small:?}");
        assert_eq!(small.rgba.len(), (small.width * small.height * 4) as usize);
        assert_quadrants(&small);
    }
}

#[cfg(target_os = "macos")]
#[test]
fn a_damaged_heic_is_refused_without_a_crash() {
    // The header of a HEIC and nothing a decoder can use.
    let mut broken = b"\0\0\0\x18ftypheic\0\0\0\0mif1heic".to_vec();
    broken.extend_from_slice(&[0u8; 64]);
    assert!(image_codec::decode(&broken, 256).is_err());
    assert!(image_codec::dimensions(&broken).is_err());
    // Cut short: the first 200 bytes of a real one.
    assert!(image_codec::decode(&HEIC[..200], 256).is_err());
    assert_eq!(
        image_codec::decode(b"not an image at all", 256),
        Err(CodecError::NotSystemFormat)
    );
}

#[cfg(not(any(target_os = "macos", windows)))]
#[test]
fn elsewhere_the_codec_is_unavailable() {
    assert_eq!(
        image_codec::decode(HEIC, 256),
        Err(CodecError::Unavailable(SystemFormat::Heic))
    );
}
