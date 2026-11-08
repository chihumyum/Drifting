//! Destination policy ported from the 0.1 client's native_capabilities.
//! The resolver validates the addresses handed to the actual connector.
use reqwest::{
    Client, Url,
    dns::{Addrs, Name, Resolve, Resolving},
    redirect::Policy,
};
use std::{
    io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};
const NAT64_DISCOVERY_HOST: &str = "ipv4only.arpa";
const NAT64_DISCOVERY_IPV4: [Ipv4Addr; 2] =
    [Ipv4Addr::new(192, 0, 0, 170), Ipv4Addr::new(192, 0, 0, 171)];
const NAT64_WELL_KNOWN_PREFIX: Ipv6Addr = Ipv6Addr::new(0x0064, 0xff9b, 0, 0, 0, 0, 0, 0);
const RFC6052_PREFIX_LENGTHS: [u8; 6] = [32, 40, 48, 56, 64, 96];
fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let [first, second, third, _] = address.octets();

    // Only globally routable unicast addresses are useful for renderer-triggered HTTP. Keep the
    // deny list explicit because std's `is_global` API is not stable. This includes the IANA
    // special-purpose ranges that can otherwise reach this device, its LAN, or non-routed
    // infrastructure.
    !matches!(
        (first, second, third),
        (0, _, _)
            | (10, _, _)
            | (100, 64..=127, _)
            | (127, _, _)
            | (169, 254, _)
            | (172, 16..=31, _)
            | (192, 0, 0)
            | (192, 0, 2)
            | (192, 88, 99)
            | (192, 168, _)
            | (198, 18..=19, _)
            | (198, 51, 100)
            | (203, 0, 113)
            | (224..=255, _, _)
    )
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    if let Some(mapped) = address.to_ipv4_mapped() {
        return is_public_ipv4(mapped);
    }

    let segments = address.segments();

    let is_unspecified_or_ipv4_compatible = segments[..6] == [0, 0, 0, 0, 0, 0];
    let is_discard_only = segments[..4] == [0x0100, 0, 0, 0];
    let is_local_nat64 = segments[0] == 0x0064 && segments[1] == 0xff9b && segments[2] == 0x0001;
    let is_ietf_special = segments[0] == 0x2001 && segments[1] <= 0x01ff;
    let is_documentation = (segments[0] == 0x2001 && segments[1] == 0x0db8)
        || (segments[0] == 0x3fff && segments[1] & 0xf000 == 0);
    let is_six_to_four = segments[0] == 0x2002;
    let is_unique_local = segments[0] & 0xfe00 == 0xfc00;
    let is_link_or_site_local = segments[0] & 0xffc0 == 0xfe80 || segments[0] & 0xffc0 == 0xfec0;
    let is_multicast = segments[0] & 0xff00 == 0xff00;
    let is_global_unicast = segments[0] & 0xe000 == 0x2000;

    is_global_unicast
        && !is_unspecified_or_ipv4_compatible
        && !is_discard_only
        && !is_local_nat64
        && !is_ietf_special
        && !is_documentation
        && !is_six_to_four
        && !is_unique_local
        && !is_link_or_site_local
        && !is_multicast
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Nat64Prefix {
    network: u128,
    length: u8,
}

impl Nat64Prefix {
    fn from_address(address: Ipv6Addr, length: u8) -> Option<Self> {
        if !RFC6052_PREFIX_LENGTHS.contains(&length) {
            return None;
        }
        // RFC 6052 reserves bits 64..71 as the zero-valued "u" octet. For /96 that octet is
        // part of the prefix itself, so reject a prefix that could not be standards-compliant.
        if length == 96 && address.octets()[8] != 0 {
            return None;
        }
        let mask = u128::MAX << (128 - length);
        let network = u128::from(address) & mask;
        let network_address = Ipv6Addr::from(network);
        let is_well_known = length == 96 && network_address == NAT64_WELL_KNOWN_PREFIX;
        if !is_well_known && !is_public_ipv6(network_address) {
            return None;
        }
        Some(Self { network, length })
    }

    fn well_known() -> Self {
        Self::from_address(NAT64_WELL_KNOWN_PREFIX, 96).expect("valid RFC 6052 prefix")
    }

    fn matches(self, address: Ipv6Addr) -> bool {
        let mask = u128::MAX << (128 - self.length);
        u128::from(address) & mask == self.network
    }

