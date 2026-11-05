/**
 * Where Windows gets the image codecs Drifting decodes through the Windows
 * Imaging Component (src-tauri/src/windows_image_codec.rs): HEIC and HEIF
 * need HEVC Video Extensions (HEIF Image Extensions is part of Windows),
 * AVIF needs AV1 Video Extension. Web pages of the Microsoft Store, which
 * hand over to the Store app.
 */
export const WINDOWS_IMAGE_CODEC_STORE_URL = {
  heic: 'https://apps.microsoft.com/detail/9NMZLZ57R3T7',
  heif: 'https://apps.microsoft.com/detail/9NMZLZ57R3T7',
  avif: 'https://apps.microsoft.com/detail/9MVZQVXJBQ9V',
} as const;
