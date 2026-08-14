//! 媒体处理：ffmpeg/ffprobe 参数构建（参数数组，绝不拼接 shell）、进度解析、
//! sidecar 解析、硬件编码器检测、缩略图缓存键、异步 ffprobe/ffmpeg 编排、mpv IPC。

pub mod compat;
pub mod encoders;
pub mod export;
pub mod ffargs;
pub mod ffprobe;
pub mod limits;
pub mod mpv;
pub mod pack;
pub mod progress;
pub mod sidecar;
pub mod thumbnail;
pub mod upstream;

pub use ffargs::{AudioFormat, ExportSpec, HwEncoder, VideoCodec};
pub use ffprobe::MediaInfo;
pub use progress::ProgressUpdate;
pub use sidecar::{SidecarSet, Sidecars};
