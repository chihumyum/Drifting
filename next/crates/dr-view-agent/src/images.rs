//! The Agent panel's images (CM4a): what the author attaches to the next
//! message, and small pictures of them for the composer and the transcript.
//! The bytes, their limits and where they are kept are `dr_agent::images`.

use std::path::Path;
use std::sync::Arc;

use dr_agent::{ImageError, ImageRef, images};
use gpui::RenderImage;
use image::Frame;
use smallvec::SmallVec;

/// The longest side a picture is decoded to (twice the largest tile).
pub const THUMB_SIDE: u32 = 192;

/// An image waiting in the composer for the next message.
#[derive(Clone)]
pub struct Attached {
    pub image: ImageRef,
    pub bytes: Arc<[u8]>,
}

impl std::fmt::Debug for Attached {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Attached({} {}×{}, {} bytes)",
            self.image.mime, self.image.width, self.image.height, self.image.size
        )
    }
}

/// A picture of an image as GPUI draws it, or why there is none.
#[derive(Clone)]
pub enum Thumb {
    Loading,
    Ready(Arc<RenderImage>),
    /// Not on this device, or not readable.
    Missing,
}

/// What one dropped or pasted image became.
pub struct Checked {
    pub attached: Attached,
    pub thumb: Option<Arc<RenderImage>>,
}

/// Bytes the author attached: an image that can be sent, with its picture,
/// or why not. An image whose body does not decode is not one.
pub fn check(bytes: Vec<u8>) -> Result<Checked, ImageError> {
    let image = images::inspect(&bytes)?;
    let thumb = thumbnail(&bytes).ok_or(ImageError::Unsupported)?;
    Ok(Checked {
        attached: Attached {
            image,
            bytes: Arc::from(bytes),
        },
        thumb: Some(thumb),
    })
}

/// A file dropped or pasted: read when it is not larger than an image may
/// be; never read at all otherwise.
pub fn check_file(path: &Path) -> Result<Checked, ImageError> {
    let meta = std::fs::metadata(path).map_err(|_| ImageError::Unsupported)?;
    if !meta.is_file() {
        return Err(ImageError::Unsupported);
    }
    if meta.len() > images::MAX_IMAGE_BYTES {
        // Not an image that can be sent either way; say which.
        let head = read_head(path).ok_or(ImageError::Unsupported)?;
        return Err(match image::guess_format(&head) {
            Ok(image::ImageFormat::Png | image::ImageFormat::Jpeg | image::ImageFormat::WebP) => {
                ImageError::TooLarge
            }
            _ => ImageError::Unsupported,
        });
    }
    check(std::fs::read(path).map_err(|_| ImageError::Unsupported)?)
}

fn read_head(path: &Path) -> Option<Vec<u8>> {
    use std::io::Read as _;
    let mut head = vec![0; 64];
    let n = std::fs::File::open(path).ok()?.read(&mut head).ok()?;
    head.truncate(n);
    Some(head)
}

/// A small picture of image bytes, at most [`THUMB_SIDE`] a side.
pub fn thumbnail(bytes: &[u8]) -> Option<Arc<RenderImage>> {
    let decoded = image::load_from_memory(bytes).ok()?;
    let mut rgba = decoded.thumbnail(THUMB_SIDE, THUMB_SIDE).to_rgba8();
    // GPUI's RenderImage is BGRA.
    for px in rgba.pixels_mut() {
        px.0.swap(0, 2);
    }
    Some(Arc::new(RenderImage::new(SmallVec::from_elem(
        Frame::new(rgba),
        1,
    ))))
}
