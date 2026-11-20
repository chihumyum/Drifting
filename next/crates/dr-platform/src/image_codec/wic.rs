//! HEIC, HEIF and AVIF through the Windows Imaging Component, as 0.1's
//! `windows_image_codec.rs`, plus a scaler so a large photo is not held at
//! full size. WIC has these decoders only with the Microsoft Store's "HEIF
//! Image Extensions" and "HEVC Video Extensions" (HEIC) or "AV1 Video
//! Extension" (AVIF); without them creating the decoder or copying the
//! pixels fails, and every failure of the codec reads as
//! [`CodecError::Unavailable`]. Orientation is not applied (0.1 did not
//! either).
//!
//! Not run on this project's development Macs: it is compiled by the
//! Windows cross check and by the Windows CI.

use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_WICPixelFormat32bppRGBA, IWICBitmapFrameDecode, IWICBitmapSource,
    IWICImagingFactory, WICBitmapDitherTypeNone, WICBitmapInterpolationModeFant,
    WICBitmapPaletteTypeCustom, WICDecodeMetadataCacheOnDemand,
};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
};
use windows::core::Interface as _;

use super::{CodecError, Decoded, SystemFormat, bounded, check_size};

/// COM on this (worker) thread for one call. A thread already in another
/// apartment keeps it (`RPC_E_CHANGED_MODE`): WIC's in-process objects work
/// there too, and nothing is to be undone.
struct Com(bool);

impl Com {
    fn init() -> Self {
        // SAFETY: plain COM initialisation; S_FALSE also needs its
        // CoUninitialize, which `is_ok` covers.
        Self(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok())
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            // SAFETY: balances the successful CoInitializeEx above.
            unsafe { CoUninitialize() };
        }
    }
}

/// The first frame of `bytes`, with the factory that made it. `bytes` must
/// outlive both: the stream reads them in place.
fn first_frame(
    bytes: &[u8],
    format: SystemFormat,
) -> Result<(IWICImagingFactory, IWICBitmapFrameDecode, u32, u32), CodecError> {
    let unavailable = |_| CodecError::Unavailable(format);
    // SAFETY: WIC calls on interfaces created here; the stream's buffer is
    // `bytes`, which the caller keeps alive while they are used.
    unsafe {
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
                .map_err(unavailable)?;
        let stream = factory.CreateStream().map_err(unavailable)?;
        stream.InitializeFromMemory(bytes).map_err(unavailable)?;
        let decoder = factory
            .CreateDecoderFromStream(&stream, std::ptr::null(), WICDecodeMetadataCacheOnDemand)
            .map_err(unavailable)?;
        let frame = decoder.GetFrame(0).map_err(unavailable)?;
        let (mut width, mut height) = (0u32, 0u32);
        frame
            .GetSize(&mut width, &mut height)
            .map_err(|_| CodecError::Invalid("could not read the image's size".into()))?;
        check_size(width, height)?;
        Ok((factory, frame, width, height))
    }
}

pub(super) fn dimensions(bytes: &[u8], format: SystemFormat) -> Result<(u32, u32), CodecError> {
    let _com = Com::init();
    let (_, _, width, height) = first_frame(bytes, format)?;
    Ok((width, height))
}

pub(super) fn decode(
    bytes: &[u8],
    format: SystemFormat,
    max_side: u32,
) -> Result<Decoded, CodecError> {
    let _com = Com::init();
    let unavailable = |_| CodecError::Unavailable(format);
    let (factory, frame, width, height) = first_frame(bytes, format)?;
    let (w, h) = bounded(width, height, max_side);
    // SAFETY: as in `first_frame`; `pixels` holds `stride × h` bytes.
    unsafe {
        let source: IWICBitmapSource = if (w, h) == (width, height) {
            frame.cast().map_err(unavailable)?
        } else {
            let scaler = factory.CreateBitmapScaler().map_err(unavailable)?;
            scaler
                .Initialize(&frame, w, h, WICBitmapInterpolationModeFant)
                .map_err(unavailable)?;
            scaler.cast().map_err(unavailable)?
        };
        let converter = factory.CreateFormatConverter().map_err(unavailable)?;
        converter
            .Initialize(
                &source,
                &GUID_WICPixelFormat32bppRGBA,
                WICBitmapDitherTypeNone,
                None,
                0.0,
                WICBitmapPaletteTypeCustom,
            )
            .map_err(unavailable)?;
        let stride = w * 4;
        let mut pixels = vec![0u8; stride as usize * h as usize];
        // The codec decodes here: a missing HEVC or AV1 extension fails now.
        converter
            .CopyPixels(std::ptr::null(), stride, &mut pixels)
            .map_err(unavailable)?;
        Ok(Decoded {
            width: w,
            height: h,
            rgba: pixels,
        })
    }
}