    fn extract_ipv4(self, address: Ipv6Addr) -> Option<Ipv4Addr> {
        if !self.matches(address) {
            return None;
        }
        extract_rfc6052_ipv4(address, self.length)
    }
}

fn extract_rfc6052_ipv4(address: Ipv6Addr, prefix_length: u8) -> Option<Ipv4Addr> {
    if !RFC6052_PREFIX_LENGTHS.contains(&prefix_length) {
        return None;
    }

    let bytes = address.octets();
    if prefix_length == 96 {
        // RFC 6052 also requires the u octet to be zero for a /96 NSP.
        return (bytes[8] == 0).then(|| Ipv4Addr::new(bytes[12], bytes[13], bytes[14], bytes[15]));
    }
    if bytes[8] != 0 {
        return None;
    }

    let prefix_bytes = usize::from(prefix_length / 8);
    let before_u = 8 - prefix_bytes;
    let after_u = 4 - before_u;
    let mut embedded = [0_u8; 4];
    embedded[..before_u].copy_from_slice(&bytes[prefix_bytes..8]);
    embedded[before_u..].copy_from_slice(&bytes[9..9 + after_u]);
    Some(Ipv4Addr::from(embedded))
}

fn derive_nat64_prefixes(
    addresses: impl IntoIterator<Item = SocketAddr>,
) -> io::Result<Vec<Nat64Prefix>> {
    let mut saw_address = false;
    let mut prefixes = Vec::new();
    for address in addresses {
        saw_address = true;
        match address.ip() {
            IpAddr::V4(address) if NAT64_DISCOVERY_IPV4.contains(&address) => {}
            IpAddr::V4(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "NAT64 discovery returned an unexpected IPv4 address",
                ));
            }
            IpAddr::V6(address) => {
                let candidates = RFC6052_PREFIX_LENGTHS
                    .into_iter()
                    .filter_map(|length| {
                        NAT64_DISCOVERY_IPV4
                            .contains(&extract_rfc6052_ipv4(address, length)?)
                            .then(|| Nat64Prefix::from_address(address, length))
                            .flatten()
                    })
                    .collect::<Vec<_>>();
                // RFC 7050 requires the WKA to occur at exactly one RFC 6052 location. An
                // ambiguous or malformed answer is attacker-controlled input, so fail closed.
                if candidates.len() != 1 {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "NAT64 discovery returned an ambiguous IPv6 address",
                    ));
                }
                let prefix = candidates[0];
                if !prefixes.contains(&prefix) {
                    prefixes.push(prefix);
                }
            }
        }
    }
    if !saw_address {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "NAT64 discovery returned no addresses",
        ));
    }
    Ok(prefixes)
}

fn translated_ipv4(address: Ipv6Addr, prefixes: &[Nat64Prefix]) -> Option<Ipv4Addr> {
    std::iter::once(Nat64Prefix::well_known())
        .chain(prefixes.iter().copied())
        .find_map(|prefix| prefix.extract_ipv4(address))
}

fn validate_public_socket_addresses(
    addresses: impl IntoIterator<Item = SocketAddr>,
    discovered_nat64_prefixes: &[Nat64Prefix],
) -> io::Result<Vec<SocketAddr>> {
    let mut public_ipv4 = Vec::new();
    let mut translated_ipv6 = Vec::new();
    let mut native_ipv6 = Vec::new();
    for address in addresses {
        // Reject the whole DNS answer rather than silently dropping a private member. A mixed
        // answer is commonly used for DNS rebinding and should never be allowed to fall through
        // to connector retry order.
        match address.ip() {
            IpAddr::V4(ip) if !is_public_ipv4(ip) => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "refusing to connect to a non-public address",
                ));
            }
            IpAddr::V4(_) => {
                if !public_ipv4.contains(&address) {
                    public_ipv4.push(address);
                }
            }
            IpAddr::V6(ip) => {
                if let Some(embedded) = translated_ipv4(ip, discovered_nat64_prefixes) {
                    if !is_public_ipv4(embedded) {
                        return Err(io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            "refusing to connect to a translated non-public address",
                        ));
                    }
                    if !translated_ipv6.contains(&address) {
                        translated_ipv6.push(address);
                    }
                } else if !is_public_ipv6(ip) {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "refusing to connect to a non-public address",
                    ));
                } else if !native_ipv6.contains(&address) {
                    native_ipv6.push(address);
                }
            }
        }
    }

    // An arbitrary GUA cannot reveal whether it is native IPv6 or an RFC 6052 NSP. If RFC 7050
    // discovery found no active Pref64, prefer a validated IPv4 socket (which 464XLAT exposes to
    // applications) and discard unclassifiable IPv6. This preserves ordinary dual-stack and
    // mobile IPv4 reachability without letting an attacker encode a private IPv4 destination in
    // an undisclosed NSP. A genuinely IPv6-only origin is therefore fail-closed on such a network.
    let mut public = public_ipv4;
    public.extend(translated_ipv6);
    if !discovered_nat64_prefixes.is_empty() {
        public.extend(native_ipv6);
    } else if public.is_empty() && !native_ipv6.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "native IPv6 cannot be distinguished from an undisclosed NAT64 prefix",
        ));
    }
    if public.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "host did not resolve to a public address",
        ));
    }
    Ok(public)
}

