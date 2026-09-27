//! Deleting a project through the C ABI: refused while its bodies are open,
//! then rows, prose and asset bytes go while other projects stay.
use super::*;

#[test]
fn workspace_project_deletion_closes_nothing_silently_and_removes_bytes() {
    let mut fixture = Fixture::new();
    let other = success(json!({"operation":"workspaceCreateProject",
        "handle":fixture.workspace,"name":"留下的书"}))["id"]
        .as_str()
        .unwrap()
        .to_string();
    let sources = tempfile::tempdir().unwrap();
    let png = sources.path().join("塔.png");
    std::fs::write(&png, b"synthetic png bytes").unwrap();
    let imported = success(
        json!({"operation":"workspaceLibrary","handle":fixture.workspace,
        "projectId":fixture.project,"command":{"action":"importFile","title":"塔",
        "file":{"path":png,"mime":"image/png","extension":"png","width":32,"height":20}}}),
    );
    let stored = std::path::PathBuf::from(
        imported["library"]["items"][0]["assetPath"]
            .as_str()
            .unwrap(),
    );
    assert!(stored.exists());
    let delete = |fixture: &Fixture| json!({"operation":"workspaceDeleteProject","handle":fixture.workspace,"projectId":fixture.project});
    fixture.open(0);
    assert!(rejected(delete(&fixture)).contains("先关闭"));
    success(
        json!({"operation":"workspaceCloseChapter","handle":fixture.workspace,
        "projectId":fixture.project,"chapterId":fixture.chapters[0]}),
    );
    let deleted = success(delete(&fixture));
    assert_eq!(deleted["deleted"]["assetIds"].as_array().unwrap().len(), 1);
    let projects = deleted["projects"].as_array().unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0]["id"], other);
    assert!(!stored.exists(), "asset bytes follow the committed rows");
    rejected(delete(&fixture));
    rejected(
        json!({"operation":"workspaceOpenChapter","handle":fixture.workspace,
        "projectId":fixture.project,"chapterId":fixture.chapters[1]}),
    );
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    let listed = success(json!({"operation":"workspaceProjects","handle":fixture.workspace}));
    assert_eq!(listed.to_string().matches(&other).count() >= 1, true);
    assert!(!listed.to_string().contains(&fixture.project));
    fixture.close();
}
