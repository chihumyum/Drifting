//! Project-relative paths for the v5 Markdown folder. The disk layout follows
//! residence; memberships and the book sequence only affect links and contents.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt::Write as _;

use dr_doc::v3::BookStructureV3;
use dr_model::DocId;
use dr_model::id::{AssetFolderId, AssetId, BodyDocId, EntryId};
use dr_model::kind::AssetKind;
use dr_model::shared::{Asset, AssetFolder};
use dr_model::v3::{Entry, ModuleSpec};

/// The interface language at the project's first projection. The service
/// keeps these names through later changes of language.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Names {
    pub contents: String,
    pub assets: String,
    pub untitled: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProseFile {
    pub id: BodyDocId,
    pub path: String,
    /// An empty level keeps its slot in the layout so that a file written
    /// there can be recognized as its prose.
    pub present: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AssetFile {
    pub id: AssetId,
    pub path: String,
    pub name: String,
    pub kind: AssetKind,
    /// Trashed files still have a link destination, but no disk copy.
    pub present: bool,
}

pub struct BookLayout {
    pub contents_path: String,
    pub contents: String,
    pub directories: BTreeSet<String>,
    pub prose: Vec<ProseFile>,
    pub assets: Vec<AssetFile>,
    pub memberships: BTreeMap<EntryId, Vec<String>>,
    pub entry_links: BTreeMap<EntryId, String>,
}

impl BookLayout {
    /// `filled` contains the active prose documents whose body is nonempty.
    /// Assets and asset folders include Recently Deleted records so the
    /// renderer can still name missing embed and link destinations.
    pub fn new(
        structure: &BookStructureV3,
        folders: &[AssetFolder],
        assets: &[Asset],
        filled: &BTreeSet<DocId>,
        names: &Names,
    ) -> Self {
        let contents_stem = stem(&names.contents, &names.untitled);
        let assets_dir = stem(&names.assets, &names.untitled);
        let contents_path = format!("{contents_stem}.md");
        let mut layout = Self {
            contents_path: contents_path.clone(),
            contents: String::new(),
            directories: BTreeSet::from([assets_dir.clone()]),
            prose: Vec::new(),
            assets: Vec::new(),
            memberships: BTreeMap::new(),
            entry_links: BTreeMap::new(),
        };
        let mut without_prose = Vec::new();
        let mut tree = EntryLayout {
            structure,
            filled,
            names,
            paths: Paths::new([
                contents_path,
                contents_stem,
                assets_dir.clone(),
                format!("{assets_dir}.md"),
                crate::disk::META_DIR.into(),
            ]),
            directories: &mut layout.directories,
            files: &mut layout.prose,
            without_prose: &mut without_prose,
        };
        tree.children(None, "");
        // Reserve existing prose paths first. A host without a prose module
        // has a link, but cannot displace any real file.
        let missing_paths: BTreeMap<_, _> = std::mem::take(tree.without_prose)
            .into_iter()
            .map(|(entry, dir, title)| {
                let path = tree.paths.claim(&dir, &title, ".md", entry.as_str());
                (entry, path)
            })
            .collect();
        let mut asset_layout = AssetLayout::new(folders, assets, &mut layout, names);
        asset_layout.children(None, &assets_dir, true);

        let by_id: BTreeMap<_, _> = layout.prose.iter().map(|f| (&f.id, f)).collect();
        let mut first_files = BTreeMap::new();
        let mut first_slots = BTreeMap::new();
        for entry in structure.entries().filter(|e| !e.is_trashed()) {
            for module in prose_modules(structure, entry) {
                let id = BodyDocId::new(entry.id.clone(), module.id.clone());
                if let Some(file) = by_id.get(&id) {
                    first_slots.entry(&entry.id).or_insert(*file);
                    if file.present {
                        first_files.entry(&entry.id).or_insert(*file);
                    }
                }
            }
        }
        let mut basename_count = HashMap::new();
        for f in &layout.prose {
            *basename_count
                .entry(name_key(basename(&f.path)))
                .or_insert(0_usize) += 1;
        }
        let mut host_links = BTreeMap::new();
        for entry in structure.entries().filter(|e| !e.is_trashed()) {
            let file = first_files
                .get(&entry.id)
                .or_else(|| first_slots.get(&entry.id));
            let link = if let Some(file) = file {
                let name = basename(&file.path);
                let target = if basename_count[&name_key(name)] > 1 {
                    &file.path
                } else {
                    name
                };
                target.strip_suffix(".md").unwrap_or(target).to_owned()
            } else {
                stem(&entry.title, &names.untitled)
            };
            if let Some(path) = file
                .map(|f| &f.path)
                .or_else(|| missing_paths.get(&entry.id))
            {
                let target = path.strip_suffix(".md").unwrap_or(path);
                host_links.insert(&entry.id, format!("[[{target}]]"));
            }
            layout
                .entry_links
                .insert(entry.id.clone(), format!("[[{link}]]"));
        }
        let mut hosts: BTreeMap<&EntryId, BTreeSet<EntryId>> = BTreeMap::new();
        for membership in structure.memberships() {
            hosts
                .entry(&membership.member)
                .or_default()
                .insert(membership.host.clone());
        }
        for (member, hosts) in hosts {
            let primary = structure
                .entry(member)
                .and_then(|e| e.effective_primary(&hosts));
            let links = primary
                .into_iter()
                .chain(hosts.iter().filter(|h| Some(*h) != primary))
                .filter_map(|h| host_links.get(h).cloned())
                .collect();
            layout.memberships.insert(member.clone(), links);
        }
        let mut contents = Contents {
            structure,
            names,
            first_files,
            by_id,
            text: String::new(),
        };
        if structure.project().book.is_some() {
            contents.book();
        } else {
            contents.residents(None, 0);
        }
        layout.contents = contents.text;
        layout.prose.sort_by(|a, b| a.id.cmp(&b.id));
        layout.assets.sort_by(|a, b| a.id.cmp(&b.id));
        layout
    }
}

fn prose_modules<'a>(structure: &'a BookStructureV3, entry: &Entry) -> Vec<&'a ModuleSpec> {
    entry
        .effective_template(structure.templates_map())
        .into_iter()
        .flat_map(|template| template.prose_modules())
        .collect()
}

