//! Hosted Sync v2 engine operating on `dr_store::Library`.
//!
//! Treats every book and workspace scope as a set of opaque Loro documents
//! (`doc_id`, `kind`, `book_id`) plus immutable asset files (`AssetRecord`).
//! Document kinds are never hardcoded: book catalog documents, chapters,
//! v3 item trees and Agent conversation documents (`conv:*`) all flow through
//! the same `export_for_upload` / `Origin::Sync` pipeline.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use dr_store::asset::{MAX_COPY_BYTES, SourceImport, Variant, VariantBytes};
use dr_store::{DocInfo, Library, OpenDoc, Origin};
use loro::{ExportMode, VersionVector};
use serde::{Deserialize, Serialize};

use crate::health::{
    PaperSyncMarkPresentation, SyncCornerState, SyncHealthSnapshot, SyncHealthTracker, SyncProblem,
    sync_corner_for, sync_library_corner_for, sync_problems_of,
};
use crate::protocol::{
    HostedUsage, RemoteObjectPayload, RemoteObjectRecord, SyncError, SyncHttpClient,
    check_asset_quota, sha256_digest, write_verified_file_atomic,
};

const CURSOR_FILE_NAME: &str = "sync-cursor-v2.json";
const DEFAULT_PAGE_LIMIT: usize = 100;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct PersistedSyncState {
    cursor: u64,
    #[serde(default)]
    registered_docs: BTreeSet<String>,
    #[serde(default)]
    uploaded_purges: BTreeSet<String>,
}

/// Summary of work performed during a single sync cycle.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncCycleReport {
    pub uploaded_docs: usize,
    pub uploaded_assets: usize,
    pub uploaded_purges: usize,
    pub downloaded_docs: usize,
    pub downloaded_assets: usize,
    pub applied_purges: usize,
    pub cursor: u64,
}

/// Hosted Sync v2 engine coordinating incremental upload, download, restore,
/// quota enforcement and sync health tracking for a [`Library`].
pub struct SyncEngine {
    client: SyncHttpClient,
    health: SyncHealthTracker,
    state_path: Option<PathBuf>,
    state: PersistedSyncState,
    cancel: Arc<AtomicBool>,
}

impl SyncEngine {
    /// Create a sync engine talking to `base_url` for `library`.
    pub fn new(base_url: impl Into<String>, library: &Library) -> Result<Self, SyncError> {
        let client = SyncHttpClient::new(base_url)?;
        let state_path = Some(library.paths().root.join(CURSOR_FILE_NAME));
        let state = state_path
            .as_ref()
            .and_then(|p| fs::read(p).ok())
            .and_then(|raw| serde_json::from_slice::<PersistedSyncState>(&raw).ok())
            .unwrap_or_default();
        Ok(Self {
            client,
            health: SyncHealthTracker::new(true),
            state_path,
            state,
            cancel: Arc::new(AtomicBool::new(false)),
        })
    }

    pub fn client(&self) -> &SyncHttpClient {
        &self.client
    }

