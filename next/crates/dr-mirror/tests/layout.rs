use std::collections::BTreeSet;

use dr_mirror::layout::{BookLayout, Names, project_folder_name};
use dr_model::DocId;
use dr_model::id::{AssetFolderId, BodyDocId, BookId, EntryId, EntryTemplateId, ModuleId};
use dr_model::time::Timestamp;
use dr_model::v3::{EntryTemplate, LevelSettingsOverride, ModuleSpec, ProjectBook};
use dr_testkit::seed::{BuilderV3, SeedFile};

fn entry(id: &str) -> EntryId {
    EntryId::parse(id).unwrap()
}

fn template(id: &str) -> EntryTemplateId {
    EntryTemplateId::parse(id).unwrap()
}

fn module(id: &str) -> ModuleId {
    ModuleId::parse(id).unwrap()
}

fn prose(id: &str, name: &str, in_book: bool) -> ModuleSpec {
    let mut prose = ModuleSpec::prose(module(id), name, false, false);
    prose.config.in_book = in_book;
    prose
}

fn shape(id: &str, modules: Vec<ModuleSpec>, accepts: bool) -> EntryTemplate {
    EntryTemplate {
        id: template(id),
        name: id.into(),
        mark: None,
        color: None,
        agent: None,
        modules,
        level: false,
        linkable: false,
        settings: LevelSettingsOverride {
            accept: accepts.then_some(true),
            ..Default::default()
        },
        verbs: Vec::new(),
        deleted_at: None,
    }
}

fn names() -> Names {
    Names {
        contents: "目录".into(),
        assets: "素材库".into(),
        untitled: "未命名".into(),
    }
}

fn plan(seed: &BuilderV3, filled: &[(&str, &str)]) -> BookLayout {
    let view = seed.book.view();
    let filled: BTreeSet<_> = filled
        .iter()
        .map(|(e, m)| DocId::Body(BodyDocId::new(entry(e), module(m))))
        .collect();
    BookLayout::new(
        &view.structure_snapshot(),
        &view.asset_folders_raw(),
        &view.assets_raw(),
        &filled,
        &names(),
    )
}

