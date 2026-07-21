#![cfg(target_os = "android")]

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

const PLUGIN_IDENTIFIER: &str = "cc.drifting.imagecodec";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Plugin(#[from] tauri::plugin::mobile::PluginInvokeError),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareRequest {
    pub file_path: String,
    pub codec: String,
    pub display_max_long_edge: u32,
    pub display_quality: u8,
    pub thumbnail_max_long_edge: u32,
    pub thumbnail_quality: u8,
    pub max_dimension: u32,
    pub max_decoded_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareResponse {
    pub width: u32,
    pub height: u32,
    pub display_path: String,
    pub display_width: u32,
    pub display_height: u32,
    pub thumbnail_path: String,
    pub thumbnail_width: u32,
    pub thumbnail_height: u32,
}

pub struct ImageCodec<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> ImageCodec<R> {
    pub fn prepare(&self, request: PrepareRequest) -> Result<PrepareResponse> {
        self.0
            .run_mobile_plugin("prepareImage", request)
            .map_err(Into::into)
    }
}

pub trait ImageCodecExt<R: Runtime> {
    fn drifting_image_codec(&self) -> &ImageCodec<R>;
}

impl<R: Runtime, T: Manager<R>> ImageCodecExt<R> for T {
    fn drifting_image_codec(&self) -> &ImageCodec<R> {
        self.state::<ImageCodec<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("drifting-image-codec")
        .setup(|app, api| {
            let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "ImageCodecPlugin")?;
            app.manage(ImageCodec(handle));
            Ok(())
        })
        .build()
}
