//! 流复制时的保守容器兼容性判断。
//!
//! 扩展名只用于选择输出复用器，输入格式识别始终来自 ffprobe。这里宁可明确拒绝
//! 边缘组合，也不让 ffmpeg 在不合适的默认容器上产生“成功”但难以播放的文件。

use crate::ffprobe::MediaInfo;
use std::path::Path;

fn ext(path: &Path) -> String {
    path.extension()
        .and_then(|v| v.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// 快速裁剪默认保留源容器。已知别名会规范到用户熟悉的扩展名。
pub fn recommended_lossless_extension(
    input: &Path,
    format_name: Option<&str>,
) -> Option<&'static str> {
    match ext(input).as_str() {
        "mp4" | "m4v" => Some("mp4"),
        "mov" => Some("mov"),
        "mkv" => Some("mkv"),
        "webm" => Some("webm"),
        "avi" => Some("avi"),
        "ts" | "mts" | "m2ts" => Some("ts"),
        "wmv" | "asf" => Some("wmv"),
        "flv" => Some("flv"),
        "mpg" | "mpeg" | "mpe" => Some("mpg"),
        "vob" => Some("vob"),
        "ogv" => Some("ogv"),
        "3gp" | "3g2" => Some("3gp"),
        "mxf" => Some("mxf"),
        _ => match format_name
            .unwrap_or_default()
            .split(',')
            .next()
            .unwrap_or_default()
        {
            "matroska" => Some("mkv"),
            "webm" => Some("webm"),
            "mov" | "mp4" => Some("mp4"),
            "avi" => Some("avi"),
            "mpegts" => Some("ts"),
            "asf" => Some("wmv"),
            "flv" => Some("flv"),
            "mpeg" | "mpegvideo" => Some("mpg"),
            "ogg" => Some("ogv"),
            "3gp" => Some("3gp"),
            "mxf" => Some("mxf"),
            "dvd" => Some("vob"),
            _ => None,
        },
    }
}

/// 音频流复制应使用与源编码相容的容器；未知编码不猜测。
pub fn recommended_audio_copy_extension(codec: Option<&str>) -> Result<&'static str, String> {
    match codec.unwrap_or_default().to_ascii_lowercase().as_str() {
        "aac" | "alac" => Ok("m4a"),
        "mp3" => Ok("mp3"),
        "opus" | "vorbis" => Ok("ogg"),
        "flac" => Ok("flac"),
        "pcm_s16le" | "pcm_s24le" | "pcm_s32le" | "pcm_f32le" => Ok("wav"),
        "ac3" => Ok("ac3"),
        "eac3" => Ok("eac3"),
        "wmav1" | "wmav2" | "wmapro" => Ok("wma"),
        "" => Err("源文件没有可识别的音频流，不能直接复制音频".into()),
        other => Err(format!(
            "音频编码 {other} 没有安全的默认复制容器；请选择 MP3、AAC、FLAC 或 WAV 转码"
        )),
    }
}

fn contains(value: Option<&str>, choices: &[&str]) -> bool {
    value
        .map(|v| choices.iter().any(|c| v.eq_ignore_ascii_case(c)))
        .unwrap_or(true)
}

fn source_format_contains(info: &MediaInfo, expected: &str) -> bool {
    info.format_name.as_deref().is_some_and(|names| {
        names
            .split(',')
            .any(|name| name.trim().eq_ignore_ascii_case(expected))
    })
}

/// 验证快速裁剪的目标容器是否能保守地容纳源视频/音频流。
pub fn validate_lossless_output(info: &MediaInfo, output: &Path) -> Result<(), String> {
    let e = ext(output);
    let v = info.video_codec.as_deref();
    let a = info.audio_codec.as_deref();
    let ok = match e.as_str() {
        // 保留 ffprobe 已明确识别的 Matroska 系容器不需要重新猜测其中的长尾编码；
        // 只有从其他容器改封装到 MKV 时才应用显式兼容白名单。
        "mkv" if source_format_contains(info, "matroska") => true,
        "mkv" => {
            contains(
                v,
                &[
                    "h264",
                    "hevc",
                    "h265",
                    "mpeg4",
                    "av1",
                    "vp8",
                    "vp9",
                    "mpeg2video",
                    "prores",
                    "mjpeg",
                    "wmv3",
                    "vc1",
                    "ffv1",
                    "theora",
                ],
            ) && contains(
                a,
                &[
                    "aac",
                    "alac",
                    "mp3",
                    "ac3",
                    "eac3",
                    "opus",
                    "vorbis",
                    "flac",
                    "pcm_s16le",
                    "pcm_s24le",
                    "pcm_s32le",
                    "pcm_f32le",
                    "wmav1",
                    "wmav2",
                    "wmapro",
                    "dts",
                    "truehd",
                ],
            )
        }
        "mp4" | "m4v" => {
            contains(v, &["h264", "hevc", "h265", "mpeg4", "av1"])
                && contains(a, &["aac", "alac", "mp3", "ac3", "eac3"])
        }
        "mov" => {
            contains(v, &["h264", "hevc", "h265", "mpeg4", "prores", "mjpeg"])
                && contains(
                    a,
                    &["aac", "alac", "mp3", "pcm_s16le", "pcm_s24le", "pcm_s32le"],
                )
        }
        "webm" => contains(v, &["vp8", "vp9", "av1"]) && contains(a, &["opus", "vorbis"]),
        "avi" => {
            contains(v, &["mpeg4", "mjpeg", "h264", "rawvideo"])
                && contains(a, &["mp3", "pcm_s16le", "pcm_s24le"])
        }
        "ts" | "mts" | "m2ts" => {
            contains(v, &["h264", "hevc", "h265", "mpeg2video"])
                && contains(a, &["aac", "ac3", "eac3", "mp2", "mp3"])
        }
        "wmv" | "asf" => {
            contains(v, &["wmv1", "wmv2", "wmv3", "vc1"])
                && contains(a, &["wmav1", "wmav2", "wmapro"])
        }
        "flv" => contains(v, &["h264", "flv1", "vp6f"]) && contains(a, &["aac", "mp3"]),
        "mpg" | "mpeg" | "mpe" => {
            contains(v, &["mpeg1video", "mpeg2video"])
                && contains(a, &["mp2", "mp3", "ac3", "pcm_s16be", "pcm_s16le"])
        }
        "vob" => {
            contains(v, &["mpeg2video", "mpeg1video"])
                && contains(a, &["ac3", "mp2", "pcm_s16be", "pcm_dvd"])
        }
        "ogv" => contains(v, &["theora", "vp8"]) && contains(a, &["vorbis", "opus"]),
        "3gp" | "3g2" => {
            contains(v, &["h264", "mpeg4", "h263"]) && contains(a, &["aac", "amr_nb", "amr_wb"])
        }
        "mxf" => {
            // Keep source MXF only when the probe already identified MXF; do not remux foreign codecs into MXF.
            source_format_contains(info, "mxf")
        }
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(format!(
            "目标容器 .{} 与源流不兼容（视频 {}，音频 {}）；请保留源容器或使用精确裁剪转码",
            if e.is_empty() { "(无扩展名)" } else { &e },
            v.unwrap_or("无"),
            a.unwrap_or("无")
        ))
    }
}

