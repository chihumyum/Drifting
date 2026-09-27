//! The sanitized diagnostic summary through the C ABI.
use super::*;

#[test]
fn workspace_diagnostics_count_without_names_ids_or_prose() {
    let fixture = Fixture::new();
    let handle = fixture.open(0)["handle"].as_u64().unwrap();
    let current = state(handle);
    success(
        json!({"operation":"documentReplace","handle":handle,"edit":{
        "revision":current["projection"]["revision"],"range":{"location":0,"length":0},"text":"雨夜里钟声响起。"}}),
    );
    let summary = success(json!({"operation":"workspaceDiagnostics","handle":fixture.workspace}));
    assert_eq!(summary["format"], "drifting.native-diagnostics");
    assert_eq!(summary["database"]["integrity"], "ok");
    assert!(summary["database"]["migrations"].as_u64().unwrap() >= 5);
    assert_eq!(summary["projects"][0]["chapters"], 2);
    assert_eq!(summary["openBodies"], json!({"count":1,"blocked":0}));
    assert!(summary["journal"]["local"].as_u64().unwrap() > 0);
    let text = summary.to_string();
    for private in [
        "合成写作项目",
        "初航",
        "归航",
        "雨夜",
        fixture.project.as_str(),
        fixture.chapters[0].as_str(),
    ] {
        assert!(!text.contains(private), "{private} leaked: {text}");
    }
    fixture.close();
}
