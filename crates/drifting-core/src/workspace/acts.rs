//! Local editing of separators on the existing continuous book axis. An act
//! never owns chapter rows or prose; removing one only removes its boundary.
use super::*;

#[cfg(test)]
mod tests;

impl WorkspaceStore<'_> {
    pub fn create_act_before_chapter(
        &self,
        context: &AuthoredProseContext,
        act_id: &str,
        chapter_id: &str,
    ) -> Result<WorkspaceAct, String> {
        validate_context(context)?;
        if !opaque(act_id) || !opaque(chapter_id) {
            return Err("Invalid act or chapter identity".into());
        }
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let chapter = self.chapters(Some(tx), &context.project_id)?.into_iter()
                .find(|chapter| chapter.id == chapter_id)
                .ok_or("Chapter is not available in this project")?;
            let start_order = chapter.book_order;
            if !start_order.is_finite() {
                return Err("Act boundary must be finite".into());
            }
            let mut position = 1;
            for row in self.query(Some(tx), "SELECT start_order FROM book_act WHERE project_id=?",
                vec![text(&context.project_id)])? {
                if row[0] == V::Null {
                    position += 1;
                } else {
                    let order = number(&row, 0)?;
                    if order == start_order {
                        return Err("An act boundary already exists before this chapter".into());
                    }
                    if order < start_order { position += 1; }
                }
            }
            let act = WorkspaceAct {
                id: act_id.into(), project_id: context.project_id.clone(), name: default_act_name(position),
                color: None, start_order: Some(start_order), drift_node_id: None,
                created_at: context.now_iso.clone(), updated_at: context.now_iso.clone(),
            };
            self.execute(tx, r#"
                INSERT INTO book_act(id,project_id,name,color,start_order,drift_node_id,created_at,updated_at)
                VALUES (?,?,?,NULL,?,NULL,?,?)
            "#, vec![text(act_id),text(&context.project_id),text(&act.name),V::Real(start_order),
                text(&context.now_iso),text(&context.now_iso)])?;
            self.commit_changes(tx, context, &[
                journal::Mutation::create("book-act", act_id, json!({
                    "name":act.name,"color":null,"startOrder":start_order,"driftNodeId":null,
                })),
            ], None)?;
            Ok(act)
        })
    }

    /// Rename only: the author's coordinate, colour and bound notes survive.
    pub fn rename_act(
        &self,
        context: &AuthoredProseContext,
        act_id: &str,
        name: &str,
    ) -> Result<WorkspaceAct, String> {
        validate_context(context)?;
        if !opaque(act_id) || js_trim(name).is_empty() {
            return Err("Invalid act identity or empty name".into());
        }
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let (mut act, incarnation) = self.live_act(tx, context, act_id)?;
            if act.name == name {
                return Ok(act);
            }
            self.execute(
                tx,
                "UPDATE book_act SET name=?,updated_at=? WHERE id=? AND project_id=?",
                vec![
                    text(name),
                    text(&context.now_iso),
                    text(act_id),
                    text(&context.project_id),
                ],
            )?;
            self.commit_changes(
                tx,
                context,
                &[journal::Mutation::field(
                    "book-act",
                    act_id,
                    incarnation,
                    "name",
                    json!(name),
                )],
                None,
            )?;
            act.name = name.into();
            act.updated_at = context.now_iso.clone();
            Ok(act)
        })
    }

    /// Sets (`#rrggbb`) or clears (`None`) the act's colour; unchanged
    /// colours write nothing.
    pub fn set_act_color(
        &self,
        context: &AuthoredProseContext,
        act_id: &str,
        color: Option<&str>,
    ) -> Result<WorkspaceAct, String> {
        validate_context(context)?;
        if !opaque(act_id) || color.is_some_and(|value| !elements::color(value)) {
            return Err("Invalid act identity or colour".into());
        }
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let (mut act, incarnation) = self.live_act(tx, context, act_id)?;
            if act.color.as_deref() == color {
                return Ok(act);
            }
            self.execute(
                tx,
                "UPDATE book_act SET color=?,updated_at=? WHERE id=? AND project_id=?",
                vec![
                    color.map(text).unwrap_or(V::Null),
                    text(&context.now_iso),
                    text(act_id),
                    text(&context.project_id),
                ],
            )?;
            self.commit_changes(
                tx,
                context,
                &[journal::Mutation::field(
                    "book-act",
                    act_id,
                    incarnation,
                    "color",
                    json!(color),
                )],
                None,
            )?;
            act.color = color.map(Into::into);
            act.updated_at = context.now_iso.clone();
            Ok(act)
        })
    }

    /// A drift is bound solely by book_act.drift_node_id. Deleting this row
    /// releases that binding without changing or deleting the drift or prose.
    pub fn remove_act(
        &self,
        context: &AuthoredProseContext,
        act_id: &str,
    ) -> Result<WorkspaceAct, String> {
        validate_context(context)?;
        if !opaque(act_id) {
            return Err("Invalid act identity".into());
        }
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let (act, incarnation) = self.live_act(tx, context, act_id)?;
            self.execute(
                tx,
                "DELETE FROM book_act WHERE id=? AND project_id=?",
                vec![text(act_id), text(&context.project_id)],
            )?;
            self.commit_changes(
                tx,
                context,
                &[
                    journal::Mutation::json(
                        "entity",
                        "book-act",
                        act_id,
                        "entity.purge",
                        json!({}),
                    )
                    .at_incarnation(incarnation),
                ],
                None,
            )?;
            Ok(act)
        })
    }

    pub(super) fn live_act(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        act_id: &str,
    ) -> Result<(WorkspaceAct, u64), String> {
        let rows = self.query(Some(tx), r#"
            SELECT a.id,a.project_id,a.name,a.color,a.start_order,a.drift_node_id,a.created_at,a.updated_at,
                l.incarnation
            FROM book_act a JOIN sync_entity_lifecycle l ON l.sync_generation_id=?
                AND l.entity_kind='book-act' AND l.entity_id=a.id AND l.state='live'
            WHERE a.id=? AND a.project_id=?
        "#, vec![text(&context.sync_generation_id),text(act_id),text(&context.project_id)])?;
        let row = rows.first().ok_or("Act is not live in this project")?;
        let incarnation = match &row[8] {
            V::Integer(value) => value.parse::<u64>().ok().filter(|value| *value <= MAX_SAFE),
            _ => None,
        }
        .ok_or("Invalid act incarnation")?;
        let optional_text = |index| match &row[index] {
            V::Null => Ok(None),
            V::Text(value) => Ok(Some(value.clone())),
            _ => Err("Invalid act optional text".to_string()),
        };
        Ok((
            WorkspaceAct {
                id: string(row, 0)?,
                project_id: string(row, 1)?,
                name: string(row, 2)?,
                color: optional_text(3)?,
                start_order: if row[4] == V::Null {
                    None
                } else {
                    Some(number(row, 4)?)
                },
                drift_node_id: optional_text(5)?,
                created_at: string(row, 6)?,
                updated_at: string(row, 7)?,
            },
            incarnation,
        ))
    }
}

// Matches domain/book-act.ts: 1..99 use Chinese numerals, others use digits.
fn default_act_name(position: u64) -> String {
    const DIGITS: [&str; 10] = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
    if !(1..=99).contains(&position) {
        return format!("第{position}幕");
    }
    if position < 10 {
        return format!("第{}幕", DIGITS[position as usize]);
    }
    let tens = position / 10;
    let ones = position % 10;
    format!(
        "第{}十{}幕",
        if tens == 1 { "" } else { DIGITS[tens as usize] },
        if ones == 0 { "" } else { DIGITS[ones as usize] }
    )
}
