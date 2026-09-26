//! Complete project CanonicalCborValue model, using the pinned CBOR codec.
//! This adapter restricts the codec to the production model, with bounded work.
use ciborium_io::Read;
use ciborium_ll::{Decoder, Encoder, Header};
use std::collections::BTreeSet;
use std::ops::Range;

pub(super) const MAX_SAFE: u64 = (1 << 53) - 1;
const MAX_DEPTH: usize = 64;
const MAX_NODES: usize = 100_000;
#[derive(Clone, Debug)]
pub(super) struct Node {
    pub kind: Value,
    pub span: Range<usize>,
}
#[derive(Clone, Debug)]
pub(super) enum Value {
    Null,
    Bool(bool),
    Number(f64),
    Text(String),
    Bytes(Vec<u8>),
    Array(Vec<Node>),
    Map(Vec<(String, Node)>),
}
fn err(s: &str) -> String {
    format!("original canonical CBOR: {s}")
}
fn decode_node(
    d: &mut Decoder<&[u8]>,
    input_len: usize,
    depth: usize,
    nodes: &mut usize,
) -> Result<Node, String> {
    *nodes += 1;
    if *nodes > MAX_NODES || depth > MAX_DEPTH {
        return Err(err("node/depth budget exceeded"));
    }
    let start = d.offset();
    let h = d.pull().map_err(|e| err(&format!("decode: {e:?}")))?;
    let kind = match h {
        Header::Simple(20) => Value::Bool(false),
        Header::Simple(21) => Value::Bool(true),
        Header::Simple(22) => Value::Null,
        Header::Positive(n) if n <= MAX_SAFE => Value::Number(n as f64),
        Header::Negative(n) if n < MAX_SAFE => Value::Number(-1.0 - n as f64),
        Header::Float(n) if n.is_finite() => Value::Number(n),
        Header::Bytes(Some(n)) | Header::Text(Some(n)) => {
            if n > input_len.saturating_sub(d.offset()) {
                return Err(err("truncated byte/text body"));
            }
            let mut bytes = vec![0; n];
            d.read_exact(&mut bytes)
                .map_err(|e| err(&format!("body: {e:?}")))?;
            if matches!(h, Header::Text(_)) {
                Value::Text(String::from_utf8(bytes).map_err(|_| err("invalid UTF-8"))?)
            } else {
                Value::Bytes(bytes)
            }
        }
        Header::Array(Some(n)) => {
            if n > MAX_NODES - *nodes || n > input_len.saturating_sub(d.offset()) {
                return Err(err("array budget exceeded"));
            }
            let mut out = Vec::new();
            for _ in 0..n {
                out.push(decode_node(d, input_len, depth + 1, nodes)?);
            }
            Value::Array(out)
        }
        Header::Map(Some(n)) => {
            if n > MAX_NODES - *nodes || n > input_len.saturating_sub(d.offset()) / 2 {
                return Err(err("map budget exceeded"));
            }
            let mut seen = BTreeSet::new();
            let mut out = Vec::new();
            for _ in 0..n {
                let Header::Text(Some(length)) =
                    d.pull().map_err(|e| err(&format!("key: {e:?}")))?
                else {
                    return Err(err("map key must be a definite string"));
                };
                if length > input_len.saturating_sub(d.offset()) {
                    return Err(err("truncated map key"));
                }
                let mut bytes = vec![0; length];
                d.read_exact(&mut bytes)
                    .map_err(|e| err(&format!("key: {e:?}")))?;
                let key = String::from_utf8(bytes).map_err(|_| err("invalid UTF-8 map key"))?;
                if !seen.insert(key.clone()) {
                    return Err(err("duplicate map key"));
                }
                let value = decode_node(d, input_len, depth + 1, nodes)?;
                out.push((key, value));
            }
            Value::Map(out)
        }
        _ => {
            return Err(err(
                "unsupported integer, non-finite number, tag, simple or indefinite value",
            ))
        }
    };
    Ok(Node {
        kind,
        span: start..d.offset(),
    })
}
fn emit(node: &Node, out: &mut Vec<u8>) {
    fn head(out: &mut Vec<u8>, h: Header) {
        Encoder::from(out)
            .push(h)
            .expect("Vec CBOR writer is infallible");
    }
    match &node.kind {
        Value::Null => head(out, Header::Simple(22)),
        Value::Bool(v) => head(out, Header::Simple(if *v { 21 } else { 20 })),
        Value::Number(v) => {
            // Match cborg's JS number encoder: safe integers (including -0) use major
            // 0/1; other finite numbers use the shortest exactly representing float.
            if v.fract() == 0.0 && v.abs() <= MAX_SAFE as f64 {
                if *v >= 0.0 {
                    head(out, Header::Positive(*v as u64));
                } else {
                    head(out, Header::Negative((-1.0 - *v) as u64));
                }
            } else {
                head(out, Header::Float(*v));
            }
        }
        Value::Text(v) => {
            head(out, Header::Text(Some(v.len())));
            out.extend(v.as_bytes());
        }
        Value::Bytes(v) => {
            head(out, Header::Bytes(Some(v.len())));
            out.extend(v);
        }
        Value::Array(v) => {
            head(out, Header::Array(Some(v.len())));
            for value in v {
                emit(value, out);
            }
        }
        Value::Map(v) => {
            let mut pairs: Vec<_> = v
                .iter()
                .map(|(key, value)| {
                    let mut b = Vec::new();
                    Encoder::from(&mut b)
                        .push(Header::Text(Some(key.len())))
                        .unwrap();
                    b.extend(key.as_bytes());
                    (b, value)
                })
                .collect();
            pairs.sort_by(|a, b| a.0.cmp(&b.0));
            head(out, Header::Map(Some(v.len())));
            for (key, value) in pairs {
                out.extend(key);
                emit(value, out);
            }
        }
    }
}
pub(super) fn decode(bytes: &[u8]) -> Result<Node, String> {
    let mut decoder = Decoder::from(bytes);
    let node = decode_node(&mut decoder, bytes.len(), 0, &mut 0)?;
    if decoder.offset() != bytes.len() {
        return Err(err("trailing bytes"));
    }
    let mut canonical = Vec::new();
    emit(&node, &mut canonical);
    if canonical != bytes {
        return Err(err("noncanonical bytes"));
    }
    Ok(node)
}
impl Node {
    pub fn map(&self) -> Result<&[(String, Node)], String> {
        if let Value::Map(v) = &self.kind {
            Ok(v)
        } else {
            Err(err("expected map"))
        }
    }
    pub fn field(&self, key: &str) -> Result<&Node, String> {
        self.map()?
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
            .ok_or_else(|| err(&format!("missing {key}")))
    }
    pub fn has(&self, key: &str) -> bool {
        self.map().is_ok_and(|m| m.iter().any(|(k, _)| k == key))
    }
    pub fn keys(&self, keys: &[&str]) -> Result<(), String> {
        let m = self.map()?;
        if m.len() != keys.len() || m.iter().any(|(k, _)| !keys.contains(&k.as_str())) {
            Err(err("unexpected map keys"))
        } else {
            Ok(())
        }
    }
    pub fn text(&self) -> Result<&str, String> {
        if let Value::Text(v) = &self.kind {
            Ok(v)
        } else {
            Err(err("expected string"))
        }
    }
    pub fn bytes(&self) -> Result<&[u8], String> {
        if let Value::Bytes(v) = &self.kind {
            Ok(v)
        } else {
            Err(err("expected bytes"))
        }
    }
    pub fn array(&self) -> Result<&[Node], String> {
        if let Value::Array(v) = &self.kind {
            Ok(v)
        } else {
            Err(err("expected array"))
        }
    }
    pub fn uint(&self, max: u64) -> Result<u64, String> {
        if let Value::Number(v) = self.kind {
            if v >= 0.0 && v.fract() == 0.0 && v <= max as f64 {
                return Ok(v as u64);
            }
        }
        Err(err("invalid unsigned integer"))
    }
}
