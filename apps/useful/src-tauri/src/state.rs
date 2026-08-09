//! 应用共享状态：路径、数据库连接、工具注册表、CLI 参数。

use std::path::PathBuf;
use std::sync::Mutex;
use useful_core::db::Database;
use useful_core::paths::AppPaths;
use useful_core::registry::ToolRegistry;

/// 宿主版本（用于插件兼容性检查）。
pub const HOST_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 全局应用状态，注入 Tauri managed state。
pub struct AppState {
    pub paths: AppPaths,
    pub db: Mutex<Database>,
    pub registry: Mutex<ToolRegistry>,
    /// 进程监视器采样器（懒启动）；Core edition 使用空状态。
    pub procmon: Mutex<crate::commands::procmon::ProcmonState>,
    /// 媒体状态（sidecar 解析、导出任务、缩略图缓存、mpv）；Core edition 为空占位。
    pub media: crate::commands::media::MediaState,
    /// 下载任务取消标志
    pub downloads: crate::commands::downloads::DownloadsState,
    /// 插件仅可访问由原生对话框授予的路径。
    pub plugin_bridge: crate::commands::plugins::PluginBridgeState,
}

impl AppState {
    pub fn new(paths: AppPaths, db: Database, registry: ToolRegistry) -> Self {
        let media_root = paths.data_dir.join("runtimes").join("media");
        let media =
            crate::commands::media::MediaState::new(&paths.exe_dir, &paths.cache_dir, &media_root);
        Self {
            paths,
            db: Mutex::new(db),
            registry: Mutex::new(registry),
            #[cfg(feature = "procmon")]
            procmon: Mutex::new(crate::commands::procmon::ProcmonState::default()),
            #[cfg(not(feature = "procmon"))]
            procmon: Mutex::new(crate::commands::procmon::ProcmonState),
            media,
            downloads: crate::commands::downloads::DownloadsState::default(),
            plugin_bridge: crate::commands::plugins::PluginBridgeState::default(),
        }
    }
}

/// 解析后的命令行参数。
#[derive(Debug, Default, Clone)]
pub struct CliArgs {
    /// --open-tool <id>
    pub open_tool: Option<String>,
    /// --open-action <actionId>（如 builtin.utilities.base64）
    pub open_action: Option<String>,
    /// --file <path>
    pub file: Option<PathBuf>,
    /// --native-smoke <artifact-dir>（仅 native-test feature）
    #[cfg(feature = "native-test")]
    pub native_smoke_dir: Option<PathBuf>,
    /// --native-smoke-commit <git-sha>（仅用于证据标记）
    #[cfg(feature = "native-test")]
    pub native_smoke_commit: Option<String>,
    /// --native-plugin-smoke <artifact-dir>（仅 native-test feature）
    #[cfg(feature = "native-test")]
    pub native_plugin_smoke_dir: Option<PathBuf>,
    /// --plugin-package <path> 可重复指定。
    #[cfg(feature = "native-test")]
    pub plugin_packages: Vec<PathBuf>,
}

impl CliArgs {
    /// 从参数向量解析（跳过 argv[0]）。
    pub fn parse<I: IntoIterator<Item = String>>(args: I) -> CliArgs {
        let mut result = CliArgs::default();
        let mut iter = args.into_iter().peekable();
        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "--open-tool" => {
                    if let Some(v) = iter.next() {
                        result.open_tool = Some(v);
                    }
                }
                "--open-action" => {
                    if let Some(v) = iter.next() {
                        result.open_action = Some(v);
                    }
                }
                "--file" => {
                    if let Some(v) = iter.next() {
                        result.file = Some(PathBuf::from(v));
                    }
                }
                #[cfg(feature = "native-test")]
                "--native-smoke" => {
                    if let Some(v) = iter.next() {
                        result.native_smoke_dir = Some(PathBuf::from(v));
                    }
                }
                #[cfg(feature = "native-test")]
                "--native-smoke-commit" => {
                    if let Some(v) = iter.next() {
                        result.native_smoke_commit = Some(v);
                    }
                }
                #[cfg(feature = "native-test")]
                "--native-plugin-smoke" => {
                    if let Some(v) = iter.next() {
                        result.native_plugin_smoke_dir = Some(PathBuf::from(v));
                    }
                }
                #[cfg(feature = "native-test")]
                "--plugin-package" => {
                    if let Some(v) = iter.next() {
                        result.plugin_packages.push(PathBuf::from(v));
                    }
                }
                other => {
                    // 支持 --open-tool=<id> / --open-action=<id> 形式
                    if let Some(v) = other.strip_prefix("--open-tool=") {
                        result.open_tool = Some(v.to_string());
                    } else if let Some(v) = other.strip_prefix("--open-action=") {
                        result.open_action = Some(v.to_string());
                    } else if let Some(v) = other.strip_prefix("--file=") {
                        result.file = Some(PathBuf::from(v));
                    }
                }
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_open_tool_and_file() {
        let args = vec![
            "Useful.exe".to_string(),
            "--open-tool".to_string(),
            "builtin.video-trim".to_string(),
            "--file".to_string(),
            r"C:\videos\中文 视频.mp4".to_string(),
        ];
        // 跳过 argv[0]
        let cli = CliArgs::parse(args.into_iter().skip(1));
        assert_eq!(cli.open_tool.as_deref(), Some("builtin.video-trim"));
        assert_eq!(
            cli.file.unwrap().to_string_lossy(),
            r"C:\videos\中文 视频.mp4"
        );
    }

    #[test]
    fn parses_equals_form() {
        let cli = CliArgs::parse(vec!["--open-tool=builtin.process-monitor".to_string()]);
        assert_eq!(cli.open_tool.as_deref(), Some("builtin.process-monitor"));
    }

    #[test]
    fn parses_open_action() {
        let args = vec![
            "Useful.exe".to_string(),
            "--open-action".to_string(),
            "builtin.utilities.base64".to_string(),
        ];
        let cli = CliArgs::parse(args.into_iter().skip(1));
        assert_eq!(cli.open_action.as_deref(), Some("builtin.utilities.base64"));
        assert!(cli.open_tool.is_none());
    }

    #[test]
    fn parses_open_action_equals_form() {
        let cli = CliArgs::parse(vec!["--open-action=builtin.utilities.uuid".to_string()]);
        assert_eq!(cli.open_action.as_deref(), Some("builtin.utilities.uuid"));
    }

    #[test]
    fn open_action_and_tool_together() {
        let cli = CliArgs::parse(vec![
            "--open-action".to_string(),
            "builtin.utilities.json".to_string(),
            "--file".to_string(),
            "C:\\data.json".to_string(),
        ]);
        assert_eq!(cli.open_action.as_deref(), Some("builtin.utilities.json"));
        assert_eq!(cli.file.unwrap().to_string_lossy(), r"C:\data.json");
    }

    #[test]
    fn empty_when_no_args() {
        let cli = CliArgs::parse(Vec::<String>::new());
        assert!(cli.open_tool.is_none());
        assert!(cli.open_action.is_none());
        assert!(cli.file.is_none());
    }
}