struct EntryLayout<'a> {
    structure: &'a BookStructureV3,
    filled: &'a BTreeSet<DocId>,
    names: &'a Names,
    paths: Paths,
    directories: &'a mut BTreeSet<String>,
    files: &'a mut Vec<ProseFile>,
    without_prose: &'a mut Vec<(EntryId, String, String)>,
}

impl EntryLayout<'_> {
    fn children(&mut self, parent: Option<&EntryId>, dir: &str) {
        let structure = self.structure;
        let mut siblings = structure.children_of(parent);
        siblings.sort_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        for entry in siblings {
            let title = stem(&entry.title, &self.names.untitled);
            if entry.is_level() {
                let home = self.paths.claim(dir, &title, "", entry.id.as_str());
                self.directories.insert(home.clone());
                self.prose(entry, &home, basename(&home));
                self.children(Some(&entry.id), &home);
            } else {
                self.prose(entry, dir, &title);
            }
        }
    }

    fn prose(&mut self, entry: &Entry, dir: &str, title: &str) {
        let modules = prose_modules(self.structure, entry);
        if modules.is_empty() && entry.accepts_members(self.structure.templates_map()) {
            self.without_prose
                .push((entry.id.clone(), dir.to_owned(), title.to_owned()));
        }
        for module in &modules {
            let id = BodyDocId::new(entry.id.clone(), module.id.clone());
            let present = !entry.is_level() || self.filled.contains(&DocId::Body(id.clone()));
            let name = if modules.len() == 1 {
                title.to_owned()
            } else {
                let name = stem(&module.name, &self.names.untitled);
                format!("{title} · {}", limit_bytes(&name, 96))
            };
            let path = self.paths.claim(dir, &name, ".md", entry.id.as_str());
            self.files.push(ProseFile { id, path, present });
        }
    }
}

struct AssetLayout<'a> {
    folders: BTreeMap<Option<&'a AssetFolderId>, Vec<&'a AssetFolder>>,
    assets: BTreeMap<Option<&'a AssetFolderId>, Vec<&'a Asset>>,
    paths: Paths,
    directories: &'a mut BTreeSet<String>,
    files: &'a mut Vec<AssetFile>,
    names: &'a Names,
}

