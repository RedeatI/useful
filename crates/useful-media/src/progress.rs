//! 解析 `ffmpeg -progress pipe:1` 的进度输出。
//!
//! ffmpeg 每隔一段时间以 `key=value` 行输出一组进度，以 `progress=continue`
//! 或 `progress=end` 结尾。本模块把一组行解析为 `ProgressUpdate`。

use serde::{Deserialize, Serialize};

/// 一次进度更新。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressUpdate {
    /// 已处理帧数
    pub frame: u64,
    /// 处理速度倍率（如 2.0x）
    pub speed: f64,
    /// 已输出时间（微秒）
    pub out_time_us: u64,
    /// 输出总字节
    pub total_size: u64,
    /// 是否结束
    pub done: bool,
}

impl ProgressUpdate {
    /// 计算完成百分比与 ETA（秒）。需要总时长（秒）。
    pub fn percent_and_eta(&self, total_duration_sec: f64) -> (f64, Option<f64>) {
        if total_duration_sec <= 0.0 {
            return (0.0, None);
        }
        let done_sec = self.out_time_us as f64 / 1_000_000.0;
        let percent = (done_sec / total_duration_sec * 100.0).clamp(0.0, 100.0);
        let eta = if self.speed > 0.0 {
            let remaining = (total_duration_sec - done_sec).max(0.0);
            Some(remaining / self.speed)
        } else {
            None
        };
        (percent, eta)
    }
}

/// 增量解析器：喂入 stdout 文本行，聚合成一次次进度更新。
#[derive(Default)]
pub struct ProgressParser {
    current: ProgressUpdate,
}

impl ProgressParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// 处理一行。返回 `Some(update)` 表示一组进度结束（遇到 progress= 行）。
    pub fn push_line(&mut self, line: &str) -> Option<ProgressUpdate> {
        let line = line.trim();
        let (key, value) = line.split_once('=')?;
        let value = value.trim();
        match key.trim() {
            "frame" => {
                self.current.frame = value.parse().unwrap_or(self.current.frame);
            }
            "total_size" => {
                self.current.total_size = value.parse().unwrap_or(0);
            }
            "out_time_us" | "out_time_ms" => {
                // 注意：ffmpeg 的 out_time_ms 实际是微秒（历史遗留命名）
                self.current.out_time_us = value.parse().unwrap_or(self.current.out_time_us);
            }
            "speed" => {
                // 形如 "2.05x" 或 "N/A"
                let num = value.trim_end_matches('x').trim();
                self.current.speed = num.parse().unwrap_or(0.0);
            }
            "progress" => {
                self.current.done = value == "end";
                let out = self.current.clone();
                // 保留累计字段，重置 done
                self.current.done = false;
                return Some(out);
            }
            _ => {}
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_progress_block() {
        let mut parser = ProgressParser::new();
        let lines = [
            "frame=120",
            "fps=60",
            "total_size=1048576",
            "out_time_us=2000000",
            "speed=2.0x",
            "progress=continue",
        ];
        let mut result = None;
        for l in lines {
            if let Some(u) = parser.push_line(l) {
                result = Some(u);
            }
        }
        let u = result.expect("应产出一次更新");
        assert_eq!(u.frame, 120);
        assert_eq!(u.total_size, 1048576);
        assert_eq!(u.out_time_us, 2_000_000);
        assert!((u.speed - 2.0).abs() < 1e-9);
        assert!(!u.done);
    }

    #[test]
    fn computes_percent_and_eta() {
        let u = ProgressUpdate {
            frame: 0,
            speed: 2.0,
            out_time_us: 30_000_000, // 30s done
            total_size: 0,
            done: false,
        };
        let (pct, eta) = u.percent_and_eta(60.0);
        assert!((pct - 50.0).abs() < 0.001);
        // 剩余 30s，速度 2x -> 15s
        assert!((eta.unwrap() - 15.0).abs() < 0.001);
    }

    #[test]
    fn detects_end() {
        let mut parser = ProgressParser::new();
        let u = parser.push_line("progress=end").unwrap();
        assert!(u.done);
    }

    #[test]
    fn handles_na_speed() {
        let mut parser = ProgressParser::new();
        parser.push_line("speed=N/A");
        let u = parser.push_line("progress=continue").unwrap();
        assert_eq!(u.speed, 0.0);
        // speed=0 时 ETA 不可计算
        assert_eq!(u.percent_and_eta(60.0).1, None);
    }
}
