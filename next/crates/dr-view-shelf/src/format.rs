//! Times as the shelf writes them (counts are `dr_i18n::number`).

/// How long ago `at_ms` was, in the notification center's words (刚刚,
/// 3 分钟前, 2 小时前, 5 天前).
pub fn ago(at_ms: i64, now_ms: i64, cx: &gpui::App) -> gpui::SharedString {
    let at = std::time::UNIX_EPOCH + std::time::Duration::from_millis(at_ms.max(0) as u64);
    let now = std::time::UNIX_EPOCH + std::time::Duration::from_millis(now_ms.max(0) as u64);
    dr_shell::notifications::ago(at, now, cx)
}

/// Milliseconds since the Unix epoch, now.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
