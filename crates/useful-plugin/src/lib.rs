//! 插件系统：.useful 包解析、manifest 双重校验、安全解压、原子安装与回滚、源签名验证。

pub mod download;
pub mod error;
pub mod install;
pub mod manifest;
pub mod permissions;
pub mod signing;
pub mod source;
pub mod zip_safety;

pub use error::PluginError;
pub use manifest::PluginManifest;