#[test]
fn example_tree_and_contents_follow_residence_and_book_order() {
    let mut seed = BuilderV3::new(BookId::parse("mirror-layout").unwrap()).unwrap();
    seed.edit_book(|t| {
        t.meta().name("慢钟")?;
        t.project().book(Some(&ProjectBook::default()))?;
        for spec in [
            shape("description", vec![prose("body", "说明", false)], false),
            shape("narrative", vec![prose("body", "说明", false)], true),
            shape("passage", vec![prose("body", "正文", true)], false),
        ] {
            t.template(&spec.id)?.set_full(&spec)?;
        }
        for (id, parent, title, kind, level) in [
            ("manuscript", None, "书稿", "description", true),
            ("volume", Some("manuscript"), "第一卷", "description", true),
            ("tower", Some("volume"), "钟楼", "passage", false),
            ("rain", Some("volume"), "雨夜", "passage", false),
            ("end", Some("manuscript"), "尾声", "passage", false),
            ("ideas", None, "构想", "description", true),
            ("group", Some("ideas"), "伏笔", "description", true),
            ("repair", Some("group"), "修理单", "description", false),
            ("elements", None, "要素", "description", true),
            ("people", Some("elements"), "人物", "description", true),
            ("anna", Some("people"), "安娜", "description", false),
            ("places", Some("elements"), "地点", "description", true),
            ("tower-place", Some("places"), "钟楼", "description", false),
            ("threads", None, "故事线", "description", true),
            ("main", Some("threads"), "主线", "narrative", false),
            ("memory", Some("threads"), "回忆线", "narrative", false),
        ] {
            t.entries().create(
                &entry(id),
                parent.map(entry).as_ref(),
                title,
                Some(&template(kind)),
                level,
            )?;
        }
        let folder = AssetFolderId::parse("reference").unwrap();
        t.asset_folder(&folder)?.name("参考图")?;
        // The seed generator supplies the bytes and the corresponding record.
        let mut photo = SeedFile::image("tower-image", 32, 32).record("钟楼外观.png", None);
        photo.folder = Some(folder);
        t.put_asset(&photo)?;
        t.put_asset(&SeedFile::pdf("map").record("地图.pdf", None))?;

        t.put_membership(&entry("main"), &entry("rain"), None, None)?;
        t.put_membership(&entry("memory"), &entry("rain"), None, None)?;
        t.entries()
            .entry(&entry("rain"))?
            .primary(Some(&entry("main")))?;
        Ok(())
    })
    .unwrap();

    let filled = [("volume", "body"), ("main", "body")];
    let layout = plan(&seed, &filled);
    let mut paths: Vec<_> = layout
        .prose
        .iter()
        .filter(|file| file.present)
        .map(|file| file.path.as_str())
        .chain(
            layout
                .assets
                .iter()
                .filter(|a| a.present)
                .map(|a| a.path.as_str()),
        )
        .chain([layout.contents_path.as_str()])
        .collect();
    paths.sort_unstable();
    let mut expected = [
        "目录.md",
        "书稿/第一卷/第一卷.md",
        "书稿/第一卷/钟楼.md",
        "书稿/第一卷/雨夜.md",
        "书稿/尾声.md",
        "构想/伏笔/修理单.md",
        "要素/人物/安娜.md",
        "要素/地点/钟楼.md",
        "故事线/主线.md",
        "故事线/回忆线.md",
        "素材库/参考图/钟楼外观.png",
        "素材库/地图.pdf",
    ];
    expected.sort_unstable();
    assert_eq!(paths, expected);
    assert!(layout.directories.contains("书稿"));
    assert!(layout.directories.contains("素材库/参考图"));
    assert_eq!(
        layout.memberships[&entry("rain")],
        ["[[主线]]", "[[回忆线]]"]
    );
    assert_eq!(
        layout.contents,
        "- [钟楼](书稿/第一卷/钟楼.md)\n- [雨夜](书稿/第一卷/雨夜.md)\n- [尾声](书稿/尾声.md)\n"
    );
    assert!(
        layout
            .prose
            .iter()
            .any(|f| f.path == "书稿/书稿.md" && !f.present)
    );

    seed.edit_book(|t| {
        t.project().book(None)?;
        Ok(())
    })
    .unwrap();
    let whole = plan(&seed, &filled);
    assert!(
        whole
            .contents
            .starts_with("- 书稿\n  - [第一卷](书稿/第一卷/第一卷.md)\n")
    );
    assert!(
        whole
            .contents
            .contains("  - 地点\n    - [钟楼](要素/地点/钟楼.md)\n")
    );
    assert_eq!(whole.contents.matches("(书稿/第一卷/雨夜.md)").count(), 3);
}

