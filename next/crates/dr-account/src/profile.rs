//! Hosted account profile, avatar cropping/validation, and password rules.
//!
//! Matches `src/renderer/lib/hosted-account.ts` and `docs/hosted-sync/account-settings.md`:
//! - Display names are trimmed and bounded to 1..=80 UTF-16 code units.
//! - Avatars are square 256×256 JPEG data URLs (`data:image/jpeg;base64,/9j/...`)
//!   capped at 128 KiB, cropped from JPG/PNG/WebP files up to 5 MiB.
//! - Passwords require at least 8 bytes (and up to 128 characters).

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, ImageFormat, Rgba};
use serde::{Deserialize, Serialize};

pub const MAX_PROFILE_NAME_UTF16_UNITS: usize = 80;
pub const MAX_AVATAR_UPLOAD_BYTES: usize = 5 * 1024 * 1024;
pub const AVATAR_CANVAS_SIZE: u32 = 256;
pub const MAX_AVATAR_DATA_URL_BYTES: usize = 128 * 1024;
pub const MIN_PASSWORD_BYTES: usize = 8;
pub const MAX_PASSWORD_LENGTH: usize = 128;

const JPEG_DATA_URL_PREFIX: &str = "data:image/jpeg;base64,";

/// Stable validation / service error codes matching Hosted auth & account endpoints.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AccountErrorCode {
    HostedNotConfigured,
    Network,
    Unauthorized,
    InvalidCredentials,
    EmailNotVerified,
    EmailAlreadyExists,
    InvalidOtp,
    OtpExpired,
    InvalidName,
    InvalidAvatar,
    AvatarTooLarge,
    UnsupportedAvatarFormat,
    PasswordTooShort,
    InvalidCurrentPassword,
    OAuthStateMismatch,
    OAuthStateExpired,
    InvalidOAuthCallback,
    RateLimited,
    Unknown,
}

impl AccountErrorCode {
    #[must_use]
    pub fn from_api(status: Option<u16>, code: &str, message: &str) -> Self {
        let upper = code.trim().to_ascii_uppercase();
        let msg_upper = message.to_ascii_uppercase();
        match upper.as_str() {
            "EMAIL_NOT_VERIFIED" => Self::EmailNotVerified,
            "INVALID_EMAIL_OR_PASSWORD" | "INVALID_CREDENTIALS" => Self::InvalidCredentials,
            "USER_ALREADY_EXISTS" | "EMAIL_ALREADY_EXISTS" => Self::EmailAlreadyExists,
            "INVALID_OTP" | "OTP_MISMATCH" => Self::InvalidOtp,
            "OTP_EXPIRED" | "EXPIRED_OTP" => Self::OtpExpired,
            "INVALID_NAME" | "INVALID_PROFILE_NAME" => Self::InvalidName,
            "INVALID_AVATAR" => Self::InvalidAvatar,
            "AVATAR_FILE_SIZE" => Self::AvatarTooLarge,
            "AVATAR_FILE_TYPE" => Self::UnsupportedAvatarFormat,
            "PASSWORD_TOO_SHORT" | "INVALID_PASSWORD_LENGTH" => Self::PasswordTooShort,
            "INVALID_PASSWORD" | "CURRENT_PASSWORD_REQUIRED" => Self::InvalidCurrentPassword,
            "OAUTH_STATE_MISMATCH" | "INVALID_OAUTH_CODE" => Self::OAuthStateMismatch,
            "OAUTH_STATE_EXPIRED" => Self::OAuthStateExpired,
            "UNAUTHORIZED" | "SESSION_EXPIRED" => Self::Unauthorized,
            _ if status == Some(429) => Self::RateLimited,
            _ if status == Some(403) && msg_upper.contains("VERIF") => Self::EmailNotVerified,
            _ if matches!(status, Some(401 | 403)) => Self::Unauthorized,
            _ => Self::Unknown,
        }
    }
}

/// The authenticated Hosted user profile.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedUser {
    pub id: String,
    pub email: String,
    pub name: String,
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub email_verified: bool,
}

