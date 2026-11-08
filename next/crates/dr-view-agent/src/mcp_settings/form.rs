//! Pure editor projection. Secret values are never read from storage.
use dr_mcp::outbound::{
    ConfigValue, SecretInput, ServerDraft, ServerInfo, TransportConfig, TransportDraft,
};
use std::collections::BTreeMap;

pub(super) fn retained(server: &ServerInfo, enabled: bool) -> ServerDraft {
    let values = |entries: &BTreeMap<String, ConfigValue>| {
        entries
            .iter()
            .map(|(name, value)| {
                (
                    name.clone(),
                    match value {
                        ConfigValue::Public(value) => SecretInput::Public(value.clone()),
                        ConfigValue::Secret { .. } => SecretInput::Keep,
                    },
                )
            })
            .collect()
    };
    let transport = match &server.transport {
        TransportConfig::Stdio {
            command,
            args,
            cwd,
            env,
        } => TransportDraft::Stdio {
            command: command.clone(),
            args: args.clone(),
            cwd: cwd.clone(),
            env: values(env),
        },
        TransportConfig::Http { url, headers } => TransportDraft::Http {
            url: url.clone(),
            headers: values(headers),
        },
    };
    ServerDraft {
        id: Some(server.id.clone()),
        expected_revision: Some(server.revision.clone()),
        name: server.name.clone(),
        enabled,
        transport,
    }
}

pub(super) fn values(
    public: &str,
    secrets: &[(String, String)],
) -> Result<BTreeMap<String, SecretInput>, String> {
    let mut values = BTreeMap::new();
    for line in public
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let (name, value) = line
            .split_once('=')
            .ok_or("MCP values must use NAME=value")?;
        insert(&mut values, name.trim(), value.trim(), false)?;
    }
    for (name, value) in secrets {
        if name.trim().is_empty() && value.is_empty() {
            continue;
        }
        insert(&mut values, name.trim(), value, true)?;
    }
    Ok(values)
}

fn insert(
    values: &mut BTreeMap<String, SecretInput>,
    name: &str,
    value: &str,
    secret: bool,
) -> Result<(), String> {
    if name.is_empty()
        || name.len() > 200
        || name
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, '\0' | '='))
        || value.len() > 8000
        || value.contains(['\0', '\r', '\n'])
        || (!secret && value.is_empty())
    {
        return Err("Invalid MCP NAME=value entry".into());
    }
    if values.contains_key(name) {
        return Err("Duplicate MCP value name".into());
    }
    values.insert(
        name.into(),
        if secret {
            if value.is_empty() {
                SecretInput::Keep
            } else {
                SecretInput::Set(value.into())
            }
        } else {
            SecretInput::Public(value.into())
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use dr_mcp::outbound::Status;
    #[test]
    fn retained_configuration_never_expands_a_secret_reference() {
        let server = ServerInfo {
            id: "synthetic-server".into(),
            name: "Synthetic".into(),
            enabled: true,
            revision: "revision".into(),
            status: Status::Disabled,
            tools: vec![],
            transport: TransportConfig::Http {
                url: "https://synthetic.invalid/mcp".into(),
                headers: BTreeMap::from([
                    (
                        "Public".into(),
                        ConfigValue::Public("synthetic-public".into()),
                    ),
                    (
                        "Authorization".into(),
                        ConfigValue::Secret {
                            reference: "synthetic-reference".into(),
                        },
                    ),
                ]),
            },
        };
        let draft = retained(&server, false);
        assert!(!draft.enabled);
        assert_eq!(draft.expected_revision.as_deref(), Some("revision"));
        let TransportDraft::Http { headers, .. } = draft.transport else {
            panic!()
        };
        assert!(matches!(
            headers.get("Authorization"),
            Some(SecretInput::Keep)
        ));
        assert!(
            matches!(headers.get("Public"),Some(SecretInput::Public(value)) if value=="synthetic-public")
        );
    }
    #[test]
    fn secret_editing_keeps_sets_or_omits_without_accepting_duplicate_names() {
        let edited = values(
            "Public=synthetic",
            &[
                ("Keep".into(), String::new()),
                ("Set".into(), "synthetic-new".into()),
            ],
        )
        .unwrap();
        assert!(matches!(edited.get("Keep"), Some(SecretInput::Keep)));
        assert!(
            matches!(edited.get("Set"),Some(SecretInput::Set(value)) if value=="synthetic-new")
        );
        assert!(!edited.contains_key("Removed"));
        assert!(values("Name=one\nName=two", &[]).is_err());
        assert!(values("Name=one", &[("Name".into(), "secret".into())]).is_err());
        assert!(values("Bad\0=one", &[]).is_err());
        assert!(values("", &[("Name".into(), "line\nsecret".into())]).is_err());
    }
}
