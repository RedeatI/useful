//! 诊断包导出：预览将包含的文件清单，确认后打包为 zip。
//!
//! 不包含用户文件内容与访问令牌；默认不上传，仅写用户指定路径。

use super::{CmdError, CmdResult};
use crate::state::{AppState, HOST_VERSION};
use serde::Serialize;
use std::io::Write;
use tauri::State;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagEntry {
    pub name: String,
    pub size_bytes: u64,
    pub kind: String, // log | summary
}

fn beta_feedback_template() -> &'static str {
    "# Useful Beta 反馈\n\n\
     - 反馈类型：缺陷 / 体验 / 插件兼容 / 其他\n\
     - 一句话摘要：\n\
     - 期望行为：\n\
     - 实际行为：\n\
     - 可重复步骤：\n\
     - 是否影响数据：否 / 是（请说明，不要附带敏感数据）\n\n\
     提交前请检查诊断包内容；不要加入密码、JWT、Token、私钥或用户文件内容。\n"
}

/// 生成诊断摘要文本（不含敏感信息）。
fn summary_text(state: &AppState) -> String {
    let p = &state.paths;
    let schema_version = state
        .db
        .lock()
        .ok()
        .and_then(|db| db.schema_version().ok())
        .unwrap_or(-1);
    let tool_count = state.registry.lock().map(|r| r.list().len()).unwrap_or(0);
    // 官方信任根状态：占位期官方徽章能力被禁用（Owner Gate OG-1）。显著呈现，便于
    // 运维/支持辨识“为何没有任何源显示官方”。
    let official_root = if useful_repository_client::trust::official_root_is_placeholder() {
        "占位（官方徽章已禁用，待 Owner Gate OG-1 配置真实根）"
    } else {
        "已配置"
    };
    format!(
        "Useful 诊断摘要\n\
         版本: {HOST_VERSION}\n\
         运行模式: {:?}\n\
         数据目录: {}\n\
         数据库 schema 版本: {schema_version}\n\
         注册工具数: {tool_count}\n\
         官方信任根: {official_root}\n\
         OS: Windows\n\
         生成时间(unix): {}\n",
        p.mode,
        p.data_dir.display(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    )
}

/// 收集日志文件（按文件名排序，最多 14 个，防止包过大）。
fn log_files(state: &AppState) -> Vec<std::path::PathBuf> {
    let mut files: Vec<_> = std::fs::read_dir(&state.paths.logs_dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    p.is_file()
                        && p.file_name()
                            .and_then(|n| n.to_str())
                            .map(|n| n.starts_with("useful.log"))
                            .unwrap_or(false)
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files.reverse(); // 最新在前
    files.truncate(14);
    files
}

/// 预览诊断包将包含的内容（供用户确认）。
#[tauri::command]
pub fn diagnostics_preview(state: State<AppState>) -> CmdResult<Vec<DiagEntry>> {
    let mut entries = vec![DiagEntry {
        name: "diagnostics.txt".into(),
        size_bytes: summary_text(&state).len() as u64,
        kind: "summary".into(),
    }];
    entries.push(DiagEntry {
        name: "beta-feedback-template.md".into(),
        size_bytes: beta_feedback_template().len() as u64,
        kind: "feedback".into(),
    });
    for f in log_files(&state) {
        let size = std::fs::metadata(&f).map(|m| m.len()).unwrap_or(0);
        entries.push(DiagEntry {
            name: f
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            size_bytes: size,
            kind: "log".into(),
        });
    }
    Ok(entries)
}

/// 导出诊断包 zip 到用户指定路径。
#[tauri::command]
pub fn diagnostics_export(state: State<AppState>, dest_path: String) -> CmdResult<String> {
    let dest = std::path::PathBuf::from(&dest_path);
    if let Some(parent) = dest.parent() {
        if !parent.exists() {
            return Err(CmdError::from("目标目录不存在"));
        }
    }
    let file = std::fs::File::create(&dest).map_err(|e| CmdError::from(e.to_string()))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("diagnostics.txt", opts)
        .map_err(|e| CmdError::from(e.to_string()))?;
    zip.write_all(summary_text(&state).as_bytes())
        .map_err(|e| CmdError::from(e.to_string()))?;

    zip.start_file("beta-feedback-template.md", opts)
        .map_err(|e| CmdError::from(e.to_string()))?;
    zip.write_all(beta_feedback_template().as_bytes())
        .map_err(|e| CmdError::from(e.to_string()))?;

    for f in log_files(&state) {
        let name = f
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let bytes = match std::fs::read(&f) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!("读取日志失败 {}: {e}", f.display());
                continue;
            }
        };
        zip.start_file(format!("logs/{name}"), opts)
            .map_err(|e| CmdError::from(e.to_string()))?;
        zip.write_all(&bytes)
            .map_err(|e| CmdError::from(e.to_string()))?;
    }
    zip.finish().map_err(|e| CmdError::from(e.to_string()))?;
    Ok(dest_path)
}

#[cfg(test)]
mod tests {
    use super::beta_feedback_template;

    #[test]
    fn beta_feedback_template_is_actionable_and_warns_about_secrets() {
        let template = beta_feedback_template();
        assert!(template.contains("期望行为"));
        assert!(template.contains("可重复步骤"));
        assert!(template.contains("不要加入密码、JWT、Token、私钥"));
    }
}
