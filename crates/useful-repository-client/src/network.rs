//! Network destination policy for repository-controlled URLs.
//!
//! Syntax/redirect validation is pure. Callers must additionally resolve each
//! hop, pass every returned address through `validate_resolved_addresses`, and
//! pin those exact addresses into the HTTP client before connecting. That
//! closes DNS rebinding rather than merely filtering the hostname string.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use url::{Host, Url};

#[derive(Debug, thiserror::Error)]
pub enum NetworkPolicyError {
    #[error("URL 无效: {0}")]
    InvalidUrl(String),
    #[error("生产源 URL 必须为 HTTPS")]
    HttpsRequired,
    #[error("本地/开发 URL 仅允许 file:// 或 loopback 主机")]
    LocalBoundary,
    #[error("file URL 必须是无远程 host、query 或 fragment 的本机绝对路径")]
    FileBoundary,
    #[error("URL 禁止用户名、密码或 fragment")]
    AmbiguousAuthority,
    #[error("目标主机缺失")]
    MissingHost,
    #[error("目标解析到被禁止的本地、私有、保留或特殊地址: {0}")]
    ForbiddenAddress(IpAddr),
    #[error("目标没有可用的解析地址")]
    NoAddresses,
    #[error("重定向次数超限")]
    TooManyRedirects,
}

fn hostname_is_loopback(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "localhost" || host.ends_with(".localhost")
}

fn parsed_is_local(url: &Url) -> bool {
    if url.scheme() == "file" {
        return true;
    }
    url.host_str().is_some_and(hostname_is_loopback)
        || matches!(url.host(), Some(Host::Ipv4(ip)) if ip.is_loopback())
        || matches!(url.host(), Some(Host::Ipv6(ip)) if ip.is_loopback())
}

pub fn is_forbidden_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => forbidden_v4(ip),
        IpAddr::V6(ip) => forbidden_v6(ip),
    }
}

fn forbidden_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, d] = ip.octets();
    a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 168 && b == 63 && c == 129 && d == 16) // Azure platform virtual IP
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 88 && c == 99)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224
        || (a == 255 && b == 255 && c == 255 && d == 255)
}

fn forbidden_v6(ip: Ipv6Addr) -> bool {
    let o = ip.octets();
    if ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        || (o[0] & 0xfe) == 0xfc // unique-local fc00::/7
        || (o[0] & 0xe0) != 0x20 // outside global-unicast 2000::/3
        || (o[0] == 0xfe && (o[1] & 0xc0) == 0x80) // link-local fe80::/10
        || (o[0] == 0xfe && (o[1] & 0xc0) == 0xc0) // deprecated site-local fec0::/10
        || (o[..2] == [0x20, 0x01] && o[2] < 0x02) // IETF special-purpose 2001::/23
        || (o[..4] == [0x20, 0x01, 0x0d, 0xb8]) // documentation
        || (o[..2] == [0x20, 0x02]) // deprecated 6to4 (embedded IPv4)
        || (o[0] == 0x3f && (o[1] & 0xf0) == 0xf0) // documentation 3fff::/20
        || (o[..8] == [0x01, 0x00, 0, 0, 0, 0, 0, 0]) // discard-only 100::/64
        || (o[..6] == [0x20, 0x01, 0x00, 0x02, 0, 0])
    // benchmarking
    {
        return true;
    }
    // IPv4-compatible and IPv4-mapped IPv6 must inherit the IPv4 policy.
    let seg = ip.segments();
    if seg[..6] == [0, 0, 0, 0, 0, 0] || seg[..6] == [0, 0, 0, 0, 0, 0xffff] {
        return forbidden_v4(Ipv4Addr::new(o[12], o[13], o[14], o[15]));
    }
    false
}

/// Validate a URL before DNS. `allow_local` is only for an explicitly marked
/// developer/local source; it never permits arbitrary cleartext remote hosts.
pub fn validate_url(url: &str, allow_local: bool) -> Result<Url, NetworkPolicyError> {
    if url.len() > 2048 {
        return Err(NetworkPolicyError::InvalidUrl("URL 过长".into()));
    }
    let parsed = Url::parse(url).map_err(|e| NetworkPolicyError::InvalidUrl(e.to_string()))?;
    if !parsed.username().is_empty() || parsed.password().is_some() || parsed.fragment().is_some() {
        return Err(NetworkPolicyError::AmbiguousAuthority);
    }
    if parsed.scheme() == "file" {
        if !allow_local {
            return Err(NetworkPolicyError::LocalBoundary);
        }
        if parsed.host().is_some() || parsed.query().is_some() || !parsed.path().starts_with('/') {
            return Err(NetworkPolicyError::FileBoundary);
        }
        return Ok(parsed);
    }
    let host = parsed.host_str().ok_or(NetworkPolicyError::MissingHost)?;
    let literal = match parsed.host() {
        Some(Host::Ipv4(ip)) => Some(IpAddr::V4(ip)),
        Some(Host::Ipv6(ip)) => Some(IpAddr::V6(ip)),
        _ => None,
    };
    if allow_local
        && matches!(parsed.scheme(), "http" | "https")
        && (hostname_is_loopback(host) || literal.is_some_and(|ip| ip.is_loopback()))
    {
        return Ok(parsed);
    }
    if parsed.scheme() != "https" {
        return Err(NetworkPolicyError::HttpsRequired);
    }
    if hostname_is_loopback(host) {
        return Err(NetworkPolicyError::LocalBoundary);
    }
    if let Some(ip) = literal {
        if is_forbidden_ip(ip) {
            return Err(NetworkPolicyError::ForbiddenAddress(ip));
        }
    }
    Ok(parsed)
}

