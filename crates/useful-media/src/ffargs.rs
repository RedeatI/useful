//! FFmpeg 参数构建。
//!
//! 关键安全约束：所有参数以 `Vec<String>` 数组形式传给子进程，
//! 绝不拼接成 shell 命令，因此文件名中的空格、引号、`&`、中文、
//! Unicode、超长路径都不会造成注入。

use serde::{Deserialize, Serialize};
use std::path::Path;

/// 视频编码器族。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VideoCodec {
    H264,
    H265,
    Av1,
}

/// 硬件编码器类型（检测结果）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HwEncoder {
    Nvenc,
    Qsv,
    Amf,
    /// 无硬件编码器，回退软件
    Software,
}

/// 音频导出格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioFormat {
    /// 原始音轨复制
    Copy,
    Mp3,
    Aac,
    Flac,
    Wav,
}

/// 导出规格。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "mode")]
pub enum ExportSpec {
    /// A. 快速无损裁剪：stream copy，不重新编码
    LosslessCut { start_sec: f64, end_sec: f64 },
    /// B. 精确裁剪：逐帧准确，可用硬件编码
    PreciseCut {
        start_sec: f64,
        end_sec: f64,
        codec: VideoCodec,
        encoder: HwEncoder,
        /// 质量参数（CRF/CQ），越小质量越高
        quality: u8,
    },
    /// C. 音频提取
    AudioExtract {
        start_sec: f64,
        end_sec: f64,
        format: AudioFormat,
    },
}

fn fmt_time(sec: f64) -> String {
    // 使用秒 + 毫秒精度，避免区域小数点问题（始终用 '.'）
    format!("{sec:.3}")
}

/// 构建 ffmpeg 参数数组。`input`/`output` 为路径，原样进入 argv，不做 shell 转义。
pub fn build_ffmpeg_args(input: &Path, output: &Path, spec: &ExportSpec) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-y".into(), // 覆盖由上层决定；此处配合临时输出文件
    ];

    match spec {
        ExportSpec::LosslessCut { start_sec, end_sec } => {
            // -ss 放在 -i 前用于快速定位（受关键帧影响，起点可能对齐到最近关键帧）
            args.push("-ss".into());
            args.push(fmt_time(*start_sec));
            args.push("-i".into());
            args.push(input.to_string_lossy().to_string());
            args.push("-to".into());
            args.push(fmt_time(end_sec - start_sec));
            // 保持原始流信息，纯拷贝，不允许滤镜
            args.push("-c".into());
            args.push("copy".into());
            args.push("-map".into());
            args.push("0".into());
            args.push("-avoid_negative_ts".into());
            args.push("make_zero".into());
        }
        ExportSpec::PreciseCut {
            start_sec,
            end_sec,
            codec,
            encoder,
            quality,
        } => {
            // -ss 放在 -i 后用于逐帧精确定位
            args.push("-i".into());
            args.push(input.to_string_lossy().to_string());
            args.push("-ss".into());
            args.push(fmt_time(*start_sec));
            args.push("-to".into());
            args.push(fmt_time(*end_sec));
            args.push("-c:v".into());
            args.push(video_encoder_name(*codec, *encoder).into());
            // 质量参数按编码器族区分
            push_quality_args(&mut args, *encoder, *quality);
            args.push("-c:a".into());
            args.push("aac".into());
        }
        ExportSpec::AudioExtract {
            start_sec,
            end_sec,
            format,
        } => {
            args.push("-i".into());
            args.push(input.to_string_lossy().to_string());
            args.push("-ss".into());
            args.push(fmt_time(*start_sec));
            args.push("-to".into());
            args.push(fmt_time(*end_sec));
            args.push("-vn".into()); // 去掉视频
            match format {
                AudioFormat::Copy => {
                    args.push("-c:a".into());
                    args.push("copy".into());
                }
                AudioFormat::Mp3 => {
                    args.push("-c:a".into());
                    args.push("libmp3lame".into());
                    args.push("-q:a".into());
                    args.push("2".into());
                }
                AudioFormat::Aac => {
                    args.push("-c:a".into());
                    args.push("aac".into());
                    args.push("-b:a".into());
                    args.push("192k".into());
                }
                AudioFormat::Flac => {
                    args.push("-c:a".into());
                    args.push("flac".into());
                }
                AudioFormat::Wav => {
                    args.push("-c:a".into());
                    args.push("pcm_s16le".into());
                }
            }
        }
    }

    // 进度输出到 stdout，便于解析
    args.push("-progress".into());
    args.push("pipe:1".into());
    args.push(output.to_string_lossy().to_string());
    args
}

