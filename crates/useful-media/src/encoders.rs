//! 硬件编码器检测：解析 `ffmpeg -encoders` 输出，判断 NVENC / QSV / AMF 是否可用。

use crate::ffargs::{HwEncoder, VideoCodec};
use serde::Serialize;

/// 检测到的编码器可用性。
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EncoderSupport {
    pub nvenc: bool,
    pub qsv: bool,
    pub amf: bool,
}

impl EncoderSupport {
    /// 从 `ffmpeg -hide_banner -encoders` 的 stdout 文本解析。
    pub fn parse(encoders_output: &str) -> EncoderSupport {
        let mut s = EncoderSupport::default();
        for line in encoders_output.lines() {
            // 形如 " V....D h264_nvenc  NVIDIA NVENC H.264 encoder"
            let name = line.split_whitespace().nth(1).unwrap_or("");
            if name.ends_with("_nvenc") {
                s.nvenc = true;
            } else if name.ends_with("_qsv") {
                s.qsv = true;
            } else if name.ends_with("_amf") {
                s.amf = true;
            }
        }
        s
    }

    /// 为给定编码族选择最佳可用编码器（优先 NVENC > QSV > AMF > 软件）。
    pub fn best_for(&self, _codec: VideoCodec) -> HwEncoder {
        if self.nvenc {
            HwEncoder::Nvenc
        } else if self.qsv {
            HwEncoder::Qsv
        } else if self.amf {
            HwEncoder::Amf
        } else {
            HwEncoder::Software
        }
    }

    pub fn any_hardware(&self) -> bool {
        self.nvenc || self.qsv || self.amf
    }
}

/// 构建 `ffmpeg -encoders` 参数。
pub fn build_list_encoders_args() -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-encoders".into(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = " V....D h264               libx264 H.264\n V..... h264_nvenc         NVIDIA NVENC H.264 encoder\n V..... hevc_qsv           HEVC (Intel Quick Sync Video)\n A..... aac                AAC";

    #[test]
    fn parses_hw_encoders() {
        let s = EncoderSupport::parse(SAMPLE);
        assert!(s.nvenc);
        assert!(s.qsv);
        assert!(!s.amf);
        assert!(s.any_hardware());
    }

    #[test]
    fn best_prefers_nvenc() {
        let s = EncoderSupport {
            nvenc: true,
            qsv: true,
            amf: true,
        };
        assert_eq!(s.best_for(VideoCodec::H265), HwEncoder::Nvenc);
    }

    #[test]
    fn falls_back_to_software() {
        let s = EncoderSupport::default();
        assert_eq!(s.best_for(VideoCodec::H264), HwEncoder::Software);
        assert!(!s.any_hardware());
    }

    #[test]
    fn amf_only() {
        let s = EncoderSupport {
            nvenc: false,
            qsv: false,
            amf: true,
        };
        assert_eq!(s.best_for(VideoCodec::Av1), HwEncoder::Amf);
    }
}
