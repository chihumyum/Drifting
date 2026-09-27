//! Import into new bodies and whole-book export through the C ABI.
use super::*;

fn transfer(fixture: &Fixture, command: Value) -> Value {
    json!({"operation":"workspaceTransfer","handle":fixture.workspace,"projectId":fixture.project,"command":command})
}

#[test]
fn workspace_transfer_imports_bodies_and_exports_the_book() {
    let fixture = Fixture::new();
    let imported = success(transfer(
        &fixture,
        json!({"action":"importBlocks",
        "target":{"kind":"chapter","title":"导入章"},
        "blocks":[
            {"kind":"heading","level":1,"text":"雨夜"},
            {"kind":"paragraph","text":"她推开北塔的门。","marks":[{"mark":"bold","location":3,"length":2},{"mark":"italic","location":0,"length":1}]},
            {"kind":"heading","level":5,"text":"细节"},
            {"kind":"paragraph","text":"钟声\n响起"}
        ]}),
    ));
    let chapter = imported["entity"]["id"].as_str().unwrap().to_string();
    let handle = success(
        json!({"operation":"workspaceOpenChapter","handle":fixture.workspace,
        "projectId":fixture.project,"chapterId":chapter}),
    )["handle"]
        .as_u64()
        .unwrap();
    let projection = state(handle)["projection"].clone();
    assert_eq!(
        projection["text"],
        "雨夜\n她推开北塔的门。\n细节\n钟声 响起"
    );
    let kinds: Vec<(String, Value)> = projection["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| {
            (
                b["kind"].as_str().unwrap().to_string(),
                b["attributes"]["level"].clone(),
            )
        })
        .collect();
    assert_eq!(kinds[0], ("heading".into(), json!(1)));
    assert_eq!(
        kinds[2],
        ("heading".into(), json!(3)),
        "deeper headings become level 3"
    );
    assert_eq!(kinds[1].0, "paragraph");
    let runs = projection["blocks"][1]["runs"].as_array().unwrap();
    let marked: Vec<(u64, u64, Vec<String>)> = runs
        .iter()
        .filter(|run| !run["attributes"].as_object().unwrap().is_empty())
        .map(|run| {
            (
                run["range"]["location"].as_u64().unwrap(),
                run["range"]["length"].as_u64().unwrap(),
                run["attributes"]
                    .as_object()
                    .unwrap()
                    .keys()
                    .cloned()
                    .collect(),
            )
        })
        .collect();
    let offset = "雨夜\n".encode_utf16().count() as u64;
    assert_eq!(
        marked,
        vec![
            (offset, 1, vec!["italic".to_string()]),
            (offset + 3, 2, vec!["bold".to_string()])
        ]
    );
    // A drift and an element import the same way; an element needs a category.
    success(transfer(
        &fixture,
        json!({"action":"importBlocks","target":{"kind":"drift","title":"灵感"},
        "blocks":[{"kind":"paragraph","text":"钟楼"}]}),
    ));
    assert!(rejected(transfer(
        &fixture,
        json!({"action":"importBlocks","target":{"kind":"element","title":"米拉"},
        "blocks":[{"kind":"paragraph","text":"x"}]})
    ))
    .contains("分类"));
    assert!(rejected(transfer(
        &fixture,
        json!({"action":"importBlocks","target":{"kind":"chapter","title":"x"},"blocks":[]})
    ))
    .contains("为空"));
    assert!(rejected(transfer(&fixture, json!({"action":"importBlocks","target":{"kind":"chapter","title":"越界"},
        "blocks":[{"kind":"paragraph","text":"短","marks":[{"mark":"bold","location":0,"length":5}]}]}))).contains("超出"));
    // Export: the book title, then chapters in order with their bodies; the
    // open imported chapter is read live.
    success(
        json!({"operation":"documentReplace","handle":handle,"edit":{
        "revision":projection["revision"],"range":{"location":0,"length":0},"text":"序："}}),
    );
    let markdown = success(transfer(
        &fixture,
        json!({"action":"exportBook","format":"markdown"}),
    ))["text"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(markdown.starts_with("# "), "{markdown}");
    assert!(
        markdown.contains(
            "## 导入章\n\n### 序：雨夜\n\n*她*推开**北塔**的门。\n\n##### 细节\n\n钟声 响起"
        ),
        "{markdown}"
    );
    let text = success(transfer(
        &fixture,
        json!({"action":"exportBook","format":"text"}),
    ))["text"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        text.contains("导入章\n\n序：雨夜\n她推开北塔的门。\n细节\n钟声 响起"),
        "{text}"
    );
    assert!(rejected(transfer(
        &fixture,
        json!({"action":"exportBook","format":"pdf"})
    ))
    .contains("不支持"));
    fixture.close();
}