impl<'a> AssetLayout<'a> {
    fn new(
        folders: &'a [AssetFolder],
        assets: &'a [Asset],
        layout: &'a mut BookLayout,
        names: &'a Names,
    ) -> Self {
        let mut by_parent: BTreeMap<_, Vec<_>> = BTreeMap::new();
        let mut by_folder: BTreeMap<_, Vec<_>> = BTreeMap::new();
        let ids: BTreeSet<_> = folders.iter().map(|f| &f.id).collect();
        for folder in folders {
            let parent = folder.parent.as_ref().filter(|p| ids.contains(p));
            by_parent.entry(parent).or_default().push(folder);
        }
        for asset in assets {
            let folder = asset.folder.as_ref().filter(|p| ids.contains(p));
            by_folder.entry(folder).or_default().push(asset);
        }
        for siblings in by_parent.values_mut() {
            siblings.sort_by_key(|f| &f.id);
        }
        for siblings in by_folder.values_mut() {
            siblings.sort_by_key(|a| (a.created_at, &a.id));
        }
        Self {
            folders: by_parent,
            assets: by_folder,
            paths: Paths::default(),
            directories: &mut layout.directories,
            files: &mut layout.assets,
            names,
        }
    }

    fn children(&mut self, parent: Option<&'a AssetFolderId>, dir: &str, live: bool) {
        let folders = self.folders.remove(&parent).unwrap_or_default();
        let assets = self.assets.remove(&parent).unwrap_or_default();
        for present in [true, false] {
            for folder in folders
                .iter()
                .copied()
                .filter(|f| (live && !f.is_trashed()) == present)
            {
                let name = stem(&folder.name, &self.names.untitled);
                let path = self.paths.claim(dir, &name, "", folder.id.as_str());
                if present {
                    self.directories.insert(path.clone());
                }
                self.children(Some(&folder.id), &path, present);
            }
            for asset in assets
                .iter()
                .copied()
                .filter(|a| (live && !a.is_trashed()) == present)
            {
                let (name, ext) = asset
                    .name
                    .rsplit_once('.')
                    .filter(|(_, ext)| {
                        !ext.is_empty()
                            && ext.len() <= 12
                            && ext.bytes().all(|b| b.is_ascii_alphanumeric())
                    })
                    .map_or((asset.name.as_str(), String::new()), |(n, ext)| {
                        (n, format!(".{ext}"))
                    });
                let name = stem(name, &self.names.untitled);
                let path = self.paths.claim(dir, &name, &ext, asset.id.as_str());
                self.files.push(AssetFile {
                    id: asset.id.clone(),
                    path,
                    name: asset.name.clone(),
                    kind: asset.kind.clone(),
                    present,
                });
            }
        }
    }
}

struct Contents<'a> {
    structure: &'a BookStructureV3,
    names: &'a Names,
    first_files: BTreeMap<&'a EntryId, &'a ProseFile>,
    by_id: BTreeMap<&'a BodyDocId, &'a ProseFile>,
    text: String,
}

impl Contents<'_> {
    fn book(&mut self) {
        let mut ancestors = Vec::new();
        let structure = self.structure;
        for row in structure.book_sequence() {
            while ancestors.last().is_some_and(|&d| d >= row.depth) {
                ancestors.pop();
            }
            if row.prose.is_empty() {
                continue;
            }
            let file = row.prose.iter().find_map(|p| {
                let DocId::Body(id) = &p.doc else { return None };
                self.by_id.get(id).filter(|file| file.present).copied()
            });
            // Do not emit a Markdown code block when the actual parent has
            // no book prose. Indent relative to the ancestors being listed.
            self.row(row.entry, ancestors.len(), file);
            ancestors.push(row.depth);
        }
    }

    fn residents(&mut self, parent: Option<&EntryId>, depth: usize) {
        let structure = self.structure;
        for entry in structure.children_of(parent) {
            self.row(entry, depth, self.first_files.get(&entry.id).copied());
            if entry.is_level() {
                self.residents(Some(&entry.id), depth + 1);
            }
            for member in structure.members_of(&entry.id) {
                self.row(member, depth + 1, self.first_files.get(&member.id).copied());
            }
        }
    }

    fn row(&mut self, entry: &Entry, depth: usize, file: Option<&ProseFile>) {
        let title = if entry.title.trim().is_empty() {
            &self.names.untitled
        } else {
            &entry.title
        };
        let label = markdown_label(title);
        let indent = "  ".repeat(depth);
        if let Some(file) = file {
            let target = markdown_destination(&file.path);
            writeln!(self.text, "{indent}- [{label}]({target})").unwrap();
        } else {
            writeln!(self.text, "{indent}- {label}").unwrap();
        }
    }
}

