//! Useful 核心库：便携路径解析、原子写入、SQLite 迁移、工具注册表。

pub mod atomic_io;
pub mod db;
pub mod error;
pub mod paths;
pub mod registry;

pub use error::CoreError;