impl HostedUser {
    /// Returns the display name (trimmed `name`, or the part of `email` before `@`).
    #[must_use]
    pub fn display_name(&self) -> &str {
        let trimmed = self.name.trim();
        if !trimmed.is_empty() {
            return trimmed;
        }
        self.email
            .split('@')
            .next()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&self.email)
    }

    /// Sanitizes `name` and `image` according to the client contract.
    #[must_use]
    pub fn sanitized(mut self) -> Self {
        self.id = self.id.trim().to_owned();
        self.email = self.email.trim().to_owned();
        let trimmed_name = self.name.trim();
        if trimmed_name.is_empty()
            || trimmed_name.encode_utf16().count() > MAX_PROFILE_NAME_UTF16_UNITS
        {
            self.name = self
                .email
                .split('@')
                .next()
                .unwrap_or("Author")
                .trim()
                .to_owned();
        } else {
            self.name = trimmed_name.to_owned();
        }
        self.image = normalize_avatar(self.image.as_deref());
        self
    }
}

/// Normalizes an optional avatar string, keeping only valid JPEG data URLs <= 128 KiB.
#[must_use]
pub fn normalize_avatar(image: Option<&str>) -> Option<String> {
    image
        .map(str::trim)
        .filter(|s| !s.is_empty() && is_allowed_avatar_data_url(s))
        .map(ToOwned::to_owned)
}

/// Validates and trims a display name (`1..=80` UTF-16 code units).
pub fn validate_profile_name(name: &str) -> Result<String, AccountErrorCode> {
    let trimmed = name.trim();
    let utf16_len = trimmed.encode_utf16().count();
    if trimmed.is_empty() || utf16_len > MAX_PROFILE_NAME_UTF16_UNITS {
        return Err(AccountErrorCode::InvalidName);
    }
    Ok(trimmed.to_owned())
}

/// Checks whether `value` is a valid `data:image/jpeg;base64,/9j/...` data URL
/// within `MAX_AVATAR_DATA_URL_BYTES`.
#[must_use]
pub fn is_allowed_avatar_data_url(value: &str) -> bool {
    if value.len() > MAX_AVATAR_DATA_URL_BYTES {
        return false;
    }
    let Some(payload) = value.strip_prefix(JPEG_DATA_URL_PREFIX) else {
        return false;
    };
    if payload.is_empty() || !payload.starts_with("/9j/") {
        return false;
    }
    if !payload
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
    {
        return false;
    }
    let Ok(bytes) = BASE64.decode(payload) else {
        return false;
    };
    bytes.len() >= 4 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff
}

/// Decodes a validated avatar JPEG data URL into `(width, height, rgba_bytes)`.
pub fn decode_avatar_rgba(data_url: &str) -> Result<(u32, u32, Vec<u8>), AccountErrorCode> {
    if !is_allowed_avatar_data_url(data_url) {
        return Err(AccountErrorCode::InvalidAvatar);
    }
    let payload = data_url
        .strip_prefix(JPEG_DATA_URL_PREFIX)
        .ok_or(AccountErrorCode::InvalidAvatar)?;
    let bytes = BASE64
        .decode(payload)
        .map_err(|_| AccountErrorCode::InvalidAvatar)?;
    let img = image::load_from_memory_with_format(&bytes, ImageFormat::Jpeg)
        .map_err(|_| AccountErrorCode::InvalidAvatar)?;
    let rgba = img.to_rgba8();
    Ok((rgba.width(), rgba.height(), rgba.into_raw()))
}

/// Validates an avatar source file (`<= 5 MiB`, JPEG / PNG / WebP) and decodes it.
pub fn decode_avatar_source(bytes: &[u8]) -> Result<DynamicImage, AccountErrorCode> {
    if bytes.is_empty() {
        return Err(AccountErrorCode::InvalidAvatar);
    }
    if bytes.len() > MAX_AVATAR_UPLOAD_BYTES {
        return Err(AccountErrorCode::AvatarTooLarge);
    }
    let format =
        image::guess_format(bytes).map_err(|_| AccountErrorCode::UnsupportedAvatarFormat)?;
    if !matches!(
        format,
        ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP
    ) {
        return Err(AccountErrorCode::UnsupportedAvatarFormat);
    }
    image::load_from_memory_with_format(bytes, format).map_err(|_| AccountErrorCode::InvalidAvatar)
}