/// Choose a name in the shared root. The caller excludes the project's own
/// existing name from `occupied` when planning a rename.
pub fn project_folder_name<'a>(
    title: &str,
    names: &Names,
    occupied: impl IntoIterator<Item = &'a str>,
) -> String {
    let occupied: HashSet<_> = occupied.into_iter().map(name_key).collect();
    let base = stem(title, &names.untitled);
    if !occupied.contains(&name_key(&base)) {
        return base;
    }
    (2..)
        .map(|n| format!("{base} {n}"))
        .find(|name| !occupied.contains(&name_key(name)))
        .expect("finite number of folders")
}

#[derive(Default)]
struct Paths {
    used: HashSet<String>,
}

impl Paths {
    fn new(reserved: impl IntoIterator<Item = String>) -> Self {
        Self {
            used: reserved.into_iter().map(|p| name_key(&p)).collect(),
        }
    }

    fn claim(&mut self, parent: &str, title: &str, ext: &str, id: &str) -> String {
        let candidate = join(parent, &format!("{title}{ext}"));
        if self.used.insert(name_key(&candidate)) {
            return candidate;
        }
        let hash = id.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
        });
        let code = &format!("{hash:016x}")[..8];
        for n in 1.. {
            let suffix = if n == 1 {
                code.to_owned()
            } else {
                format!("{code}-{n}")
            };
            let path = join(parent, &format!("{title} ({suffix}){ext}"));
            if self.used.insert(name_key(&path)) {
                return path;
            }
        }
        unreachable!("finite number of paths")
    }
}

fn join(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_owned()
    } else {
        format!("{parent}/{name}")
    }
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

pub(crate) fn name_key(name: &str) -> String {
    icu_normalizer::ComposingNormalizerBorrowed::new_nfkc()
        .normalize(name)
        .to_lowercase()
}

/// A portable path component, following the 0.1 cleanup rules.
fn stem(value: &str, untitled: &str) -> String {
    let normalized = icu_normalizer::ComposingNormalizerBorrowed::new_nfkc().normalize(value);
    let mut with_dots = String::new();
    let mut dots = 0;
    for c in normalized.chars().chain(std::iter::once(' ')) {
        if c == '.' {
            dots += 1;
            continue;
        }
        match dots {
            0 => {}
            1 => with_dots.push('.'),
            _ if !with_dots.ends_with('-') => with_dots.push('-'),
            _ => {}
        }
        dots = 0;
        let c = if c.is_control() || is_format(c) || "<>:\"/\\|?*#^%[]".contains(c) {
            '-'
        } else {
            c
        };
        if c != '-' || !with_dots.ends_with('-') {
            with_dots.push(c);
        }
    }
    let clean = with_dots;
    let clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    let clean = clean.trim_matches(['.', ' ']);
    if clean.is_empty() {
        return if value == untitled || untitled.is_empty() {
            "Untitled".into()
        } else {
            stem(untitled, "")
        };
    }
    let clean = limit_bytes(clean, 120).trim_end_matches(['.', ' ']);
    let device = clean
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_lowercase();
    let reserved = matches!(
        device.as_str(),
        "con" | "prn" | "aux" | "nul" | "conin$" | "conout$"
    ) || (device.len() == 4
        && (device.starts_with("com") || device.starts_with("lpt"))
        && matches!(device.as_bytes()[3], b'1'..=b'9'));
    if reserved {
        format!("_{clean}")
    } else {
        clean.into()
    }
}

fn is_format(c: char) -> bool {
    matches!(c, '\u{00AD}' | '\u{0600}'..='\u{0605}' | '\u{061C}' | '\u{06DD}' | '\u{070F}' | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{206F}' | '\u{FEFF}' | '\u{FFF9}'..='\u{FFFB}')
}

fn limit_bytes(s: &str, n: usize) -> &str {
    &s[..s.floor_char_boundary(n)]
}

fn markdown_label(label: &str) -> String {
    let mut escaped = String::new();
    for c in label.chars() {
        if c.is_ascii_punctuation() {
            escaped.push('\\');
        }
        escaped.push(if c.is_control() { ' ' } else { c });
    }
    escaped
}

pub(crate) fn markdown_destination(path: &str) -> String {
    let mut escaped = String::new();
    for c in path.chars() {
        if c.is_ascii() && !(c.is_ascii_alphanumeric() || "-._~/".contains(c)) {
            write!(escaped, "%{:02X}", c as u8).unwrap();
        } else {
            escaped.push(c);
        }
    }
    escaped
}