#[test]
fn collisions_are_stable_in_creation_order_and_keep_reserved_paths() {
    let mut seed = BuilderV3::new(BookId::parse("mirror-names").unwrap()).unwrap();
    seed.edit_book(|t| {
        for spec in [
            shape("description", vec![prose("body", "说明", false)], false),
            shape(
                "two",
                vec![prose("first", "梗概", true), prose("second", "正文", true)],
                false,
            ),
        ] {
            t.template(&spec.id)?.set_full(&spec)?;
        }
        for (id, parent, title, kind, level, created) in [
            ("new", None, "ＡＢＣ", Some("description"), false, 2),
            ("old", None, "abc", Some("description"), false, 1),
            ("volume", None, "第一卷", Some("description"), true, 3),
            (
                "child",
                Some("volume"),
                "第一卷",
                Some("description"),
                false,
                1,
            ),
            ("index", None, "目录", Some("description"), false, 4),
            ("assets", None, "素材库", Some("description"), true, 5),
            ("multi", None, "多篇", Some("two"), false, 6),
            ("no-prose", None, "只有字段", None, false, 7),
            ("folder-only", None, "只有下层", None, true, 8),
            ("trashed", None, "最近删除", Some("description"), false, 9),
        ] {
            t.entries()
                .create(
                    &entry(id),
                    parent.map(entry).as_ref(),
                    title,
                    kind.map(template).as_ref(),
                    level,
                )?
                .created_at(Some(Timestamp(created)))?;
        }
        t.entries()
            .entry(&entry("trashed"))?
            .deleted_at(Some(Timestamp(10)))?;
        Ok(())
    })
    .unwrap();
    let layout = plan(&seed, &[("volume", "body")]);
    let path = |id: &str, mod_id: &str| {
        &layout
            .prose
            .iter()
            .find(|p| p.id.entry() == &entry(id) && p.id.module() == &module(mod_id))
            .unwrap()
            .path
    };
    assert_eq!(path("old", "body"), "abc.md");
    assert!(path("new", "body").starts_with("ABC ("));
    assert_eq!(path("volume", "body"), "第一卷/第一卷.md");
    assert!(path("child", "body").starts_with("第一卷/第一卷 ("));
    assert!(path("index", "body").starts_with("目录 ("));
    assert!(layout.directories.iter().any(|p| p.starts_with("素材库 (")));
    assert_eq!(path("multi", "first"), "多篇 · 梗概.md");
    assert_eq!(path("multi", "second"), "多篇 · 正文.md");
    assert_eq!(layout.prose.len(), 8);
    assert!(layout.contents.contains("- 只有字段\n"));
    assert!(layout.directories.contains("只有下层"));

    seed.edit_book(|t| t.entries().move_before(&entry("old"), &entry("new")))
        .unwrap();
    assert_eq!(plan(&seed, &[("volume", "body")]).prose, layout.prose);
}

#[test]
fn renaming_moving_and_closing_a_level_only_changes_live_paths() {
    let mut seed = BuilderV3::new(BookId::parse("mirror-move").unwrap()).unwrap();
    seed.edit_book(|t| {
        let spec = shape("description", vec![prose("body", "说明", false)], false);
        t.template(&spec.id)?.set_full(&spec)?;
        t.entries()
            .create(&entry("volume"), None, "第一卷", Some(&spec.id), true)?;
        t.entries()
            .create(&entry("target"), None, "另一个家", None, true)?;
        t.entries().create(
            &entry("child"),
            Some(&entry("volume")),
            "钟楼",
            Some(&spec.id),
            false,
        )?;
        Ok(())
    })
    .unwrap();
    let filled = [("volume", "body")];
    assert!(
        plan(&seed, &filled)
            .prose
            .iter()
            .any(|p| p.path == "第一卷/钟楼.md")
    );
    seed.edit_book(|t| {
        let tree = t.entries();
        tree.move_to(&entry("volume"), Some(&entry("target")))?;
        tree.entry(&entry("volume"))?.title("改名")?;
        Ok(())
    })
    .unwrap();
    let renamed = plan(&seed, &filled);
    assert!(
        renamed
            .prose
            .iter()
            .any(|p| p.path == "另一个家/改名/改名.md")
    );
    assert!(
        renamed
            .prose
            .iter()
            .any(|p| p.path == "另一个家/改名/钟楼.md")
    );
    seed.edit_book(|t| {
        t.entries()
            .switch_level_off(&entry("volume"), Timestamp(16000))?;
        Ok(())
    })
    .unwrap();
    let closed = plan(&seed, &filled);
    assert_eq!(closed.prose.len(), 1);
    assert_eq!(closed.prose[0].path, "另一个家/改名.md");
}

#[test]
fn shared_project_root_adds_numbers_and_compares_normalized_names() {
    assert_eq!(
        project_folder_name("慢钟", &names(), ["慢钟", "慢钟 2"]),
        "慢钟 3"
    );
    assert_eq!(project_folder_name("ＦＯＯ", &names(), ["foo"]), "FOO 2");
    assert_eq!(project_folder_name("", &names(), []), "未命名");
}
