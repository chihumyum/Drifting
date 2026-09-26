//! Read-only act separators and chapter membership on the existing book axis.
//! The renderer's book-act derivation owns the same <= boundary convention.
use super::*;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOutlineRow {
    pub kind: &'static str,
    pub id: String,
    pub title: String,
    pub act_id: Option<String>,
}

struct Act {
    id: String,
    title: String,
    start_order: Option<f64>,
}

impl Act {
    fn row(&self) -> WorkspaceOutlineRow {
        WorkspaceOutlineRow {
            kind: "act",
            id: self.id.clone(),
            title: self.title.clone(),
            act_id: None,
        }
    }
}

impl WorkspaceStore<'_> {
    /// Return act separators and chapters in one continuous reading order.
    /// A null boundary is an optional head act; chapters before the first finite
    /// boundary stay unassigned. Empty acts remain visible. No prose is loaded.
    pub fn outline(&self, project_id: &str) -> Result<Vec<WorkspaceOutlineRow>, String> {
        if !opaque(project_id) {
            return Err("Invalid outline project identity".into());
        }
        self.transaction(TransactionBehavior::Deferred, |tx| {
            let scope = self.query(
                Some(tx),
                r#"
                SELECT g.sync_generation_id FROM project p
                JOIN sync_generation g ON g.project_id=p.id AND g.status='active'
                LEFT JOIN sync_entity_lifecycle l ON l.sync_generation_id=g.sync_generation_id
                    AND l.entity_kind='project' AND l.entity_id=p.id
                WHERE p.id=? AND (l.state IS NULL OR l.state='live')
                    AND NOT EXISTS (SELECT 1 FROM sync_generation_purge x
                        WHERE x.sync_generation_id=g.sync_generation_id)
                "#,
                vec![text(project_id)],
            )?;
            if scope.len() != 1 {
                return Err("Outline project has no available active generation".into());
            }
            let generation = string(&scope[0], 0)?;
            let chapters = self.chapters(Some(tx), project_id)?;
            let acts = self
                .query(
                    Some(tx),
                    r#"
                SELECT a.id,a.name,a.start_order FROM book_act a
                LEFT JOIN sync_entity_lifecycle l ON l.sync_generation_id=?
                    AND l.entity_kind='book-act' AND l.entity_id=a.id
                WHERE a.project_id=? AND (l.state IS NULL OR l.state='live')
                ORDER BY a.start_order,a.id COLLATE BINARY
                "#,
                    vec![text(&generation), text(project_id)],
                )?
                .into_iter()
                .map(|row| {
                    Ok(Act {
                        id: string(&row, 0)?,
                        title: string(&row, 1)?,
                        start_order: match row.get(2) {
                            Some(V::Null) => None,
                            _ => Some(number(&row, 2)?),
                        },
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
            // SQLite's BINARY collation is UTF-8 byte order. Consume every act
            // at a chapter's coordinate first, so the last tied act owns it.
            let mut acts = acts.iter().peekable();
            let mut active_act = None;
            let mut rows = Vec::with_capacity(chapters.len() + acts.len());
            for chapter in chapters {
                while acts.peek().is_some_and(|act| {
                    act.start_order
                        .is_none_or(|order| order <= chapter.book_order)
                }) {
                    let act = acts.next().expect("The next act was checked");
                    active_act = Some(act.id.clone());
                    rows.push(act.row());
                }
                rows.push(WorkspaceOutlineRow {
                    kind: "chapter",
                    id: chapter.id,
                    title: chapter.title,
                    act_id: active_act.clone(),
                });
            }
            rows.extend(acts.map(Act::row));
            Ok(rows)
        })
    }
}

#[cfg(test)]
mod tests;