fn video_encoder_name(codec: VideoCodec, encoder: HwEncoder) -> &'static str {
    match (codec, encoder) {
        (VideoCodec::H264, HwEncoder::Nvenc) => "h264_nvenc",
        (VideoCodec::H264, HwEncoder::Qsv) => "h264_qsv",
        (VideoCodec::H264, HwEncoder::Amf) => "h264_amf",
        (VideoCodec::H264, HwEncoder::Software) => "libx264",
        (VideoCodec::H265, HwEncoder::Nvenc) => "hevc_nvenc",
        (VideoCodec::H265, HwEncoder::Qsv) => "hevc_qsv",
        (VideoCodec::H265, HwEncoder::Amf) => "hevc_amf",
        (VideoCodec::H265, HwEncoder::Software) => "libx265",
        (VideoCodec::Av1, HwEncoder::Nvenc) => "av1_nvenc",
        (VideoCodec::Av1, HwEncoder::Qsv) => "av1_qsv",
        (VideoCodec::Av1, HwEncoder::Amf) => "av1_amf",
        (VideoCodec::Av1, HwEncoder::Software) => "libsvtav1",
    }
}

fn push_quality_args(args: &mut Vec<String>, encoder: HwEncoder, quality: u8) {
    match encoder {
        HwEncoder::Nvenc => {
            args.push("-cq".into());
            args.push(quality.to_string());
        }
        HwEncoder::Qsv => {
            args.push("-global_quality".into());
            args.push(quality.to_string());
        }
        HwEncoder::Amf => {
            args.push("-qp_i".into());
            args.push(quality.to_string());
        }
        HwEncoder::Software => {
            args.push("-crf".into());
            args.push(quality.to_string());
        }
    }
}

/// 构建 ffprobe 参数：输出 JSON 元数据。
pub fn build_ffprobe_args(input: &Path) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-show_format".into(),
        "-show_streams".into(),
        "-print_format".into(),
        "json".into(),
        input.to_string_lossy().to_string(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lossless_cut_uses_stream_copy_no_filters() {
        let args = build_ffmpeg_args(
            Path::new("input.mp4"),
            Path::new("out.mp4"),
            &ExportSpec::LosslessCut {
                start_sec: 1.5,
                end_sec: 10.0,
            },
        );
        assert!(args.windows(2).any(|w| w == ["-c", "copy"]));
        // 无重编码滤镜
        assert!(!args.iter().any(|a| a == "-vf" || a == "-filter:v"));
        assert!(args.contains(&"-progress".to_string()));
    }

    #[test]
    fn chinese_and_special_paths_are_single_argv_items() {
        // 关键：带空格/&/引号/中文的路径作为单个 argv 项，不被拆分或转义
        let input = Path::new(r#"D:\视频 素材\a & b "quote".mp4"#);
        let output = Path::new(r"E:\导出 目录\结果.mkv");
        let args = build_ffmpeg_args(
            input,
            output,
            &ExportSpec::LosslessCut {
                start_sec: 0.0,
                end_sec: 5.0,
            },
        );
        // 输入路径原样作为一个元素存在
        assert!(args.iter().any(|a| a == &input.to_string_lossy()));
        assert!(args.iter().any(|a| a == &output.to_string_lossy()));
        // 不包含 shell 元字符转义痕迹（我们不做 shell 拼接）
        assert!(args.iter().any(|a| a.contains("a & b")));
    }

    #[test]
    fn precise_cut_selects_hw_encoder() {
        let args = build_ffmpeg_args(
            Path::new("in.mp4"),
            Path::new("out.mp4"),
            &ExportSpec::PreciseCut {
                start_sec: 0.0,
                end_sec: 5.0,
                codec: VideoCodec::H265,
                encoder: HwEncoder::Nvenc,
                quality: 23,
            },
        );
        assert!(args.windows(2).any(|w| w == ["-c:v", "hevc_nvenc"]));
        assert!(args.windows(2).any(|w| w == ["-cq", "23"]));
    }

    #[test]
    fn precise_cut_falls_back_to_software() {
        let args = build_ffmpeg_args(
            Path::new("in.mp4"),
            Path::new("out.mp4"),
            &ExportSpec::PreciseCut {
                start_sec: 0.0,
                end_sec: 5.0,
                codec: VideoCodec::H264,
                encoder: HwEncoder::Software,
                quality: 18,
            },
        );
        assert!(args.windows(2).any(|w| w == ["-c:v", "libx264"]));
        assert!(args.windows(2).any(|w| w == ["-crf", "18"]));
    }

    #[test]
    fn audio_extract_formats() {
        for (fmt, expected) in [
            (AudioFormat::Copy, "copy"),
            (AudioFormat::Mp3, "libmp3lame"),
            (AudioFormat::Aac, "aac"),
            (AudioFormat::Flac, "flac"),
            (AudioFormat::Wav, "pcm_s16le"),
        ] {
            let args = build_ffmpeg_args(
                Path::new("in.mp4"),
                Path::new("out.audio"),
                &ExportSpec::AudioExtract {
                    start_sec: 0.0,
                    end_sec: 5.0,
                    format: fmt,
                },
            );
            assert!(args.contains(&"-vn".to_string()));
            assert!(
                args.iter().any(|a| a == expected),
                "格式 {fmt:?} 应包含编码器 {expected}"
            );
        }
    }

    #[test]
    fn ffprobe_args_request_json() {
        let args = build_ffprobe_args(Path::new("中文.mp4"));
        assert!(args.windows(2).any(|w| w == ["-print_format", "json"]));
        assert!(args.contains(&"-show_streams".to_string()));
    }
}