    pub fn cancel_handle(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancel)
    }

    pub fn health(&self) -> &SyncHealthTracker {
        &self.health
    }

    pub fn health_mut(&mut self) -> &mut SyncHealthTracker {
        &mut self.health
    }

    pub fn health_snapshot(&self) -> &SyncHealthSnapshot {
        self.health.snapshot()
    }

    pub fn corner_state(&self, book_id: Option<&str>, now_ms: u64) -> Option<SyncCornerState> {
        sync_corner_for(self.health.snapshot(), book_id, now_ms)
    }

    pub fn library_corner_state(&self, now_ms: u64) -> Option<SyncCornerState> {
        sync_library_corner_for(self.health.snapshot(), now_ms)
    }

    pub fn active_problems(&self, now_ms: u64) -> Vec<SyncProblem> {
        sync_problems_of(self.health.snapshot(), now_ms)
    }

    pub fn paper_presentation(
        &self,
        book_id: Option<&str>,
        is_trailing_pane: bool,
        now_ms: u64,
    ) -> PaperSyncMarkPresentation {
        self.health
            .presentation_for(book_id, is_trailing_pane, now_ms)
    }

    pub fn cursor(&self) -> u64 {
        self.state.cursor
    }

    fn save_state(&self) {
        let Some(path) = &self.state_path else {
            return;
        };
        if let Ok(bytes) = serde_json::to_vec_pretty(&self.state) {
            let _ = fs::write(path, bytes);
        }
    }

    /// Check whether importing a new local asset of `incoming_asset_bytes` is
    /// allowed under the account's Hosted Sync quota (500 MiB soft limit).
    pub fn check_new_asset_quota(
        &mut self,
        library: &Library,
        access_token: &str,
        incoming_asset_bytes: u64,
    ) -> Result<HostedUsage, SyncError> {
        let usage = self.client.fetch_usage(access_token)?;
        let pending_bytes: u64 = library
            .assets_pending_upload()?
            .iter()
            .map(|a| a.size)
            .sum();
        if let Err(err) = check_asset_quota(&usage, pending_bytes, incoming_asset_bytes) {
            self.health.finish_cycle_err(None, &err, current_time_ms());
            return Err(err);
        }
        Ok(usage)
    }

    /// Run one full incremental sync cycle (upload local Loro updates, assets
    /// and purges, then pull and merge remote object-log changes).
    pub fn sync_once(
        &mut self,
        library: &Library,
        access_token: &str,
    ) -> Result<SyncCycleReport, SyncError> {
        self.sync_once_at(library, access_token, current_time_ms())
    }

    /// Run one incremental sync cycle with an explicit millisecond timestamp
    /// (for deterministic health-tracker tests).
    pub fn sync_once_at(
        &mut self,
        library: &Library,
        access_token: &str,
        now_ms: u64,
    ) -> Result<SyncCycleReport, SyncError> {
        self.health.begin_cycle(None, now_ms);
        let result = (|| -> Result<SyncCycleReport, SyncError> {
            let mut report = SyncCycleReport::default();
            self.push_local_changes(library, access_token, &mut report)?;
            self.pull_remote_changes(library, access_token, &mut report)?;
            report.cursor = self.state.cursor;
            Ok(report)
        })();

        match &result {
            Ok(_) => self.health.finish_cycle_ok(None, now_ms),
            Err(err) => self.health.finish_cycle_err(None, err, now_ms),
        }
        result
    }

    /// Restore all remote books, documents (including Agent conversations) and
    /// assets from the server into an empty or newly recreated local [`Library`].
    pub fn restore_library(
        &mut self,
        library: &Library,
        access_token: &str,
    ) -> Result<SyncCycleReport, SyncError> {
        self.state.cursor = 0;
        self.state.registered_docs.clear();
        self.save_state();
        self.sync_once(library, access_token)
    }

    fn push_local_changes(
        &mut self,
        library: &Library,
        access_token: &str,
        report: &mut SyncCycleReport,
    ) -> Result<(), SyncError> {
        let all_docs = library.docs(None, None)?;
        let doc_map: BTreeMap<String, DocInfo> = all_docs
            .iter()
            .cloned()
            .map(|d| (d.doc_id.clone(), d))
            .collect();

        // 1. Upload incremental Loro updates for all documents with local changes.
        let changed_ids = library.docs_with_local_changes()?;
        for doc_id in changed_ids {
            let Some(info) = doc_map.get(&doc_id) else {
                continue;
            };
            if let Some(batch) = library.export_for_upload(&doc_id)? {
                let vv_base64 = URL_SAFE_NO_PAD.encode(batch.vv.encode());
                let sha = sha256_digest(&batch.bytes);
                let doc_key = URL_SAFE_NO_PAD.encode(doc_id.as_bytes());
                let object_key = format!("loro/{doc_key}/{}", &sha[7..39]);
                let payload = RemoteObjectPayload::LoroUpdate {
                    doc_id: info.doc_id.clone(),
                    kind: info.kind.clone(),
                    book_id: info.book_id.clone(),
                    vv_base64,
                    is_snapshot: false,
                };
                self.client.put_object(
                    access_token,
                    &object_key,
                    &payload,
                    &batch.bytes,
                    Some(&self.cancel),
                )?;
                library.mark_uploaded(&batch.doc_id, &batch.vv)?;
                self.state.registered_docs.insert(doc_id);
                self.save_state();
                report.uploaded_docs += 1;
            }
        }

        // 2. Also ensure documents with an empty genesis (no operations yet)
        // are registered on the server at least once.
        for info in &all_docs {
            if self.state.registered_docs.contains(&info.doc_id) {
                continue;
            }
            let remote_vv = library.remote_vv(&info.doc_id)?;
            if !remote_vv.is_empty() {
                self.state.registered_docs.insert(info.doc_id.clone());
                continue;
            }
            let doc = library.load_copy(&info.doc_id)?;
            let vv = doc.oplog_vv();
            let bytes = doc.export(ExportMode::all_updates())?;
            let vv_base64 = URL_SAFE_NO_PAD.encode(vv.encode());
            let sha = sha256_digest(&bytes);
            let doc_key = URL_SAFE_NO_PAD.encode(info.doc_id.as_bytes());
            let object_key = format!("loro/{doc_key}/genesis-{}", &sha[7..23]);
            let payload = RemoteObjectPayload::LoroUpdate {
                doc_id: info.doc_id.clone(),
                kind: info.kind.clone(),
                book_id: info.book_id.clone(),
                vv_base64,
                is_snapshot: false,
            };
            self.client.put_object(
                access_token,
                &object_key,
                &payload,
                &bytes,
                Some(&self.cancel),
            )?;
            library.mark_uploaded(&info.doc_id, &vv)?;
            self.state.registered_docs.insert(info.doc_id.clone());
            self.save_state();
            report.uploaded_docs += 1;
        }

        // 3. Upload pending asset variants (Source before Display/Thumbnail).
        let mut pending_assets = library.assets_pending_upload()?;
        if !pending_assets.is_empty() {
            pending_assets.sort_by_key(|a| match a.variant {
                Variant::Source => 0u8,
                Variant::Display => 1u8,
                Variant::Thumbnail => 2u8,
            });
            let usage = self.client.fetch_usage(access_token)?;
            let mut uploaded_bytes_this_cycle = 0u64;
            for asset in pending_assets {
                check_asset_quota(&usage, uploaded_bytes_this_cycle, asset.size)?;
                let bytes = fs::read(&asset.path)?;
                let object_key = format!(
                    "asset/{}/{}/{}",
                    asset.book_id,
                    asset.asset_id,
                    asset.variant.as_str()
                );
                let payload = RemoteObjectPayload::AssetBlob {
                    asset_id: asset.asset_id.clone(),
                    book_id: asset.book_id.clone(),
                    variant: asset.variant.as_str().to_string(),
                    mime: asset.mime.clone(),
                    ext: asset.ext.clone(),
                    width: asset.width,
                    height: asset.height,
                };
                self.client.put_object(
                    access_token,
                    &object_key,
                    &payload,
                    &bytes,
                    Some(&self.cancel),
                )?;
                library.mark_asset_uploaded(&asset.asset_id, asset.variant)?;
                uploaded_bytes_this_cycle = uploaded_bytes_this_cycle.saturating_add(asset.size);
                report.uploaded_assets += 1;
            }
        }

        // 4. Upload local document purge tombstones.
        for purged in library.purged_docs(None)? {
            let purge_key = format!("{}:{}", purged.doc_id, purged.purged_ms);
            if self.state.uploaded_purges.contains(&purge_key) {
                continue;
            }
            let doc_key = URL_SAFE_NO_PAD.encode(purged.doc_id.as_bytes());
            let object_key = format!("purge/{doc_key}/{}", purged.purged_ms);
            let payload = RemoteObjectPayload::DocPurge {
                doc_id: purged.doc_id.clone(),
                kind: purged.kind.clone(),
                book_id: purged.book_id.clone(),
                purged_ms: purged.purged_ms,
            };
            let body = serde_json::to_vec(&payload)?;
            self.client.put_object(
                access_token,
                &object_key,
                &payload,
                &body,
                Some(&self.cancel),
            )?;
            self.state.uploaded_purges.insert(purge_key);
            self.save_state();
            report.uploaded_purges += 1;
        }

        Ok(())
    }

    fn pull_remote_changes(
        &mut self,
        library: &Library,
        access_token: &str,
        report: &mut SyncCycleReport,
    ) -> Result<(), SyncError> {
        loop {
            let page =
                self.client
                    .list_changes(access_token, self.state.cursor, DEFAULT_PAGE_LIMIT)?;
            if page.changes.is_empty() {
                self.state.cursor = page.next_cursor.max(self.state.cursor);
                self.save_state();
                break;
            }

            for record in &page.changes {
                self.apply_remote_record(library, access_token, record, report)?;
                self.state.cursor = record.seq;
                self.save_state();
            }

            if !page.has_more {
                self.state.cursor = page.next_cursor.max(self.state.cursor);
                self.save_state();
                break;
            }
        }
        Ok(())
    }

    fn apply_remote_record(
        &mut self,
        library: &Library,
        access_token: &str,
        record: &RemoteObjectRecord,
        report: &mut SyncCycleReport,
    ) -> Result<(), SyncError> {
        match &record.payload {
            RemoteObjectPayload::LoroUpdate {
                doc_id,
                kind,
                book_id,
                vv_base64,
                ..
            } => {
                if library.purged(doc_id)?.is_some()
                    || book_id
                        .as_deref()
                        .map(|b| library.book_purged(b))
                        .transpose()?
                        == Some(true)
                {
                    return Ok(());
                }

                let vv_bytes = URL_SAFE_NO_PAD.decode(vv_base64).map_err(|e| {
                    SyncError::IntegrityMismatch {
                        expected: "valid base64url VersionVector".into(),
                        actual: e.to_string(),
                    }
                })?;
                let remote_vv = VersionVector::decode(&vv_bytes)?;

                if let Some(head) = library.head(doc_id)? {
                    let already_covered = !remote_vv.is_empty()
                        && remote_vv
                            .iter()
                            .all(|(peer, end)| head.vv.get(peer).copied().unwrap_or(0) >= *end);
                    if already_covered {
                        library.mark_uploaded(doc_id, &remote_vv)?;
                        self.state.registered_docs.insert(doc_id.clone());
                        return Ok(());
                    }
                }

                let bytes = self.client.get_object_bytes(
                    access_token,
                    &record.object_key,
                    &record.sha256,
                    record.byte_length,
                    Some(&self.cancel),
                )?;

                let handle = library.open_doc(
                    doc_id,
                    OpenDoc::CreateIfMissing {
                        kind,
                        book_id: book_id.as_deref(),
                        genesis: &|_| {},
                    },
                )?;
                if !bytes.is_empty() {
                    let _ = handle.import(bytes, Origin::Sync)?;
                }
                library.mark_uploaded(doc_id, &remote_vv)?;
                handle.close();
                let _ = library.reindex_doc(doc_id);
                self.state.registered_docs.insert(doc_id.clone());
                report.downloaded_docs += 1;
            }
            RemoteObjectPayload::AssetBlob {
                asset_id,
                book_id,
                variant,
                mime,
                ext,
                width,
                height,
            } => {
                let parsed_variant = parse_variant(variant)?;
                if library.asset(asset_id, parsed_variant)?.is_some() {
                    library.mark_asset_uploaded(asset_id, parsed_variant)?;
                    return Ok(());
                }

                let bytes = self.client.get_object_bytes(
                    access_token,
                    &record.object_key,
                    &record.sha256,
                    record.byte_length,
                    Some(&self.cancel),
                )?;

                let staging_dir = library.paths().assets.join(".sync-staging");
                let staging_path =
                    staging_dir.join(format!("{asset_id}-{}.{ext}", parsed_variant.as_str()));
                write_verified_file_atomic(
                    &staging_path,
                    &bytes,
                    &record.sha256,
                    Some(record.byte_length),
                    Some(&self.cancel),
                )?;

                let import_res = match parsed_variant {
                    Variant::Source => library
                        .import_asset(&SourceImport {
                            book_id,
                            asset_id,
                            source: &staging_path,
                            mime,
                            ext,
                            dimensions: (*width).zip(*height),
                            limit: MAX_COPY_BYTES,
                        })
                        .map(|_| ()),
                    Variant::Display | Variant::Thumbnail => library
                        .put_variant(
                            asset_id,
                            parsed_variant,
                            &VariantBytes {
                                bytes,
                                mime: mime.to_string(),
                                ext: ext.to_string(),
                                width: width.unwrap_or(0),
                                height: height.unwrap_or(0),
                            },
                        )
                        .map(|_| ()),
                };
                let _ = fs::remove_file(&staging_path);
                import_res?;
                library.mark_asset_uploaded(asset_id, parsed_variant)?;
                report.downloaded_assets += 1;
            }
            RemoteObjectPayload::DocPurge {
                doc_id,
                kind,
                book_id,
                purged_ms,
            } => {
                if library.purged(doc_id)?.is_none() {
                    if library.doc_info(doc_id)?.is_none() {
                        let _ = library.register(doc_id, kind, book_id.as_deref());
                    }
                    let _ = library.purge_doc(doc_id);
                    report.applied_purges += 1;
                }
                self.state
                    .uploaded_purges
                    .insert(format!("{doc_id}:{purged_ms}"));
            }
        }
        Ok(())
    }
}

fn parse_variant(raw: &str) -> Result<Variant, SyncError> {
    match raw {
        "source" => Ok(Variant::Source),
        "display" => Ok(Variant::Display),
        "thumbnail" => Ok(Variant::Thumbnail),
        other => Err(SyncError::InvalidPath(format!(
            "unknown asset variant: {other}"
        ))),
    }
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
