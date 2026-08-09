//! ffprobe JSON 元数据解析。

use serde::{Deserialize, Serialize};

/// 解析后的媒体元数据摘要。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub duration_sec: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub bit_rate: Option<u64>,
    pub audio_tracks: u32,
    /// ffprobe 报告的容器/解复用器名称（可能包含逗号分隔的别名）。
    pub format_name: Option<String>,
}

#[derive(Deserialize)]
struct Raw {
    #[serde(default)]
    streams: Vec<RawStream>,
    #[serde(default)]
    format: RawFormat,
}

#[derive(Deserialize)]
struct RawStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    #[serde(default)]
    width: Option<u32>,
    #[serde(default)]
    height: Option<u32>,
    #[serde(default)]
    r_frame_rate: Option<String>,
    #[serde(default)]
    duration: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawFormat {
    #[serde(default)]
    format_name: Option<String>,
    #[serde(default)]
    duration: Option<String>,
    #[serde(default)]
    bit_rate: Option<String>,
}

fn parse_fps(r: &str) -> f64 {
    // r_frame_rate 形如 "30000/1001"
    if let Some((num, den)) = r.split_once('/') {
        let n: f64 = num.parse().unwrap_or(0.0);
        let d: f64 = den.parse().unwrap_or(1.0);
        if d != 0.0 {
            return n / d;
        }
    }
    r.parse().unwrap_or(0.0)
}

impl MediaInfo {
    /// 从 ffprobe -print_format json 的输出解析。
    pub fn from_ffprobe_json(json: &[u8]) -> Result<MediaInfo, serde_json::Error> {
        let raw: Raw = serde_json::from_slice(json)?;
        let mut info = MediaInfo {
            duration_sec: raw
                .format
                .duration
                .as_deref()
                .and_then(|d| d.parse().ok())
                .unwrap_or(0.0),
            bit_rate: raw.format.bit_rate.as_deref().and_then(|b| b.parse().ok()),
            format_name: raw.format.format_name,
            ..Default::default()
        };

        let mut stream_duration = 0.0f64;
        for s in &raw.streams {
            if let Some(duration) = s
                .duration
                .as_deref()
                .and_then(|value| value.parse::<f64>().ok())
            {
                if duration.is_finite() && duration > stream_duration {
                    stream_duration = duration;
                }
            }
            match s.codec_type.as_deref() {
                Some("video") => {
                    if info.video_codec.is_none() {
                        info.video_codec = s.codec_name.clone();
                        info.width = s.width.unwrap_or(0);
                        info.height = s.height.unwrap_or(0);
                        if let Some(r) = &s.r_frame_rate {
                            info.fps = parse_fps(r);
                        }
                    }
                }
                Some("audio") => {
                    info.audio_tracks += 1;
                    if info.audio_codec.is_none() {
                        info.audio_codec = s.codec_name.clone();
                    }
                }
                _ => {}
            }
        }
        if (!info.duration_sec.is_finite() || info.duration_sec <= 0.0) && stream_duration > 0.0 {
            info.duration_sec = stream_duration;
        }
        Ok(info)
    }

    /// 视频裁剪至少需要一个可识别的视频流和有限的正时长。
    pub fn validate_for_trim(&self) -> Result<(), &'static str> {
        if self.video_codec.as_deref().unwrap_or_default().is_empty() {
            return Err("未识别到视频流");
        }
        if !self.duration_sec.is_finite() || self.duration_sec <= 0.0 {
            return Err("媒体时长不可识别或为零");
        }
        if self.width == 0 || self.height == 0 {
            return Err("视频尺寸不可识别");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_typical_ffprobe_output() {
        let json = br#"{
            "streams": [
                {"codec_type":"video","codec_name":"h264","width":3840,"height":2160,"r_frame_rate":"30000/1001"},
                {"codec_type":"audio","codec_name":"aac"},
                {"codec_type":"audio","codec_name":"ac3"}
            ],
            "format": {"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"7200.5","bit_rate":"120000000"}
        }"#;
        let info = MediaInfo::from_ffprobe_json(json).unwrap();
        assert_eq!(info.width, 3840);
        assert_eq!(info.height, 2160);
        assert!((info.fps - 29.97).abs() < 0.01);
        assert_eq!(info.video_codec.as_deref(), Some("h264"));
        assert_eq!(info.audio_tracks, 2);
        assert_eq!(info.duration_sec as u64, 7200);
        assert_eq!(info.bit_rate, Some(120_000_000));
        assert_eq!(info.format_name.as_deref(), Some("mov,mp4,m4a,3gp,3g2,mj2"));
        assert!(info.validate_for_trim().is_ok());
    }

    #[test]
    fn handles_missing_fields() {
        let info = MediaInfo::from_ffprobe_json(b"{}").unwrap();
        assert_eq!(info.width, 0);
        assert_eq!(info.audio_tracks, 0);
        assert_eq!(info.validate_for_trim(), Err("未识别到视频流"));
    }

    #[test]
    fn falls_back_to_stream_duration_when_container_omits_it() {
        let info = MediaInfo::from_ffprobe_json(
            br#"{"streams":[{"codec_type":"video","codec_name":"h264","width":640,"height":360,"duration":"2.5"}]}"#,
        )
        .unwrap();
        assert_eq!(info.duration_sec, 2.5);
        assert!(info.validate_for_trim().is_ok());
    }

    #[test]
    fn rejects_corrupt_json_and_invalid_video_metadata() {
        assert!(MediaInfo::from_ffprobe_json(b"not-json").is_err());
        let missing_duration = MediaInfo::from_ffprobe_json(
            br#"{"streams":[{"codec_type":"video","codec_name":"h264","width":640,"height":360}]}"#,
        )
        .unwrap();
        assert_eq!(
            missing_duration.validate_for_trim(),
            Err("媒体时长不可识别或为零")
        );
    }

    #[test]
    fn parses_common_container_probe_matrix() {
        for (format, video, audio) in [
            ("mov,mp4,m4a,3gp,3g2,mj2", "h264", "aac"),
            ("matroska,webm", "hevc", "aac"),
            ("matroska,webm", "vp9", "opus"),
            ("avi", "mpeg4", "mp3"),
            ("mpegts", "h264", "aac"),
            ("mov,mp4,m4a,3gp,3g2,mj2", "prores", "pcm_s24le"),
            ("asf", "wmv3", "wmav2"),
        ] {
            let json = format!(
                r#"{{"streams":[{{"codec_type":"video","codec_name":"{video}","width":1280,"height":720,"r_frame_rate":"25/1"}},{{"codec_type":"audio","codec_name":"{audio}"}}],"format":{{"format_name":"{format}","duration":"2.0"}}}}"#
            );
            let info = MediaInfo::from_ffprobe_json(json.as_bytes()).unwrap();
            assert_eq!(info.format_name.as_deref(), Some(format));
            assert_eq!(info.video_codec.as_deref(), Some(video));
            assert_eq!(info.audio_codec.as_deref(), Some(audio));
            assert!(info.validate_for_trim().is_ok());
        }
    }
}
