//! Useful 应用库入口：装配路径、数据库、注册表、单实例、命令与 CLI 处理。

pub mod commands;
pub mod logging;
#[cfg(feature = "native-test")]
mod native_test;
pub mod platform;
pub mod state;

use state::{AppState, CliArgs};
use std::sync::Mutex;
use tauri::{Emitter, Listener, Manager};
use useful_core::db::Database;
use useful_core::paths::{AppPaths, RunMode};
use useful_core::registry::{builtin_tools, ToolCategory, ToolDefinition, ToolKind, ToolRegistry};
use useful_plugin::manifest::{EntryType, PluginManifest};

/// 从数据库缓存的 manifest 载入已安装插件到注册表（启动时只读缓存，不执行插件代码）。
fn load_installed_plugins(db: &Database, registry: &mut ToolRegistry) {
    let mut stmt = match db.conn.prepare(
        "SELECT t.id, tv.manifest_json, tv.install_dir
         FROM tools t
         JOIN tool_versions tv ON tv.tool_id = t.id AND tv.version = t.current_version
         WHERE t.enabled = 1",
    ) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("准备插件查询失败: {e}");
            return;
        }
    };
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
        ))
    });
    let rows = match rows {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("查询插件失败: {e}");
            return;
        }
    };
    for row in rows.flatten() {
        let (id, manifest_json, install_dir) = row;
        match serde_json::from_str::<PluginManifest>(&manifest_json) {
            Ok(m) => {
                let tool = manifest_to_tool(&m, install_dir.as_deref().unwrap_or(""));
                if let Err(e) = registry.register(tool) {
                    tracing::warn!("插件 {id} 注册失败: {e}");
                }
            }
            Err(e) => tracing::warn!("插件 {id} manifest 解析失败: {e}"),
        }
    }
}

/// manifest -> ToolDefinition（与 commands::plugins 保持一致）。
fn manifest_to_tool(m: &PluginManifest, install_dir: &str) -> ToolDefinition {
    let kind = match m.entry.entry_type {
        EntryType::Web => ToolKind::Web,
        EntryType::Launcher => ToolKind::Launcher,
        EntryType::Worker => ToolKind::Worker,
    };
    let order = m
        .contributes
        .sidebar
        .first()
        .map(|s| s.order)
        .unwrap_or(100);
    ToolDefinition {
        id: m.id.clone(),
        name: m.name.clone(),
        description: m.description.clone(),
        icon: m
            .icon
            .clone()
            .map(|i| format!("{install_dir}/{i}"))
            .unwrap_or_else(|| "plugin".into()),
        route: format!("/plugin/{}", m.id),
        category: ToolCategory::Installed,
        kind,
        order,
        supports_shortcut: true,
        required_capabilities: m.permissions.clone(),
        version: Some(m.version.clone()),
    }
}

fn startup_fatal(message: &str) -> ! {
    #[cfg(windows)]
    unsafe {
        use windows::core::HSTRING;
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let message = HSTRING::from(message);
        let title = HSTRING::from("Useful");
        let _ = MessageBoxW(None, &message, &title, MB_OK | MB_ICONERROR);
    }
    #[cfg(not(windows))]
    eprintln!("{message}");
    std::process::exit(1)
}

