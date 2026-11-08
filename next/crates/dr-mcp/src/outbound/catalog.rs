use std::collections::HashSet;

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{RemoteTool, storage::Record};

pub(super) fn bind(epoch: &str, book: &str, record: &mut Record) {
    for tool in &mut record.info.tools {
        let bytes = serde_json::to_vec(&(
            &epoch,
            book,
            &record.info.id,
            &record.info.revision,
            &record.info.transport,
            &record.catalog_revision,
            &tool.name,
            &tool.description,
            &tool.input_schema,
        ))
        .expect("serializable MCP catalog");
        tool.revision = format!("mcp-{:x}", Sha256::digest(bytes));
    }
}

/// A bounded schema shape check, with only local references. No schema can
/// cause filesystem or HTTP reference resolution on the author's machine.
pub(super) fn schema(value: &Value) -> crate::Result<()> {
    if !value.is_object()
        || serde_json::to_vec(value)
            .map_err(|_| "invalid MCP schema")?
            .len()
            > 65536
    {
        return Err("invalid or oversized MCP tool schema".into());
    }
    fn walk(root: &Value, value: &Value, depth: usize) -> Result<(), ()> {
        if depth > 64 {
            return Err(());
        }
        if value.is_boolean() {
            return Ok(());
        }
        let map = value.as_object().ok_or(())?;
        for (key, value) in map {
            match key.as_str() {
                "type" => {
                    let valid = |value: &Value| {
                        value.as_str().is_some_and(|s| {
                            matches!(
                                s,
                                "object"
                                    | "array"
                                    | "string"
                                    | "number"
                                    | "integer"
                                    | "boolean"
                                    | "null"
                            )
                        })
                    };
                    if !valid(value)
                        && !value
                            .as_array()
                            .is_some_and(|a| !a.is_empty() && a.iter().all(valid))
                    {
                        return Err(());
                    }
                }
                "$ref" => {
                    let reference = value.as_str().ok_or(())?;
                    let path = reference.strip_prefix('#').ok_or(())?;
                    if !path.is_empty() && !path.starts_with('/') {
                        return Err(());
                    }
                    if !root
                        .pointer(path)
                        .is_some_and(|target| target.is_object() || target.is_boolean())
                    {
                        return Err(());
                    }
                }
                "properties" | "patternProperties" | "definitions" | "$defs"
                | "dependentSchemas" => {
                    for child in value.as_object().ok_or(())?.values() {
                        walk(root, child, depth + 1)?;
                    }
                }
                "additionalProperties"
                | "unevaluatedProperties"
                | "contains"
                | "propertyNames"
                | "not"
                | "if"
                | "then"
                | "else"
                | "additionalItems" => walk(root, value, depth + 1)?,
                "items" => {
                    if let Some(items) = value.as_array() {
                        for child in items {
                            walk(root, child, depth + 1)?;
                        }
                    } else {
                        walk(root, value, depth + 1)?;
                    }
                }
                "allOf" | "anyOf" | "oneOf" | "prefixItems" => {
                    let items = value.as_array().ok_or(())?;
                    if items.is_empty() {
                        return Err(());
                    }
                    for child in items {
                        walk(root, child, depth + 1)?;
                    }
                }
                "required" => {
                    let names = value.as_array().ok_or(())?;
                    let mut unique = HashSet::new();
                    for name in names {
                        if !unique.insert(name.as_str().ok_or(())?) {
                            return Err(());
                        }
                    }
                }
                "enum" => {
                    let choices = value.as_array().ok_or(())?;
                    if choices.is_empty()
                        || choices
                            .iter()
                            .enumerate()
                            .any(|(i, item)| choices[..i].contains(item))
                    {
                        return Err(());
                    }
                }
                "minLength" | "maxLength" | "minItems" | "maxItems" | "minProperties"
                | "maxProperties" | "minContains" | "maxContains"
                    if !value.is_u64() =>
                {
                    return Err(());
                }
                "minimum" | "maximum" | "exclusiveMinimum" | "exclusiveMaximum"
                    if !value.is_number() =>
                {
                    return Err(());
                }
                "multipleOf" if !value.as_f64().is_some_and(|n| n > 0.0) => return Err(()),
                "uniqueItems" | "readOnly" | "writeOnly" | "deprecated" if !value.is_boolean() => {
                    return Err(());
                }
                "$schema" | "$id" | "$anchor" | "title" | "description" | "format" | "pattern"
                    if !value.is_string() =>
                {
                    return Err(());
                }
                _ => {}
            }
        }
        Ok(())
    }
    walk(value, value, 0).map_err(|_| "invalid MCP tool schema".to_owned())
}

pub(super) async fn discover(connection: &super::Connection) -> crate::Result<Vec<RemoteTool>> {
    let mut tools = Vec::new();
    let mut names = HashSet::new();
    let mut cursors = HashSet::new();
    let mut cursor = None;
    for page in 0..16 {
        let result = connection
            .service
            .list_tools(Some(
                rmcp::model::PaginatedRequestParams::default().with_cursor(cursor),
            ))
            .await
            .map_err(|_| "MCP tool discovery failed")?;
        for tool in result.tools {
            if tool.name.is_empty()
                || tool.name.len() > 200
                || tool.name.chars().any(char::is_control)
                || !names.insert(tool.name.to_string())
                || tools.len() >= 256
            {
                return Err("invalid or oversized MCP tool catalog".into());
            }
            let input_schema = Value::Object((*tool.input_schema).clone());
            schema(&input_schema)?;
            if let Some(output) = tool.output_schema {
                schema(&Value::Object((*output).clone()))?;
            }
            let description = tool.description.unwrap_or_default().into_owned();
            if description.len() > 16384 {
                return Err("oversized MCP tool description".into());
            }
            tools.push(RemoteTool {
                name: tool.name.into_owned(),
                description,
                input_schema,
                revision: String::new(),
            });
        }
        match result.next_cursor {
            None => return Ok(tools),
            Some(next)
                if page < 15
                    && !next.is_empty()
                    && next.len() <= 4096
                    && cursors.insert(next.clone()) =>
            {
                cursor = Some(next)
            }
            _ => return Err("MCP tool pagination is invalid or exceeds its limit".into()),
        }
    }
    Err("MCP tool pagination limit exceeded".into())
}
