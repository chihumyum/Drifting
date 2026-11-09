//! Capture only the facade's successful coherent prose.read result. This is
//! not inferred later from a model-supplied ToolResult or receipt identifier.
use dr_agent::{ToolContext, evidence::ReadObservation};
use serde_json::Value;

use crate::{Error, Result};

pub(super) fn capture(context: &ToolContext, value: &Value) -> Result<()> {
    if context.descriptor.name != "prose.read" {
        return Ok(());
    }
    let output = &value["output"];
    let doc = output["projection"]["doc"]
        .as_str()
        .ok_or_else(|| Error::Invalid("prose read has no canonical document".into()))?;
    let observation=serde_json::from_value::<ReadObservation>(serde_json::json!({
        "doc":doc,"version":output["version"],"total":output["total"],"paragraphs":output["paragraphs"]
    })).map_err(|_|Error::Invalid("prose read has invalid evidence".into()))?;
    context.observe_read(observation)?;
    Ok(())
}