/// 应用入口。
pub fn run() {
    // 1) 解析路径（便携探测）
    let exe = std::env::current_exe()
        .unwrap_or_else(|_| startup_fatal("Useful 无法解析程序所在目录，启动已安全停止。"));
    let paths = AppPaths::detect(&exe, None)
        .unwrap_or_else(|_| startup_fatal("Useful 无法解析数据目录，启动已安全停止。"));
    paths.ensure_dirs().unwrap_or_else(|_| {
        let message = match paths.mode {
            RunMode::Portable => {
                "Useful Portable 所在目录不可写。请将完整程序解压到可写目录后重试；Useful 不会改用 AppData。"
            }
            RunMode::Installed => "Useful 数据目录不可写，启动已安全停止。请检查目录权限后重试。",
        };
        startup_fatal(message)
    });

    // 2) 日志（guard 存活于整个进程）
    let _log_guard = logging::init(&paths.logs_dir);
    tracing::info!(
        "启动 Useful，运行模式: {:?}，数据目录: {}",
        paths.mode,
        paths.data_dir.display()
    );

    // 3) 数据库 + 迁移
    let db = Database::open(&paths.db_path)
        .unwrap_or_else(|_| startup_fatal("Useful 无法安全打开本地数据库，启动已停止。"));
    if db.recovered {
        tracing::warn!("检测到数据库损坏，已备份并重建");
    }

    // 4) 注册表：内置工具 + 已安装插件
    // Core edition omits process-monitor / video-trim so the GUI never offers unlinked tools.
    let mut registry = ToolRegistry::new();
    for t in builtin_tools() {
        if t.id == "builtin.process-monitor" && !cfg!(feature = "procmon") {
            continue;
        }
        if t.id == "builtin.video-trim" && !cfg!(feature = "media") {
            continue;
        }
        registry.register(t).expect("内置工具注册失败");
    }
    load_installed_plugins(&db, &mut registry);

    let app_state = AppState::new(paths, db, registry);

    // 5) 启动 CLI 参数（首个实例）
    let startup_cli = CliArgs::parse(std::env::args().skip(1));

    tauri::Builder::default()
        .register_uri_scheme_protocol("usefulplugin", commands::plugins::plugin_protocol_response)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 单实例：第二个实例把参数发给第一个实例
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let cli = CliArgs::parse(argv.into_iter().skip(1));
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            // 优先处理 --open-action（action 级直达）
            if let Some(action_id) = &cli.open_action {
                let _ = app.emit(
                    "open-tool",
                    serde_json::json!({
                        "toolId": "builtin.utilities",
                        "actionId": action_id,
                        "file": cli.file.as_ref().map(|f| f.to_string_lossy().to_string())
                    }),
                );
            } else if let Some(tool_id) = cli.open_tool {
                let _ = app.emit(
                    "open-tool",
                    serde_json::json!({
                        "toolId": tool_id,
                        "file": cli.file.map(|f| f.to_string_lossy().to_string())
                    }),
                );
            }
        }))
        .manage(app_state)
        .manage(Mutex::new(startup_cli.clone()))
        .setup(move |app| {
            // Apply the saved chrome theme before the frontend hydrates so light mode
            // does not flash a dark Windows title bar.
            if let Some(window) = app.get_webview_window("main") {
                let state = app.state::<AppState>();
                match commands::app::read_settings(&state) {
                    Ok(settings) => commands::app::apply_window_theme(&window, &settings.theme),
                    Err(error) => tracing::warn!("读取启动主题失败: {}", error.message),
                }
            }
            #[cfg(feature = "native-test")]
            let plugin_bootstrap_failures: Vec<String> = {
                let state = app.state::<AppState>();
                startup_cli
                    .plugin_packages
                    .iter()
                    .filter_map(|package| {
                        let options = useful_plugin::install::InstallOptions {
                            host_version: state::HOST_VERSION.to_string(),
                            ..Default::default()
                        };
                        match useful_plugin::install::install_useful(
                            package,
                            &state.paths.staging_dir,
                            &state.paths.plugins_dir,
                            &options,
                        ) {
                            Ok(outcome) => commands::plugins::persist_installed(&state, outcome, None)
                                .err()
                                .map(|error| format!("{}: {}", package.display(), error.message)),
                            Err(error) => Some(format!("{}: {error}", package.display())),
                        }
                    })
                    .collect()
            };
            // 前端显式报告监听器已挂载后再发送首启参数，避免固定延迟竞态。
            let ready_handle = app.handle().clone();
            let ready_cli = startup_cli.clone();
            app.once("frontend-ready", move |_| {
                #[cfg(feature = "native-test")]
                if std::env::var_os("USEFUL_NATIVE_ACTION_RECEIPTS").is_some() {
                    let _ = ready_handle.emit("native-action-receipts-enabled", ());
                }
                let file = ready_cli.file.clone();
                if let Some(action_id) = &ready_cli.open_action {
                    let _ = ready_handle.emit(
                        "open-tool",
                        serde_json::json!({
                            "toolId": "builtin.utilities",
                            "actionId": action_id,
                            "file": file.map(|f| f.to_string_lossy().to_string())
                        }),
                    );
                } else if let Some(tool_id) = &ready_cli.open_tool {
                    let _ = ready_handle.emit(
                        "open-tool",
                        serde_json::json!({
                            "toolId": tool_id,
                            "file": file.map(|f| f.to_string_lossy().to_string())
                        }),
                    );
                }

                #[cfg(feature = "native-test")]
                if ready_cli.native_smoke_dir.is_some() {
                    let clipboard_result = native_test::clipboard_roundtrip(&format!(
                        "useful-native-smoke-{}",
                        ready_cli
                            .native_smoke_commit
                            .as_deref()
                            .unwrap_or("unknown")
                            .chars()
                            .take(12)
                            .collect::<String>()
                    ));
                    let _ = ready_handle.emit(
                        "native-smoke-start",
                        serde_json::json!({
                            "commit": ready_cli.native_smoke_commit.as_deref().unwrap_or("unknown"),
                            "version": state::HOST_VERSION,
                            "clipboardPassed": clipboard_result.is_ok(),
                            "clipboardError": clipboard_result.err(),
                            "mediaInput": ready_cli.file.as_ref().map(|path| path.to_string_lossy().to_string())
                        }),
                    );
                }
                #[cfg(feature = "native-test")]
                if ready_cli.native_plugin_smoke_dir.is_some() {
                    let plugins = ready_handle
                        .state::<AppState>()
                        .registry
                        .lock()
                        .ok()
                        .map(|registry| {
                            registry
                                .list()
                                .into_iter()
                                .filter(|tool| tool.category == ToolCategory::Installed)
                                .map(|tool| {
                                    serde_json::json!({
                                        "id": tool.id,
                                        "name": tool.name,
                                        "route": tool.route,
                                        "version": tool.version
                                    })
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let _ = ready_handle.emit(
                        "native-plugin-smoke-start",
                        serde_json::json!({
                            "commit": ready_cli.native_smoke_commit.as_deref().unwrap_or("unknown"),
                            "version": state::HOST_VERSION,
                            "plugins": plugins,
                            "bootstrapFailures": plugin_bootstrap_failures
                        }),
                    );
                }
            });

            #[cfg(feature = "native-test")]
            if let Some(artifact_dir) = startup_cli.native_smoke_dir.clone() {
                let checkpoint_dir = artifact_dir.clone();
                app.listen("native-smoke-checkpoint", move |event| {
                    let write_result = std::fs::create_dir_all(&checkpoint_dir).and_then(|_| {
                        use std::io::Write;
                        let mut file = std::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(checkpoint_dir.join("progress.jsonl"))?;
                        writeln!(file, "{}", event.payload())
                    });
                    if let Err(error) = write_result {
                        tracing::error!("写入 native smoke 进度失败: {error}");
                    }
                });
                let result_handle = app.handle().clone();
                app.listen("native-smoke-result", move |event| {
                    let exit_code = match serde_json::from_str::<serde_json::Value>(event.payload()) {
                        Ok(result) => {
                            let write_result = std::fs::create_dir_all(&artifact_dir).and_then(|_| {
                                let bytes = serde_json::to_vec_pretty(&result)
                                    .map_err(std::io::Error::other)?;
                                std::fs::write(artifact_dir.join("result.json"), bytes)
                            });
                            if let Err(error) = write_result {
                                tracing::error!("写入 native smoke 结果失败: {error}");
                                1
                            } else if result
                                .get("failed")
                                .and_then(serde_json::Value::as_u64)
                                .unwrap_or(1)
                                == 0
                            {
                                0
                            } else {
                                1
                            }
                        }
                        Err(error) => {
                            tracing::error!("解析 native smoke 结果失败: {error}");
                            1
                        }
                    };
                    result_handle.exit(exit_code);
                });
            }
            #[cfg(feature = "native-test")]
            if let Some(artifact_dir) = startup_cli.native_plugin_smoke_dir.clone() {
                let result_handle = app.handle().clone();
                app.listen("native-plugin-smoke-result", move |event| {
                    let exit_code = match serde_json::from_str::<serde_json::Value>(event.payload()) {
                        Ok(result) => {
                            let write_result = std::fs::create_dir_all(&artifact_dir).and_then(|_| {
                                let bytes = serde_json::to_vec_pretty(&result)
                                    .map_err(std::io::Error::other)?;
                                std::fs::write(artifact_dir.join("result.json"), bytes)
                            });
                            if write_result.is_ok()
                                && result
                                    .get("failed")
                                    .and_then(serde_json::Value::as_u64)
                                    .unwrap_or(1)
                                    == 0
                            {
                                0
                            } else {
                                1
                            }
                        }
                        Err(_) => 1,
                    };
                    result_handle.exit(exit_code);
                });
            }
            #[cfg(feature = "native-test")]
            if let Some(receipt_path) = std::env::var_os("USEFUL_NATIVE_ACTION_RECEIPTS") {
                let receipt_path = std::path::PathBuf::from(receipt_path);
                app.listen("native-action-opened", move |event| {
                    let write_result = receipt_path
                        .parent()
                        .map(std::fs::create_dir_all)
                        .transpose()
                        .and_then(|_| {
                            use std::io::Write;
                            let mut file = std::fs::OpenOptions::new()
                                .create(true)
                                .append(true)
                                .open(&receipt_path)?;
                            writeln!(file, "{}", event.payload())
                        });
                    if let Err(error) = write_result {
                        tracing::error!("写入 native action receipt 失败: {error}");
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::get_app_info,
            commands::app::list_tools,
            commands::app::get_settings,
            commands::app::update_setting,
            commands::app::get_favorites,
            commands::app::toggle_favorite,
            commands::app::get_recent_tools,
            commands::app::record_tool_use,
            commands::app::open_tool,
            commands::app::open_path,
            commands::elevation::elevation_status,
            commands::elevation::restart_elevated,
            commands::app::get_action_favorites,
            commands::app::toggle_action_favorite,
            commands::app::get_action_recent,
            commands::app::record_action_use,
            commands::app::clear_action_recent,
            commands::agent_profile::agent_profile_get,
            commands::agent_profile::agent_profile_save,
            commands::agent_profile::agent_profile_export,
            commands::agent_profile::agent_profile_open_directory,
            commands::agent_profile::navigation_pins_get,
            commands::agent_profile::navigation_pin_set,
            commands::shortcuts::create_shortcut,
            commands::shortcuts::create_action_shortcut,
            commands::shortcuts::list_shortcuts,
            commands::shortcuts::delete_shortcut,
            commands::shortcuts::repair_all_shortcuts,
            commands::plugins::install_local_plugin,
            commands::plugins::list_plugins,
            commands::plugins::uninstall_plugin,
            commands::plugins::get_plugin_permissions,
            commands::plugins::import_launcher,
            commands::plugins::plugin_bridge_call,
            commands::plugins::tool_set_pinned,
            commands::plugins::tool_versions,
            commands::plugins::tool_rollback,
            commands::sources::source_add,
            commands::sources::source_refresh,
            commands::sources::source_list,
            commands::sources::source_set_enabled,
            commands::sources::source_remove,
            commands::sources::source_fingerprint,
            commands::sources::shop_catalog,
            commands::sources::permission_diff,
            commands::trp_sources::trp_source_preview,
            commands::trp_sources::trp_source_add,
            commands::trp_sources::trp_source_list,
            commands::trp_sources::trp_source_set_enabled,
            commands::trp_sources::trp_source_set_priority,
            commands::trp_sources::trp_source_remove,
            commands::trp_sources::trp_source_sync,
            commands::trp_sources::trp_source_sync_all,
            commands::trp_sources::trp_catalog_search,
            commands::trp_sources::trp_install,
            commands::trp_sources::trp_rollback,
            commands::trp_sources::trp_check_update,
            commands::accounts::source_login,
            commands::accounts::source_account_get,
            commands::accounts::source_logout,
            commands::app_update::app_update_source_get,
            commands::app_update::app_update_source_set_custom,
            commands::app_update::app_update_source_reset_official,
            commands::app_update::app_update_channel_set,
            commands::downloads::download_and_install,
            commands::downloads::download_cancel,
            commands::downloads::downloads_list,
            commands::downloads::downloads_clear_finished,
            commands::diagnostics::diagnostics_preview,
            commands::diagnostics::diagnostics_export,
            commands::procmon::procmon_start,
            commands::procmon::procmon_stop,
            commands::procmon::procmon_set_paused,
            commands::procmon::procmon_stats,
            commands::procmon::procmon_open_folder,
            commands::procmon::kill_process,
            commands::procmon::kill_process_tree,
            commands::media::media_sidecars,
            commands::media::media_probe,
            commands::media::media_detect_encoders,
            commands::media::media_thumbnail,
            commands::media::media_export,
            commands::media::media_cancel_export,
            commands::media_pack::media_pack_catalog,
            commands::media_pack::media_pack_install,
            commands::media_pack::media_pack_cancel,
            commands::media_pack::media_pack_rollback,
            commands::media::mpv_start,
            commands::media::mpv_set_rect,
            commands::media::mpv_load,
            commands::media::mpv_set_paused,
            commands::media::mpv_seek,
            commands::media::mpv_stop,
        ])
        .run(tauri::generate_context!())
        .expect("运行 Tauri 应用失败");
}
