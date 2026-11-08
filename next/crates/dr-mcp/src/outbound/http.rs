//! Bounded SDK backend. Neither redirects, expired sessions nor network
//! failures can cause an application tool POST to be sent again.
use std::{
    collections::HashMap,
    io,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use futures::{StreamExt, stream::BoxStream};
use reqwest::{
    Method, Response,
    header::{HeaderMap, HeaderName, HeaderValue},
};
use rmcp::{
    model::ClientJsonRpcMessage,
    transport::streamable_http_client::{
        SseError, StreamableHttpClient, StreamableHttpError, StreamableHttpPostResponse,
    },
};
use sse_stream::{Sse, SseStream};

pub(super) const REQUEST_LIMIT: usize = 1024 * 1024;
pub(super) const RESPONSE_LIMIT: usize = 4 * 1024 * 1024;
const HEADER_LIMIT: usize = 32 * 1024;
type Error = StreamableHttpError<io::Error>;

fn fail(message: &'static str) -> Error {
    StreamableHttpError::Client(io::Error::other(message))
}

pub(super) fn forbidden_header(name: &str) -> bool {
    matches!(
        name,
        "host"
            | "cookie"
            | "connection"
            | "content-length"
            | "origin"
            | "proxy-authorization"
            | "referer"
            | "transfer-encoding"
            | "upgrade"
    ) || name.starts_with("sec-")
        || name.starts_with("proxy-")
}

pub(super) fn headers(
    values: &std::collections::BTreeMap<String, String>,
) -> crate::Result<HashMap<HeaderName, HeaderValue>> {
    let mut parsed = HashMap::new();
    let mut size = 0usize;
    for (name, value) in values {
        let name =
            HeaderName::from_bytes(name.as_bytes()).map_err(|_| "invalid MCP header name")?;
        if forbidden_header(name.as_str()) {
            return Err("forbidden MCP header".into());
        }
        let value = HeaderValue::from_str(value).map_err(|_| "invalid MCP header value")?;
        size = size.saturating_add(name.as_str().len() + value.as_bytes().len());
        if parsed.insert(name, value).is_some() {
            return Err("duplicate MCP header".into());
        }
    }
    if parsed.len() > 64 || size > HEADER_LIMIT {
        return Err("MCP header limit exceeded".into());
    }
    Ok(parsed)
}

fn bounded_headers(headers: &HeaderMap) -> Result<(), Error> {
    if headers.len() > 64
        || headers
            .iter()
            .map(|(name, value)| name.as_str().len() + value.as_bytes().len())
            .sum::<usize>()
            > HEADER_LIMIT
    {
        Err(fail("MCP header limit exceeded"))
    } else {
        Ok(())
    }
}

#[derive(Clone)]
pub(super) struct Http {
    client: reqwest::Client,
    url: Arc<str>,
    opened_get: Arc<AtomicBool>,
}

impl Http {
    pub(super) fn new(url: &str) -> crate::Result<Self> {
        let (client, url) = super::destination::client(url)?;
        Ok(Self {
            client,
            url: Arc::from(url.as_str()),
            opened_get: Arc::new(AtomicBool::new(false)),
        })
    }

    pub(super) fn endpoint(&self) -> Arc<str> {
        self.url.clone()
    }

    async fn request(
        &self,
        method: Method,
        uri: Arc<str>,
        session: Option<Arc<str>>,
        auth: Option<String>,
        custom: HashMap<HeaderName, HeaderValue>,
        body: Option<Vec<u8>>,
    ) -> Result<Response, Error> {
        if uri != self.url {
            return Err(fail("MCP endpoint changed"));
        }
        let mut request = self
            .client
            .request(method, uri.as_ref())
            .header("accept", "application/json, text/event-stream");
        for (name, value) in custom {
            if forbidden_header(name.as_str()) {
                return Err(fail("forbidden MCP header"));
            }
            request = request.header(name, value);
        }
        if let Some(session) = session {
            request = request.header("mcp-session-id", session.as_ref());
        }
        if let Some(auth) = auth {
            request = request.bearer_auth(auth);
        }
        if let Some(body) = body {
            if body.len() > REQUEST_LIMIT {
                return Err(fail("MCP request size limit exceeded"));
            }
            request = request
                .header("content-type", "application/json")
                .body(body);
        }
        let request = request.build().map_err(|_| fail("invalid MCP request"))?;
        bounded_headers(request.headers())?;
        let response = self
            .client
            .execute(request)
            .await
            .map_err(|_| fail("MCP HTTP request failed"))?;
        bounded_headers(response.headers())?;
        if response
            .content_length()
            .is_some_and(|size| size > RESPONSE_LIMIT as u64)
        {
            return Err(fail("MCP response size limit exceeded"));
        }
        Ok(response)
    }
}

fn sse(response: Response) -> BoxStream<'static, Result<Sse, SseError>> {
    let bytes = response
        .bytes_stream()
        .scan((0usize, false), |(total, failed), chunk| {
            let item = if *failed {
                None
            } else {
                Some(match chunk {
                    Ok(bytes) if total.saturating_add(bytes.len()) <= RESPONSE_LIMIT => {
                        *total += bytes.len();
                        Ok(bytes)
                    }
                    Ok(_) => {
                        *failed = true;
                        Err(io::Error::other("MCP response size limit exceeded"))
                    }
                    Err(_) => {
                        *failed = true;
                        Err(io::Error::other("MCP response interrupted"))
                    }
                })
            };
            futures::future::ready(item)
        });
    SseStream::from_bytes_stream(bytes).boxed()
}

