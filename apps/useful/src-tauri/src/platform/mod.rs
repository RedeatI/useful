//! 平台相关实现（Windows 专有）。

#[cfg(all(windows, feature = "procmon"))]
pub mod prockill;

#[cfg(all(windows, feature = "media"))]
pub mod mpv;
