//! An author message with images, before each protocol writes it its own
//! way (CM4a). The images the request carries ([`DriverRequest::images`])
//! become image parts; any other, a line of text for the model after the
//! author's words, so it knows something was there.

use base64::Engine as _;
use dr_agent::{DriverRequest, ImageRef, images::payload_images};
use dr_model::conversation::ConversationEntry;

use crate::Result;

/// One image as a protocol embeds it.
pub(crate) struct WireImage {
    /// `image/png`, `image/jpeg` or `image/webp`.
    pub mime: String,
    /// Standard base64 of the bytes.
    pub data: String,
}

impl WireImage {
    /// `data:<mime>;base64,<data>`, as OpenAI's protocols take it.
    pub fn data_url(&self) -> String {
        format!("data:{};base64,{}", self.mime, self.data)
    }
}

/// The author's words (with a line for each image left out) and the images
/// that go along. A message without images is its text alone, as before.
pub(crate) struct UserContent {
    pub text: String,
    pub images: Vec<WireImage>,
}

/// `entry`'s text and images. `can_send` is false for a protocol that has
/// no image parts (DeepSeek's): every image is then a line of text.
pub(crate) fn user_content(
    entry: &ConversationEntry,
    request: &DriverRequest,
    can_send: bool,
) -> Result<UserContent> {
    let mut text = crate::deepseek::string(&entry.payload, "text")?.to_owned();
    let named = payload_images(&entry.payload);
    let sees = can_send && request.config.sees_images();
    let mut images = Vec::new();
    for (index, image) in named.iter().enumerate() {
        let bytes = image
            .as_ref()
            .filter(|_| sees)
            .and_then(|_| request.images.get(&entry.id, index));
        match (image, bytes) {
            (Some(image), Some(bytes)) => images.push(WireImage {
                mime: image.mime.clone(),
                data: base64::engine::general_purpose::STANDARD.encode(bytes),
            }),
            (image, _) => {
                if !text.is_empty() {
                    text.push_str("\n\n");
                }
                text.push_str(&left_out(image.as_ref(), sees));
            }
        }
    }
    Ok(UserContent { text, images })
}

/// The line the model reads for an image the request does not carry.
fn left_out(image: Option<&ImageRef>, sees: bool) -> String {
    let what = image.map_or_else(
        || "an image".to_owned(),
        |image| {
            format!(
                "an image ({}, {}×{} px)",
                image.format_name(),
                image.width,
                image.height
            )
        },
    );
    if sees {
        format!("[The author attached {what} here. It is not included in this request.]")
    } else {
        format!(
            "[The author attached {what} here. The current model cannot view images, so it was not sent.]"
        )
    }
}