async fn body(mut response: Response) -> Result<Vec<u8>, Error> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| fail("MCP response interrupted"))?
    {
        if bytes.len().saturating_add(chunk.len()) > RESPONSE_LIMIT {
            return Err(fail("MCP response size limit exceeded"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

impl StreamableHttpClient for Http {
    type Error = io::Error;
    async fn post_message(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session: Option<Arc<str>>,
        auth: Option<String>,
        custom: HashMap<HeaderName, HeaderValue>,
    ) -> Result<StreamableHttpPostResponse, Error> {
        let bytes = serde_json::to_vec(&message).map_err(|_| fail("invalid MCP message"))?;
        let had_session = session.is_some();
        let response = self
            .request(Method::POST, uri, session, auth, custom, Some(bytes))
            .await?;
        let status = response.status();
        if matches!(status.as_u16(), 202 | 204) {
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        if status.as_u16() == 404 && had_session {
            return Err(StreamableHttpError::SessionExpired);
        }
        if !status.is_success() {
            return Err(fail("MCP server rejected the request"));
        }
        let session = response
            .headers()
            .get("mcp-session-id")
            .map(|v| v.to_str().map(str::to_owned))
            .transpose()
            .map_err(|_| fail("invalid MCP session header"))?;
        let content = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if content
            .split(';')
            .next()
            .is_some_and(|v| v.trim() == "text/event-stream")
        {
            return Ok(StreamableHttpPostResponse::Sse(sse(response), session));
        }
        if !content
            .split(';')
            .next()
            .is_some_and(|v| v.trim() == "application/json")
        {
            return Err(fail("invalid MCP response content type"));
        }
        let message = serde_json::from_slice(&body(response).await?)
            .map_err(|_| fail("invalid MCP JSON response"))?;
        Ok(StreamableHttpPostResponse::Json(message, session))
    }
    async fn delete_session(
        &self,
        uri: Arc<str>,
        session: Arc<str>,
        auth: Option<String>,
        custom: HashMap<HeaderName, HeaderValue>,
    ) -> Result<(), Error> {
        let response = self
            .request(Method::DELETE, uri, Some(session), auth, custom, None)
            .await?;
        if !response.status().is_success() && !matches!(response.status().as_u16(), 404 | 405) {
            return Err(fail("MCP session could not be closed"));
        }
        let _ = body(response).await?;
        Ok(())
    }
    async fn get_stream(
        &self,
        uri: Arc<str>,
        session: Option<Arc<str>>,
        last_event: Option<String>,
        auth: Option<String>,
        custom: HashMap<HeaderName, HeaderValue>,
    ) -> Result<BoxStream<'static, Result<Sse, SseError>>, Error> {
        // NeverRetry alone permits server-suggested retry intervals. Refuse
        // every resume/reconnect before HTTP entry as well.
        if last_event.is_some() || self.opened_get.swap(true, Ordering::SeqCst) {
            return Err(fail("MCP stream reconnect requires an author action"));
        }
        let response = self
            .request(Method::GET, uri, session, auth, custom, None)
            .await?;
        if response.status().as_u16() == 405 {
            return Err(StreamableHttpError::ServerDoesNotSupportSse);
        }
        if !response.status().is_success() {
            return Err(fail("MCP stream request failed"));
        }
        if !response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                v.split(';')
                    .next()
                    .is_some_and(|v| v.trim() == "text/event-stream")
            })
        {
            return Err(fail("invalid MCP stream content type"));
        }
        Ok(sse(response))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn custom_headers_cannot_override_transport_or_exceed_limits() {
        for name in [
            "Host",
            "Cookie",
            "Connection",
            "Content-Length",
            "Origin",
            "Proxy-Authorization",
            "Referer",
            "Transfer-Encoding",
            "Upgrade",
            "Sec-Fetch-Site",
            "Proxy-Test",
        ] {
            assert!(
                headers(&BTreeMap::from([(name.into(), "synthetic".into())])).is_err(),
                "{name}"
            );
        }
        assert!(
            headers(&BTreeMap::from([
                ("Authorization".into(), "first".into()),
                ("authorization".into(), "second".into())
            ]))
            .is_err()
        );
        assert!(
            headers(&BTreeMap::from([(
                "x-test".into(),
                "line\r\ninjection".into()
            )]))
            .is_err()
        );
        assert!(
            headers(&BTreeMap::from([(
                "x-test".into(),
                "x".repeat(HEADER_LIMIT)
            )]))
            .is_err()
        );
        assert!(headers(&(0..65).map(|n| (format!("x-{n}"), "test".into())).collect()).is_err());
        assert!(
            headers(&BTreeMap::from([
                ("Authorization".into(), "Bearer synthetic".into()),
                ("x-public".into(), "visible".into())
            ]))
            .is_ok()
        );
    }
    #[tokio::test]
    async fn oversized_request_is_rejected_before_any_socket_is_opened() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let uri: Arc<str> = format!("http://{}/mcp", listener.local_addr().unwrap()).into();
        let client = Http::new(&uri).unwrap();
        let message: ClientJsonRpcMessage = serde_json::from_value(serde_json::json!({
            "jsonrpc":"2.0", "id":1, "method":"tools/call", "params":{"name":"synthetic", "arguments":{"text":"x".repeat(REQUEST_LIMIT)}}
        })).unwrap();
        assert!(
            client
                .post_message(uri, message, None, None, HashMap::new())
                .await
                .is_err()
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(30), listener.accept())
                .await
                .is_err()
        );
    }
}