#[derive(Clone, Copy, Debug, Default)]
struct PublicDnsResolver;

impl Resolve for PublicDnsResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let hostname = name.as_str().to_owned();
        Box::pin(async move {
            let resolved = tokio::net::lookup_host((hostname.as_str(), 0))
                .await
                .map_err(|error| -> Box<dyn std::error::Error + Send + Sync> { Box::new(error) })?
                .collect::<Vec<_>>();
            let discovered_nat64_prefixes = if resolved.iter().any(|address| address.is_ipv6()) {
                match tokio::net::lookup_host((NAT64_DISCOVERY_HOST, 0)).await {
                    Ok(addresses) => derive_nat64_prefixes(addresses).unwrap_or_default(),
                    Err(_) => Vec::new(),
                }
            } else {
                Vec::new()
            };
            let addresses = validate_public_socket_addresses(resolved, &discovered_nat64_prefixes)
                .map_err(|error| -> Box<dyn std::error::Error + Send + Sync> { Box::new(error) })?;
            Ok(Box::new(addresses.into_iter()) as Addrs)
        })
    }
}

fn validate_http_url_target(parsed: &Url) -> Result<(), String> {
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("only credential-free http(s) URLs are allowed".into());
    }

    let host = parsed
        .host_str()
        .expect("host presence checked above")
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return Err("URL host must resolve to a public address".into());
    }

    // `url` canonicalizes alternate IPv4 spellings before exposing host_str. IPv6 literals are
    // bracketed in a URL, so strip the brackets before parsing the address.
    let literal = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(address) = literal.parse::<IpAddr>() {
        let safe = match address {
            IpAddr::V4(address) => is_public_ipv4(address),
            IpAddr::V6(address) => address
                .to_ipv4_mapped()
                .map(is_public_ipv4)
                .or_else(|| {
                    Nat64Prefix::well_known()
                        .extract_ipv4(address)
                        .map(is_public_ipv4)
                })
                .unwrap_or(false),
        };
        if !safe {
            // A GUA literal may actually be an arbitrary network-specific RFC 6052 prefix. There
            // is no hostname resolution in which to discover Pref64, so native IPv6 literals are
            // deliberately unsupported. Ordinary public IPv6 hostnames still use the resolver.
            return Err("IP literal is not a verifiably public destination".into());
        }
    }
    Ok(())
}

