//! Short, read-only queries for the empty conversation's three requests.

use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};

use crate::onboarding::{Chapter, Element, StarterSource};

pub fn starters(ws: &Workspace, book: &str) -> Result<StarterSource, String> {
    let read = |name, input| {
        ws.call(&Actor::User, name, input)
            .map(|value| value["output"].clone())
            .map_err(|error| error.to_string())
    };
    let chapters = read("chapter.list", json!({"book":book}))?;
    let elements = read("element.list", json!({"book":book}))?;
    let relations = read("relation.list", json!({"book":book}))?;
    let recent = read("recent.list", json!({"book":book}))?;
    let mut chapter_rows = Vec::new();
    for (index, row) in chapters.as_array().into_iter().flatten().enumerate() {
        let (Some(id), Some(title)) = (row["id"].as_str(), row["title"].as_str()) else {
            continue;
        };
        let mut words = row["words"].as_u64().unwrap_or(0);
        if words == 0 {
            // Chapter words are a derived index and may not have been built
            // yet. The guide only needs presence, so consult the live F3
            // owner rather than treating an unindexed manuscript as empty.
            // Read all paragraphs: text after 200 empty paragraphs still counts.
            let prose = read(
                "prose.read",
                json!({"doc":format!("node:{id}"),"limit":usize::MAX}),
            )?;
            words = u64::from(prose["paragraphs"].as_array().into_iter().flatten().any(
                |paragraph| {
                    paragraph["text"]
                        .as_str()
                        .is_some_and(|text| !text.trim().is_empty())
                },
            ));
        }
        chapter_rows.push(Chapter {
            id: id.into(),
            title: title.into(),
            book_order: index,
            word_count: words,
        });
    }
    let mut source = StarterSource {
        chapters: chapter_rows,
        ..Default::default()
    };
    let mut rows: Vec<_> = elements.as_array().into_iter().flatten().collect();
    rows.sort_by_key(|row| (row["created_at"].as_i64().unwrap_or(0), row["id"].as_str()));
    source.elements = rows
        .into_iter()
        .filter_map(|row| {
            Some(Element {
                id: row["id"].as_str()?.into(),
                name: row["name"].as_str()?.into(),
            })
        })
        .collect();
    for row in relations.as_array().into_iter().flatten() {
        for key in ["from", "to"] {
            let target = &row[key];
            if target["kind"] == "element"
                && let Some(id) = target["id"].as_str()
            {
                *source.relation_counts.entry(id.into()).or_default() += 1;
            }
        }
    }
    source.recent_chapter_ids = recent
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let target = &row["target"];
            (target["kind"] == "node")
                .then(|| target["id"].as_str().map(str::to_owned))
                .flatten()
        })
        .collect();
    Ok(source)
}

/// A provider activity may contain arbitrary data. Only a normal web URL is
/// offered as an external link; the activity text itself remains readable.
pub fn web_url(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    (matches!(url.scheme(), "https" | "http") && url.host_str().is_some()).then(|| url.into())
}

pub fn tool_name(call: &dr_agent::ToolCall) -> &str {
    if call.name == "call_tool" {
        call.arguments["name"].as_str().unwrap_or(&call.name)
    } else {
        &call.name
    }
}

pub fn result_text(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use dr_i18n::keys::agent_panel::onboarding::prompts;
    use dr_testkit::seed::{self, Preset};

    #[test]
    fn recent_node_routes_starters_to_the_non_first_written_chapter() {
        let directory = tempfile::tempdir().unwrap();
        let library = dr_store::Library::open(
            directory.path(),
            dr_workspace::library_options("m31-starters-test"),
        )
        .unwrap();
        let seeded = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().to_string();
        seeded.write_to(&library).unwrap();
        let workspace =
            Workspace::open(library, dr_workspace::WorkspaceOptions::default()).unwrap();
        let listed = workspace
            .call(&Actor::User, "chapter.list", json!({"book":book}))
            .unwrap();
        assert!(
            listed["output"]
                .as_array()
                .unwrap()
                .iter()
                .all(|chapter| chapter["words"] == 0),
            "the regression must exercise the unbuilt index"
        );
        let before = starters(&workspace, &book).unwrap();
        let written: Vec<_> = before
            .chapters
            .iter()
            .filter(|chapter| chapter.word_count > 0)
            .collect();
        assert!(
            written.len() > 1,
            "the tiny seed has several written chapters"
        );
        let first = written[0];
        let recent = written[1];
        assert_eq!(
            crate::onboarding::build_starter_prompts(&before)[0].values,
            vec![("chapter", first.title.clone())]
        );
        workspace
            .call(
                &Actor::User,
                "recent.touch",
                json!({"book":book,"target":{"kind":"node","id":recent.id}}),
            )
            .unwrap();
        let after = starters(&workspace, &book).unwrap();
        assert_eq!(after.recent_chapter_ids.first(), Some(&recent.id));
        let requests = crate::onboarding::build_starter_prompts(&after);
        assert_eq!(requests[0].key, prompts::COMMENT_CHAPTER);
        assert_eq!(requests[0].values, vec![("chapter", recent.title.clone())]);
        assert_eq!(requests[1].values, vec![("chapter", recent.title.clone())]);
        workspace.shutdown().unwrap();
    }

    #[test]
    fn provider_activity_links_require_http_and_a_host() {
        for denied in [
            "javascript:alert(1)",
            "file:///tmp/example",
            "data:text/plain,example",
            "https://",
            "http:///",
            "/relative",
        ] {
            assert!(web_url(denied).is_none(), "{denied}");
        }
        assert_eq!(
            web_url("https://example.invalid/path?q=test").as_deref(),
            Some("https://example.invalid/path?q=test")
        );
        assert_eq!(
            web_url("http://example.invalid/").as_deref(),
            Some("http://example.invalid/")
        );
    }
}
