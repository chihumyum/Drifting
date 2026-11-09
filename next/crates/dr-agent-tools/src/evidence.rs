//! Capture only the facade's successful coherent prose.read or module.read_prose
//! result. This is not inferred later from a model-supplied ToolResult or
//! receipt identifier.
use dr_agent::{ToolContext, evidence::ReadObservation};
use serde_json::Value;

use crate::{Error, Result, resolve::ResolvedCall};

pub(super) fn capture(context: &ToolContext, call: &ResolvedCall, value: &Value) -> Result<()> {
    let output = &value["output"];
    let doc = match context.descriptor.name.as_str() {
        "prose.read" => output["projection"]["doc"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| Error::Invalid("prose read has no canonical document".into()))?,
        "module.read_prose" => {
            if output["version"].as_str().unwrap_or_default().is_empty() {
                return Ok(());
            }
            crate::resolve::prose_doc_from_module_args(&call.arguments)
                .ok_or_else(|| Error::Invalid("module.read_prose has no document".into()))?
        }
        _ => return Ok(()),
    };
    let observation = serde_json::from_value::<ReadObservation>(serde_json::json!({
        "doc":doc,"version":output["version"],"total":output["total"],"paragraphs":output["paragraphs"]
    }))
    .map_err(|_| Error::Invalid("prose read has invalid evidence".into()))?;
    context.observe_read(observation)?;
    Ok(())
}
