//! HEIC, HEIF and AVIF on Windows through the Windows Imaging Component, as
//! macOS uses ImageIO. WIC decodes them only when the system has the codec:
//! "HEIF Image Extensions" with "HEVC Video Extensions" for iPhone photos, and
//! "AV1 Video Extension" for AVIF, all from the Microsoft Store (Windows 11
//! often includes some). Without one the import reports the codec as
//! unavailable and names what to install.

use crate::image_pipeline::{
    self, ImageInspection, ImagePipelineError, PreparedImage, SystemImageCodec,
    IMAGE_CODEC_UNAVAILABLE_CODE, MAX_IMAGE_ALLOC, MAX_IMAGE_DIMENSION,
};
use image::{DynamicImage, RgbaImage};
use std::{fs, path::Path};
use windows::{
    core::HSTRING,
    Win32::{
        Foundation::GENERIC_READ,
        Graphics::Imaging::{
            CLSID_WICImagingFactory, GUID_WICPixelFormat32bppRGBA, IWICImagingFactory,
            WICBitmapDitherTypeNone, WICBitmapPaletteTypeCustom, WICDecodeMetadataCacheOnDemand,
        },
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_MULTITHREADED,
        },
    },
};

/// COM for this blocking worker thread, released with it.
struct Com(bool);

impl Com {
    fn init() -> Self {
        // S_FALSE (already initialized) also needs its CoUninitialize.
        Self(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok())
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

fn unavailable(codec: SystemImageCodec) -> ImagePipelineError {
    let extensions = match codec {
        SystemImageCodec::Avif => "AV1 Video Extension",
        SystemImageCodec::Heic | SystemImageCodec::Heif => {
            "HEIF Image Extensions and HEVC Video Extensions"
        }
    };
    ImagePipelineError {
        code: IMAGE_CODEC_UNAVAILABLE_CODE,
        codec: Some(codec),
        message: format!(
            "{} decoding needs the {extensions} from the Microsoft Store",
            codec.extension().to_ascii_uppercase()
        ),
    }
}

fn decode(path: &Path, codec: SystemImageCodec) -> Result<DynamicImage, ImagePipelineError> {
    let _com = Com::init();
    unsafe {
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
                .map_err(|_| unavailable(codec))?;
        let decoder = factory
            .CreateDecoderFromFilename(
                &HSTRING::from(path),
                None,
                GENERIC_READ,
                WICDecodeMetadataCacheOnDemand,
            )
            .map_err(|_| unavailable(codec))?;
        let frame = decoder.GetFrame(0).map_err(|_| unavailable(codec))?;
        let (mut width, mut height) = (0_u32, 0_u32);
        frame
            .GetSize(&mut width, &mut height)
            .map_err(|_| ImagePipelineError::invalid("could not read image dimensions"))?;
        if width == 0
            || height == 0
            || width > MAX_IMAGE_DIMENSION
            || height > MAX_IMAGE_DIMENSION
            || u64::from(width) * u64::from(height) * 4 > MAX_IMAGE_ALLOC
        {
            return Err(ImagePipelineError::invalid(
                "image dimensions exceed the import limit",
            ));
        }
        let converter = factory
            .CreateFormatConverter()
            .map_err(|_| unavailable(codec))?;
        converter
            .Initialize(
                &frame,
                &GUID_WICPixelFormat32bppRGBA,
                WICBitmapDitherTypeNone,
                None,
                0.0,
                WICBitmapPaletteTypeCustom,
            )
            .map_err(|_| unavailable(codec))?;
        let stride = width * 4;
        let mut pixels = vec![0_u8; stride as usize * height as usize];
        // The codec decodes here; a missing HEVC extension fails at this step.
        converter
            .CopyPixels(std::ptr::null(), stride, &mut pixels)
            .map_err(|_| unavailable(codec))?;
        RgbaImage::from_raw(width, height, pixels)
            .map(DynamicImage::ImageRgba8)
            .ok_or_else(|| ImagePipelineError::invalid("decoded image is incomplete"))
    }
}

pub(crate) fn prepare(
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
    let image = decode(path, codec)?;
    image_pipeline::prepare_decoded(
        ImageInspection {
            mime: codec.mime().into(),
            size_bytes: metadata.len(),
            width: image.width(),
            height: image.height(),
        },
        &image,
        display_max_long_edge,
        display_quality,
        thumbnail_max_long_edge,
        thumbnail_quality,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn an_undecodable_heic_reports_the_codec_without_crashing() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("broken.heic");
        let mut bytes = vec![0, 0, 0, 24];
        bytes.extend_from_slice(b"ftypheic\0\0\0\0mif1heic");
        bytes.extend_from_slice(&[0_u8; 64]);
        fs::write(&path, bytes).unwrap();
        let error = prepare(&path, SystemImageCodec::Heic, 64 << 20, 80, 82, 32, 72).unwrap_err();
        assert_eq!(error.codec, Some(SystemImageCodec::Heic));
        assert!(
            error.message.contains("Microsoft Store"),
            "{}",
            error.message
        );
    }
}