pub(super) fn validate_url(value: &str) -> Result<Url, String> {
    if value.is_empty() || value.len() > 4096 {
        return Err("invalid MCP HTTP URL".into());
    }
    let url = Url::parse(value).map_err(|_| "invalid MCP HTTP URL")?;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("invalid MCP HTTP URL".into());
    }
    let host = url
        .host_str()
        .unwrap()
        .trim_matches(['[', ']'])
        .trim_end_matches('.');
    let local = host.eq_ignore_ascii_case("localhost")
        || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback());
    if local {
        if !matches!(url.scheme(), "http" | "https") {
            return Err("invalid loopback MCP URL".into());
        }
    } else {
        if url.scheme() != "https" {
            return Err("public MCP endpoints require HTTPS".into());
        }
        validate_http_url_target(&url).map_err(|_| "MCP destination is not allowed")?;
    }
    Ok(url)
}
#[derive(Debug)]
struct LoopbackDns;
impl Resolve for LoopbackDns {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let addresses = tokio::net::lookup_host((host.as_str(), 0))
                .await?
                .collect::<Vec<_>>();
            if addresses.is_empty() || addresses.iter().any(|a| !a.ip().is_loopback()) {
                return Err(Box::new(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "MCP loopback DNS is not loopback",
                ))
                    as Box<dyn std::error::Error + Send + Sync>);
            }
            Ok(Box::new(addresses.into_iter()) as Addrs)
        })
    }
}
pub(super) fn client(value: &str) -> Result<(Client, Url), String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let url = validate_url(value)?;
    let host = url
        .host_str()
        .unwrap()
        .trim_matches(['[', ']'])
        .trim_end_matches('.');
    let local = host.eq_ignore_ascii_case("localhost")
        || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback());
    let resolver: Arc<dyn Resolve> = if local {
        Arc::new(LoopbackDns)
    } else {
        Arc::new(PublicDnsResolver)
    };
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(300))
        .no_proxy()
        .referer(false)
        .redirect(Policy::none())
        .retry(reqwest::retry::never())
        .dns_resolver(resolver)
        .http1_max_headers(64)
        .build()
        .map_err(|_| "MCP HTTP client could not be initialized")?;
    Ok((client, url))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_only_allow_loopback_or_credential_free_public_https() {
        for allowed in [
            "http://127.0.0.1:123/mcp",
            "https://[::1]/mcp",
            "http://localhost/mcp",
            "https://example.com/mcp",
            "https://8.8.8.8/mcp",
        ] {
            assert!(validate_url(allowed).is_ok(), "{allowed}");
        }
        for (source, canonical) in [
            ("HTTPS://EXAMPLE.COM:443", "https://example.com/"),
            ("http://LOCALHOST:80", "http://localhost/"),
            ("http://127.0.0.1:123", "http://127.0.0.1:123/"),
        ] {
            assert_eq!(validate_url(source).unwrap().as_str(), canonical);
        }
        for denied in [
            "http://example.com/mcp",
            "https://user:secret@example.com/mcp",
            "https://example.com/mcp#token",
            "https://10.0.0.1/mcp",
            "https://169.254.169.254/mcp",
            "https://[64:ff9b::a00:1]/mcp",
            "https://[2606:4700:4700::1111]/mcp",
            "file:///tmp/mcp",
            "https://example.localhost/mcp",
        ] {
            assert!(validate_url(denied).is_err(), "{denied}");
        }
    }

    #[test]
    fn dns_answers_are_validated_as_a_whole_and_rebinding_to_private_is_denied() {
        let public: SocketAddr = "8.8.8.8:443".parse().unwrap();
        assert_eq!(
            validate_public_socket_addresses([public], &[]).unwrap(),
            vec![public]
        );
        for address in [
            "127.0.0.1:443",
            "10.1.2.3:443",
            "100.64.0.1:443",
            "[::1]:443",
            "[::ffff:10.0.0.1]:443",
            "[64:ff9b::a00:1]:443",
            "[fe80::1]:443",
        ] {
            let private = address.parse().unwrap();
            assert!(
                validate_public_socket_addresses([public, private], &[]).is_err(),
                "{address}"
            );
            assert!(
                validate_public_socket_addresses([private], &[]).is_err(),
                "{address}"
            );
        }
        let ambiguous = "[2606:4700:4700::1111]:443".parse().unwrap();
        assert!(validate_public_socket_addresses([ambiguous], &[]).is_err());
        assert_eq!(
            validate_public_socket_addresses([public, ambiguous], &[]).unwrap(),
            vec![public]
        );
    }

    #[test]
    fn nat64_discovery_classifies_embedded_destinations_before_connector_entry() {
        let prefix = derive_nat64_prefixes([
            "[64:ff9b::c000:aa]:0".parse().unwrap(),
            "[64:ff9b::c000:ab]:0".parse().unwrap(),
        ])
        .unwrap();
        assert_eq!(prefix, vec![Nat64Prefix::well_known()]);
        let public = "[64:ff9b::808:808]:443".parse().unwrap();
        assert_eq!(
            validate_public_socket_addresses([public], &prefix).unwrap(),
            vec![public]
        );
        for private in [
            "[64:ff9b::7f00:1]:443",
            "[64:ff9b::c0a8:101]:443",
            "[64:ff9b::a9fe:a9fe]:443",
        ] {
            assert!(validate_public_socket_addresses([private.parse().unwrap()], &prefix).is_err());
        }
        assert!(derive_nat64_prefixes(["8.8.8.8:0".parse().unwrap()]).is_err());
        assert!(derive_nat64_prefixes(["[64:ff9b::808:808]:0".parse().unwrap()]).is_err());
    }
}
