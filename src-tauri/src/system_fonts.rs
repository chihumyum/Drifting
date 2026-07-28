use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFontFamily {
    family: String,
    aliases: Vec<String>,
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn discover_system_font_families() -> Vec<SystemFontFamily> {
    use std::collections::{BTreeMap, HashMap};

    #[derive(Default)]
    struct FamilyNames {
        canonical: String,
        aliases_by_key: BTreeMap<String, String>,
    }

    let mut database = fontdb::Database::new();
    database.load_system_fonts();

    let mut grouped: HashMap<String, FamilyNames> = HashMap::new();
    for face in database.faces() {
        let Some((canonical, _)) = face.families.first() else {
            continue;
        };
        let canonical = canonical.trim();
        if canonical.is_empty() || canonical.starts_with('.') {
            continue;
        }

        let canonical_key = canonical.to_lowercase();
        let entry = grouped
            .entry(canonical_key.clone())
            .or_insert_with(|| FamilyNames {
                canonical: canonical.to_owned(),
                aliases_by_key: BTreeMap::new(),
            });

        for (name, _) in &face.families {
            let name = name.trim();
            if name.is_empty() || name.starts_with('.') {
                continue;
            }
            let key = name.to_lowercase();
            if key != canonical_key {
                entry
                    .aliases_by_key
                    .entry(key)
                    .or_insert_with(|| name.to_owned());
            }
        }
    }

    let mut families = grouped
        .into_values()
        .map(|names| SystemFontFamily {
            family: names.canonical,
            aliases: names.aliases_by_key.into_values().collect(),
        })
        .collect::<Vec<_>>();
    families.sort_by_cached_key(|font| font.family.to_lowercase());
    families
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn cached_system_font_families() -> &'static Vec<SystemFontFamily> {
    use std::sync::OnceLock;

    static FAMILIES: OnceLock<Vec<SystemFontFamily>> = OnceLock::new();
    FAMILIES.get_or_init(discover_system_font_families)
}

#[tauri::command]
pub async fn typography_list_system_fonts() -> Result<Vec<SystemFontFamily>, String> {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        return tauri::async_runtime::spawn_blocking(|| cached_system_font_families().clone())
            .await
            .map_err(|error| format!("failed to enumerate system fonts: {error}"));
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    Err("system font enumeration is currently available on desktop only".to_owned())
}

#[cfg(all(
    test,
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
mod tests {
    use super::discover_system_font_families;

    #[test]
    fn system_font_families_are_sorted_unique_and_public() {
        let families = discover_system_font_families();

        for pair in families.windows(2) {
            assert!(pair[0].family.to_lowercase() < pair[1].family.to_lowercase());
        }
        assert!(families
            .iter()
            .all(|font| !font.family.is_empty() && !font.family.starts_with('.')));
    }
}
