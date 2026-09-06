// Frozen released object-v2 readers. Keep independent from namespace-aware readers.
// Extracted from the pre-Agent-chat client for old/new compatibility acceptance.
use super::*;
const PROTOCOL_VALUE: &str = "object-v2";

fn parse_drive_file(
    file: DriveFile,
    sync_generation_id: &str,
) -> Result<Option<RemoteObject>, NativeError> {
    let Some(properties) = file.app_properties else {
        return Ok(None);
    };
    let Some(protocol) = properties.get(PROP_PROTOCOL) else {
        return Ok(None);
    };
    let remote_generation = properties.get(PROP_SYNC_GENERATION).ok_or_else(|| {
        NativeError::corrupt("Drive sync object omitted its Sync Generation identity")
    })?;
    if remote_generation != sync_generation_id {
        return Ok(None);
    }
    if protocol != PROTOCOL_VALUE {
        return Err(NativeError::corrupt(
            "Drive sync object protocol version is unsupported",
        ));
    }
    if file.trashed.unwrap_or(false) {
        return Ok(None);
    }
    let object_id = file
        .id
        .filter(|value| !value.is_empty() && value.len() <= 255)
        .ok_or_else(|| NativeError::corrupt("Drive sync object ID is malformed"))?;
    let logical_key_id = properties
        .get(PROP_LOGICAL)
        .cloned()
        .ok_or_else(|| NativeError::corrupt("Drive sync object omitted its logical key ID"))?;
    validate_logical_key_id(&logical_key_id)
        .map_err(|_| NativeError::corrupt("Drive sync object logical key ID is malformed"))?;
    let stored_sha256 = properties
        .get(PROP_HASH)
        .cloned()
        .ok_or_else(|| NativeError::corrupt("Drive sync object omitted its stored hash"))?;
    validate_hash(&stored_sha256)
        .map_err(|_| NativeError::corrupt("Drive sync object stored hash is malformed"))?;
    let size_bytes = file
        .size
        .as_deref()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| NativeError::corrupt("Drive sync object size is malformed"))?;
    let declared_size = properties
        .get(PROP_SIZE)
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| NativeError::corrupt("Drive sync object declared size is malformed"))?;
    if size_bytes == 0 || size_bytes != declared_size || size_bytes > MAX_REMOTE_OBJECT_BYTES {
        return Err(NativeError::corrupt(
            "Drive sync object size does not match its immutable metadata",
        ));
    }
    let object_kind = properties
        .get(PROP_KIND)
        .ok_or_else(|| NativeError::corrupt("Drive sync object omitted its kind"))
        .and_then(|value| object_kind(value))?;
    Ok(Some(RemoteObject {
        object_id,
        object_kind,
        logical_key_id,
        stored_sha256,
        size_bytes,
    }))
}

fn parse_drive_change(
    change: DriveChange,
    sync_generation_id: &str,
) -> Result<RemoteChange, NativeError> {
    let object_id = change
        .file_id
        .ok_or_else(|| NativeError::corrupt("Drive change omitted its file ID"))?;
    validate_plain_token(&object_id, "Drive file ID", 255)
        .map_err(|_| NativeError::corrupt("Drive change file ID is malformed"))?;

    if change.removed.unwrap_or(false) {
        return Ok(RemoteChange::Removed {
            object_id,
            logical_key_id: None,
        });
    }

    // Drive can report a metadata edit or trash operation with removed=false.
    // Any record that no longer parses as this Sync Generation's immutable object must
    // still reach the reducer as degradation of the known file ID. Unknown IDs
    // are ignored by the renderer, while a known immutable ID becomes corrupt.
    let parsed = change
        .file
        .and_then(|file| parse_drive_file(file, sync_generation_id).ok().flatten());
    match parsed {
        Some(object) if object.object_id == object_id => Ok(RemoteChange::Present { object }),
        _ => Ok(RemoteChange::Removed {
            object_id,
            logical_key_id: None,
        }),
    }
}

fn parse_drive_changes(
    changes: Vec<DriveChange>,
    sync_generation_id: &str,
) -> Result<Vec<RemoteChange>, NativeError> {
    changes
        .into_iter()
        .map(|change| parse_drive_change(change, sync_generation_id))
        .collect()
}

fn parse_drive_project_snapshot(
    file: DriveFile,
) -> Result<Option<ProjectSnapshotCandidate>, NativeError> {
    let Some(properties) = file.app_properties.as_ref() else {
        return Ok(None);
    };
    if properties.get(PROP_KIND).map(String::as_str) != Some("snapshot-commit") {
        return Ok(None);
    }
    let sync_generation_id = properties
        .get(PROP_SYNC_GENERATION)
        .cloned()
        .ok_or_else(|| {
            NativeError::corrupt("Drive snapshot omitted its Sync Generation identity")
        })?;
    validate_plain_token(&sync_generation_id, "Sync Generation ID", 255).map_err(|_| {
        NativeError::corrupt("Drive snapshot Sync Generation identity is malformed")
    })?;
    let object = parse_drive_file(file, &sync_generation_id)?
        .ok_or_else(|| NativeError::corrupt("Drive snapshot metadata is incomplete"))?;
    if object.object_kind != SyncObjectKind::SnapshotCommit {
        return Err(NativeError::corrupt(
            "Drive snapshot kind changed during parsing",
        ));
    }
    Ok(Some(ProjectSnapshotCandidate {
        sync_generation_id,
        object,
    }))
}