pub fn validate_resolved_addresses(
    addresses: impl IntoIterator<Item = IpAddr>,
    allow_local: bool,
) -> Result<Vec<IpAddr>, NetworkPolicyError> {
    let addresses: Vec<IpAddr> = addresses.into_iter().collect();
    if addresses.is_empty() {
        return Err(NetworkPolicyError::NoAddresses);
    }
    for ip in &addresses {
        if allow_local && !ip.is_loopback() {
            return Err(NetworkPolicyError::ForbiddenAddress(*ip));
        }
        if !allow_local && is_forbidden_ip(*ip) {
            return Err(NetworkPolicyError::ForbiddenAddress(*ip));
        }
    }
    Ok(addresses)
}

pub fn validate_redirect(
    previous: &Url,
    location: &str,
    redirects_followed: usize,
    allow_local: bool,
) -> Result<Url, NetworkPolicyError> {
    if redirects_followed >= crate::discovery::MAX_REDIRECTS {
        return Err(NetworkPolicyError::TooManyRedirects);
    }
    let next = previous
        .join(location)
        .map_err(|e| NetworkPolicyError::InvalidUrl(e.to_string()))?;
    // Local access is explicit per chain: a public-looking URL may not bounce
    // into loopback merely because the source was originally added in
    // developer mode.
    validate_url(next.as_str(), allow_local && parsed_is_local(previous))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_rejects_local_private_reserved_and_metadata_destinations() {
        for url in [
            "http://example.com/x",
            "https://localhost/x",
            "https://127.0.0.1/x",
            "https://0.0.0.0/x",
            "https://10.0.0.1/x",
            "https://100.64.0.1/x",
            "https://169.254.169.254/latest/meta-data",
            "https://168.63.129.16/metadata",
            "https://192.168.1.1/x",
            "https://192.0.2.1/x",
            "https://192.88.99.1/x",
            "https://198.18.0.1/x",
            "https://224.0.0.1/x",
            "https://240.0.0.1/x",
            "https://255.255.255.255/x",
            "https://[::1]/x",
            "https://[::]/x",
            "https://[ff02::1]/x",
            "https://[fe80::1]/x",
            "https://[fc00::1]/x",
            "https://[::ffff:127.0.0.1]/x",
            "https://[2001:db8::1]/x",
            "file:///tmp/source.json",
        ] {
            assert!(validate_url(url, false).is_err(), "{url}");
        }
    }

    #[test]
    fn dns_answer_set_fails_closed_if_any_address_is_forbidden() {
        assert!(validate_resolved_addresses(
            [
                "93.184.216.34".parse().unwrap(),
                "127.0.0.1".parse().unwrap()
            ],
            false,
        )
        .is_err());
        assert!(validate_resolved_addresses(
            ["2606:2800:220:1:248:1893:25c8:1946".parse().unwrap()],
            false
        )
        .is_ok());
    }

    #[test]
    fn every_redirect_hop_reapplies_scheme_and_destination_policy() {
        let start = validate_url("https://example.com/a", false).unwrap();
        assert!(validate_redirect(&start, "http://example.com/b", 0, false).is_err());
        assert!(validate_redirect(&start, "https://127.0.0.1/b", 0, false).is_err());
        assert!(validate_redirect(&start, "/next", 0, false).is_ok());
        assert!(
            validate_redirect(&start, "/next", crate::discovery::MAX_REDIRECTS, false).is_err()
        );
    }

    #[test]
    fn developer_boundary_allows_only_file_or_loopback_cleartext() {
        assert!(validate_url("file:///C:/repo/discovery.json", true).is_ok());
        assert!(validate_url("file://fileserver/share/discovery.json", true).is_err());
        assert!(validate_url("file:///C:/repo/discovery.json?remote=1", true).is_err());
        assert!(validate_url("http://localhost:8080/discovery", true).is_ok());
        assert!(validate_url("http://127.0.0.1:8080/discovery", true).is_ok());
        assert!(validate_url("http://example.com/discovery", true).is_err());
        assert!(validate_url("http://192.168.1.10/discovery", true).is_err());
        let public = validate_url("https://example.com/source", true).unwrap();
        assert!(validate_redirect(&public, "http://127.0.0.1/private", 0, true).is_err());
        let local = validate_url("http://127.0.0.1/source", true).unwrap();
        assert!(validate_redirect(&local, "http://127.0.0.1/next", 0, true).is_ok());
        assert!(validate_resolved_addresses(
            [
                "127.0.0.1".parse().unwrap(),
                "93.184.216.34".parse().unwrap()
            ],
            true,
        )
        .is_err());
    }
}
