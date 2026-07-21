//! Android system codec adapter for HEIC/HEIF/AVIF.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri_plugin_drifting_image_codec::{ImageCodecExt, PrepareRequest, PrepareResponse};

use crate::image_pipeline::{
    validate_derivative_sizes, ImageInspection, ImagePipelineError, ImageVariant, PreparedImage,
    SystemImageCodec, MAX_DISPLAY_BYTES, MAX_IMAGE_ALLOC, MAX_IMAGE_DIMENSION, MAX_THUMBNAIL_BYTES,
};

struct NativeOutputCleanup {
    display: PathBuf,
    thumbnail: PathBuf,
}

impl Drop for NativeOutputCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.display);
        let _ = fs::remove_file(&self.thumbnail);
    }
}

fn read_native_output(path: &Path, max_bytes: u64) -> Result<Vec<u8>, ImagePipelineError> {
    let metadata = fs::metadata(path)
        .map_err(|_| ImagePipelineError::invalid("native image output is missing"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > max_bytes {
        return Err(ImagePipelineError::invalid(
            "native image output exceeds its size limit",
        ));
    }
    let bytes = fs::read(path)
        .map_err(|_| ImagePipelineError::invalid("could not read native image output"))?;
    if bytes.len() as u64 != metadata.len() || !bytes.starts_with(b"\xff\xd8\xff") {
        return Err(ImagePipelineError::invalid(
            "native image output is not a valid JPEG",
        ));
    }
    Ok(bytes)
}

fn validate_response(
    response: &PrepareResponse,
    display_max_long_edge: u32,
    thumbnail_max_long_edge: u32,
) -> Result<(), ImagePipelineError> {
    if response.width == 0
        || response.height == 0
        || response.width > MAX_IMAGE_DIMENSION
        || response.height > MAX_IMAGE_DIMENSION
        || u64::from(response.width)
            .saturating_mul(u64::from(response.height))
            .saturating_mul(4)
            > MAX_IMAGE_ALLOC
    {
        return Err(ImagePipelineError::invalid(
            "native image dimensions exceed the supported limit",
        ));
    }
    for (width, height, limit) in [
        (
            response.display_width,
            response.display_height,
            display_max_long_edge,
        ),
        (
            response.thumbnail_width,
            response.thumbnail_height,
            thumbnail_max_long_edge,
        ),
    ] {
        if width == 0 || height == 0 || width.max(height) > limit {
            return Err(ImagePipelineError::invalid(
                "native image derivative dimensions exceed the requested limit",
            ));
        }
    }
    Ok(())
}

pub(crate) fn prepare(
    app: &AppHandle,
    path: &Path,
    codec: SystemImageCodec,
    material_file_limit: u64,
    display_max_long_edge: u32,
    display_quality: u8,
    thumbnail_max_long_edge: u32,
    thumbnail_quality: u8,
) -> Result<PreparedImage, ImagePipelineError> {
    let metadata = fs::metadata(path)
        .map_err(|_| ImagePipelineError::invalid("could not inspect image file"))?;
    if !metadata.is_file() {
        return Err(ImagePipelineError::invalid("path is not a file"));
    }
    if metadata.len() > material_file_limit {
        return Err(ImagePipelineError::invalid(
            "image file is too large (>64 MiB)",
        ));
    }

    let response = app
        .drifting_image_codec()
        .prepare(PrepareRequest {
            file_path: path.to_string_lossy().into_owned(),
            codec: codec.extension().into(),
            display_max_long_edge,
            display_quality,
            thumbnail_max_long_edge,
            thumbnail_quality,
            max_dimension: MAX_IMAGE_DIMENSION,
            max_decoded_bytes: MAX_IMAGE_ALLOC,
        })
        .map_err(|error| {
            let message = error.to_string();
            if message.contains("IMAGE_CODEC_UNAVAILABLE") {
                ImagePipelineError::codec_unavailable(codec)
            } else {
                ImagePipelineError::invalid(message)
            }
        })?;

    let cleanup = NativeOutputCleanup {
        display: PathBuf::from(&response.display_path),
        thumbnail: PathBuf::from(&response.thumbnail_path),
    };
    validate_response(&response, display_max_long_edge, thumbnail_max_long_edge)?;
    let display_bytes = read_native_output(&cleanup.display, MAX_DISPLAY_BYTES)?;
    let thumbnail_bytes = read_native_output(&cleanup.thumbnail, MAX_THUMBNAIL_BYTES)?;

    let prepared = PreparedImage {
        source: ImageInspection {
            mime: codec.mime().into(),
            size_bytes: metadata.len(),
            width: response.width,
            height: response.height,
        },
        display: ImageVariant {
            bytes: display_bytes,
            mime: "image/jpeg".into(),
            width: response.display_width,
            height: response.display_height,
        },
        thumbnail: ImageVariant {
            bytes: thumbnail_bytes,
            mime: "image/jpeg".into(),
            width: response.thumbnail_width,
            height: response.thumbnail_height,
        },
    };
    validate_derivative_sizes(&prepared.display, &prepared.thumbnail)?;
    Ok(prepared)
}
