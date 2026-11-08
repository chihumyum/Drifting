use crate::{ProviderError, Result};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

/// Incremental UTF-8 decoding at line boundaries handles fragmented multibyte
/// text, LF, CRLF and CR, comments, a leading BOM and multi-line data fields.
#[derive(Default)]
pub struct SseParser {
    line: Vec<u8>,
    data: Vec<String>,
    event: Option<String>,
    after_cr: bool,
    began: bool,
}

impl SseParser {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<SseEvent>> {
        let mut events = Vec::new();
        for &byte in bytes {
            if self.after_cr {
                self.after_cr = false;
                if byte == b'\n' {
                    continue;
                }
            }
            if byte == b'\r' || byte == b'\n' {
                self.after_cr = byte == b'\r';
                if let Some(event) = self.line()? {
                    events.push(event);
                }
            } else {
                self.line.push(byte);
            }
        }
        Ok(events)
    }

    fn line(&mut self) -> Result<Option<SseEvent>> {
        let bytes = std::mem::take(&mut self.line);
        let raw = std::str::from_utf8(&bytes)
            .map_err(|_| ProviderError::protocol("invalid SSE UTF-8"))?;
        let line = if !self.began {
            raw.trim_start_matches('\u{feff}')
        } else {
            raw
        };
        self.began = true;
        if line.is_empty() {
            let event = self.event.take();
            if self.data.is_empty() {
                return Ok(None);
            }
            return Ok(Some(SseEvent {
                event,
                data: std::mem::take(&mut self.data).join("\n"),
            }));
        }
        let (name, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match name {
            "event" => self.event = Some(value.to_owned()),
            "data" => self.data.push(value.to_owned()),
            _ => {}
        }
        Ok(None)
    }

    /// EOF is not an SSE frame delimiter. Never accept a truncated last frame.
    pub fn finish(&self) -> Result<()> {
        if self.line.is_empty() && self.data.is_empty() && self.event.is_none() {
            Ok(())
        } else {
            Err(ProviderError::protocol("truncated SSE frame"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_byte_boundary_crlf_bom_comments_and_multiline() {
        let bytes = "\u{feff}: ping\r\nevent: content\rdata: 汉字\r\ndata: second\n\n".as_bytes();
        for split in 0..=bytes.len() {
            let mut parser = SseParser::default();
            let mut got = parser.push(&bytes[..split]).unwrap();
            got.extend(parser.push(&bytes[split..]).unwrap());
            parser.finish().unwrap();
            assert_eq!(
                got,
                vec![SseEvent {
                    event: Some("content".into()),
                    data: "汉字\nsecond".into()
                }]
            );
        }
    }
    #[test]
    fn rejects_invalid_utf8_and_unterminated_data() {
        assert!(SseParser::default().push(&[0xff, b'\n']).is_err());
        let mut parser = SseParser::default();
        assert!(parser.push(b"data: unfinished\n").unwrap().is_empty());
        assert!(parser.finish().is_err());
    }
}
