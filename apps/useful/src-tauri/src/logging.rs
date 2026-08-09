//! 日志与诊断：tracing，按日期轮转，写入 data/logs，不记录文件内容与令牌。

use std::path::Path;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

/// 初始化日志。返回的 guard 必须在应用生命周期内保持存活。
pub fn init(logs_dir: &Path) -> Option<WorkerGuard> {
    let _ = std::fs::create_dir_all(logs_dir);

    // 按天轮转
    let file_appender = tracing_appender::rolling::daily(logs_dir, "useful.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    let filter = EnvFilter::try_from_env("USEFUL_LOG")
        .unwrap_or_else(|_| EnvFilter::new("info,useful=debug"));

    let file_layer = tracing_subscriber::fmt::layer()
        .with_writer(non_blocking)
        .with_ansi(false)
        .with_target(true);

    let stderr_layer = tracing_subscriber::fmt::layer()
        .with_writer(std::io::stderr)
        .with_ansi(true);

    let result = tracing_subscriber::registry()
        .with(filter)
        .with(file_layer)
        .with(stderr_layer)
        .try_init();

    if result.is_err() {
        // 已初始化过（如测试）时忽略
        return None;
    }
    tracing::info!("日志系统已初始化，目录: {}", logs_dir.display());
    Some(guard)
}