/// 验证音频 copy 的目标扩展名就是该编码的安全默认容器。
pub fn validate_audio_copy_output(info: &MediaInfo, output: &Path) -> Result<(), String> {
    let expected = recommended_audio_copy_extension(info.audio_codec.as_deref())?;
    let actual = ext(output);
    if actual == expected || (expected == "ogg" && actual == "opus") {
        Ok(())
    } else {
        Err(format!(
            "音频 {} 直接复制需输出为 .{}，当前目标是 .{}；请选择匹配容器或改用转码",
            info.audio_codec.as_deref().unwrap_or("未知"),
            expected,
            if actual.is_empty() {
                "(无扩展名)"
            } else {
                &actual
            }
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn media(v: &str, a: &str) -> MediaInfo {
        MediaInfo {
            duration_sec: 1.0,
            width: 320,
            height: 180,
            video_codec: Some(v.into()),
            audio_codec: Some(a.into()),
            ..Default::default()
        }
    }

    #[test]
    fn generated_container_matrix_has_safe_defaults() {
        for (path, format, expected) in [
            ("a.mp4", "mov,mp4", "mp4"),
            ("a.mkv", "matroska,webm", "mkv"),
            ("a.webm", "matroska,webm", "webm"),
            ("a.avi", "avi", "avi"),
            ("a.ts", "mpegts", "ts"),
            ("a.mov", "mov,mp4", "mov"),
            ("a.wmv", "asf", "wmv"),
        ] {
            assert_eq!(
                recommended_lossless_extension(Path::new(path), Some(format)),
                Some(expected)
            );
        }
    }

    #[test]
    fn webm_opus_is_not_silently_remuxed_to_mp4() {
        let info = media("vp9", "opus");
        assert!(validate_lossless_output(&info, Path::new("out.webm")).is_ok());
        assert!(validate_lossless_output(&info, Path::new("out.mp4")).is_err());
        assert_eq!(
            recommended_audio_copy_extension(Some("opus")).unwrap(),
            "ogg"
        );
        assert!(validate_audio_copy_output(&info, Path::new("audio.m4a")).is_err());
        assert!(validate_audio_copy_output(&info, Path::new("audio.ogg")).is_ok());
    }

    #[test]
    fn common_copy_matrix_and_unknowns_fail_closed() {
        assert!(validate_lossless_output(&media("h264", "aac"), Path::new("x.mp4")).is_ok());
        assert!(validate_lossless_output(&media("hevc", "aac"), Path::new("x.ts")).is_ok());
        assert!(validate_lossless_output(&media("wmv3", "wmav2"), Path::new("x.wmv")).is_ok());
        assert!(validate_lossless_output(&media("h264", "aac"), Path::new("x.unknown")).is_err());
        assert!(validate_lossless_output(&media("unknown", "aac"), Path::new("x.mkv")).is_err());
        assert!(recommended_audio_copy_extension(Some("cook")).is_err());
    }

    #[test]
    fn matroska_source_preserves_long_tail_codecs_but_remux_stays_fail_closed() {
        for codec in ["huffyuv", "utvideo"] {
            let mut source = media(codec, "pcm_s16le");
            source.format_name = Some("matroska,webm".into());
            assert!(validate_lossless_output(&source, Path::new("preserved.mkv")).is_ok());
        }

        let mut non_matroska = media("unknown", "aac");
        non_matroska.format_name = Some("mov,mp4,m4a,3gp,3g2,mj2".into());
        assert!(validate_lossless_output(&non_matroska, Path::new("remuxed.mkv")).is_err());
    }
}