/// Crops `source` into a 256×256 square with `zoom` (`1.0..=3.0`) and normalized
/// offsets `offset_x`, `offset_y` (`-1.0..=1.0`), composites over `#141210`, and
/// encodes as a `data:image/jpeg;base64,...` data URL within 128 KiB.
pub fn crop_and_encode_avatar_with_transform(
    source: &DynamicImage,
    zoom: f32,
    offset_x: f32,
    offset_y: f32,
) -> Result<String, AccountErrorCode> {
    let (w, h) = source.dimensions();
    if w == 0 || h == 0 {
        return Err(AccountErrorCode::InvalidAvatar);
    }
    let zoom = zoom.clamp(1.0, 3.0);
    let offset_x = offset_x.clamp(-1.0, 1.0);
    let offset_y = offset_y.clamp(-1.0, 1.0);

    let min_side = w.min(h) as f32;
    let crop_side = (min_side / zoom).max(1.0).round() as u32;
    let crop_w = crop_side.min(w);
    let crop_h = crop_side.min(h);
    let max_dx = (w.saturating_sub(crop_w)) as f32 / 2.0;
    let max_dy = (h.saturating_sub(crop_h)) as f32 / 2.0;
    let center_x = (w as f32 / 2.0) - offset_x * max_dx;
    let center_y = (h as f32 / 2.0) - offset_y * max_dy;
    let x = (center_x - crop_w as f32 / 2.0)
        .round()
        .clamp(0.0, (w - crop_w) as f32) as u32;
    let y = (center_y - crop_h as f32 / 2.0)
        .round()
        .clamp(0.0, (h - crop_h) as f32) as u32;

    let cropped = source.crop_imm(x, y, crop_w, crop_h);
    let resized =
        cropped.resize_exact(AVATAR_CANVAS_SIZE, AVATAR_CANVAS_SIZE, FilterType::Lanczos3);
    let rgba = resized.to_rgba8();

    // Composite onto dark #141210 background so transparent PNG/WebP pixels
    // match `HostedAvatarCropDialog.tsx`.
    let mut rgb = image::RgbImage::new(AVATAR_CANVAS_SIZE, AVATAR_CANVAS_SIZE);
    for (px_x, px_y, pixel) in rgba.enumerate_pixels() {
        let Rgba([r, g, b, a]) = *pixel;
        let alpha = a as u16;
        let inv = 255 - alpha;
        let out_r = ((r as u16 * alpha + 20 * inv + 127) / 255) as u8;
        let out_g = ((g as u16 * alpha + 18 * inv + 127) / 255) as u8;
        let out_b = ((b as u16 * alpha + 16 * inv + 127) / 255) as u8;
        rgb.put_pixel(px_x, px_y, image::Rgb([out_r, out_g, out_b]));
    }

    for quality in [86u8, 74, 62] {
        let mut buf = Vec::new();
        let mut encoder = JpegEncoder::new_with_quality(&mut buf, quality);
        if encoder
            .encode(
                rgb.as_raw(),
                AVATAR_CANVAS_SIZE,
                AVATAR_CANVAS_SIZE,
                image::ExtendedColorType::Rgb8,
            )
            .is_ok()
        {
            let data_url = format!("{JPEG_DATA_URL_PREFIX}{}", BASE64.encode(&buf));
            if is_allowed_avatar_data_url(&data_url) {
                return Ok(data_url);
            }
        }
    }
    Err(AccountErrorCode::InvalidAvatar)
}

/// Center-crops raw image bytes (`JPG`, `PNG`, `WebP`, `<= 5 MiB`) into a
/// 256×256 JPEG data URL.
pub fn crop_and_encode_avatar(bytes: &[u8]) -> Result<String, AccountErrorCode> {
    let source = decode_avatar_source(bytes)?;
    crop_and_encode_avatar_with_transform(&source, 1.0, 0.0, 0.0)
}

/// Validates a password change before submitting to `/api/auth/change-password`.
pub fn validate_password_change(
    current_password: &str,
    new_password: &str,
) -> Result<(), AccountErrorCode> {
    if current_password.is_empty() {
        return Err(AccountErrorCode::InvalidCurrentPassword);
    }
    let len = new_password.len();
    if !(MIN_PASSWORD_BYTES..=MAX_PASSWORD_LENGTH).contains(&len) {
        return Err(AccountErrorCode::PasswordTooShort);
    }
    Ok(())
}
