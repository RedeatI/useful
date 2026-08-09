//! 时间轴缩略图：缓存键、LRU 缓存、缩略图间隔选择、单帧提取参数。

use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::collections::VecDeque;
use std::path::Path;

/// 计算缩略图/元数据缓存键。
///
/// 键包含：规范化路径（小写盘符）、文件大小、修改时间（秒）、快速摘要，
/// 保证同一文件被移动/覆盖后缓存自动失效。
pub fn cache_key(normalized_path: &str, size: u64, mtime_secs: i64, quick_digest: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(normalized_path.to_lowercase().as_bytes());
    hasher.update(b"|");
    hasher.update(size.to_le_bytes());
    hasher.update(b"|");
    hasher.update(mtime_secs.to_le_bytes());
    hasher.update(b"|");
    hasher.update(quick_digest.as_bytes());
    hex::encode(&hasher.finalize()[..16])
}

/// 计算文件快速摘要：文件头 + 文件尾各 64KiB + 大小（避免读整个大文件）。
pub fn quick_digest(path: &Path) -> std::io::Result<String> {
    use std::io::{Read, Seek, SeekFrom};
    const CHUNK: usize = 64 * 1024;
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let mut hasher = Sha256::new();
    hasher.update(len.to_le_bytes());

    let mut head = vec![0u8; CHUNK.min(len as usize)];
    file.read_exact(&mut head)?;
    hasher.update(&head);

    if len > CHUNK as u64 * 2 {
        file.seek(SeekFrom::End(-(CHUNK as i64)))?;
        let mut tail = vec![0u8; CHUNK];
        file.read_exact(&mut tail)?;
        hasher.update(&tail);
    }
    Ok(hex::encode(&hasher.finalize()[..8]))
}

/// 根据时长、时间轴像素宽度与缩放级别，动态选择缩略图时间间隔（秒）。
///
/// 目标：每个缩略图约占 `thumb_px` 像素宽，间隔向「好看」的秒数对齐，且至少 1 秒。
pub fn thumbnail_interval_secs(duration_sec: f64, timeline_width_px: f64, zoom: f64) -> f64 {
    if duration_sec <= 0.0 || timeline_width_px <= 0.0 {
        return 1.0;
    }
    let thumb_px = 120.0;
    let effective_width = timeline_width_px * zoom.max(0.01);
    let thumbs = (effective_width / thumb_px).max(1.0);
    let raw = duration_sec / thumbs;
    // 对齐到 1,2,5,10,15,30,60... 的「好看」间隔
    let nice = [1.0, 2.0, 5.0, 10.0, 15.0, 30.0, 60.0, 120.0, 300.0, 600.0];
    for &n in &nice {
        if raw <= n {
            return n;
        }
    }
    // 超过 10 分钟则按整分钟向上取整
    (raw / 60.0).ceil() * 60.0
}

/// 构建从视频提取单帧缩略图的 ffmpeg 参数（精确 seek，缩放到指定宽度）。
pub fn build_thumbnail_args(
    input: &Path,
    time_sec: f64,
    out_png: &Path,
    width: u32,
) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-ss".into(),
        format!("{time_sec:.3}"),
        "-i".into(),
        input.to_string_lossy().to_string(),
        "-frames:v".into(),
        "1".into(),
        "-vf".into(),
        format!("scale={width}:-1"),
        "-y".into(),
        out_png.to_string_lossy().to_string(),
    ]
}

/// 简单 LRU 缓存：键 -> 值，容量满时淘汰最久未使用项。
pub struct LruCache<V> {
    capacity: usize,
    map: HashMap<String, V>,
    order: VecDeque<String>,
}

impl<V: Clone> LruCache<V> {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            map: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    pub fn get(&mut self, key: &str) -> Option<V> {
        if let Some(v) = self.map.get(key).cloned() {
            self.touch(key);
            Some(v)
        } else {
            None
        }
    }

    pub fn contains(&self, key: &str) -> bool {
        self.map.contains_key(key)
    }

    /// 插入；返回被淘汰的键和值（若有），调用方可精确删除对应磁盘文件。
    pub fn put(&mut self, key: String, value: V) -> Option<(String, V)> {
        if self.map.contains_key(&key) {
            self.map.insert(key.clone(), value);
            self.touch(&key);
            return None;
        }
        let evicted = if self.map.len() >= self.capacity {
            self.order
                .pop_front()
                .and_then(|old| self.map.remove(&old).map(|value| (old, value)))
        } else {
            None
        };
        self.map.insert(key.clone(), value);
        self.order.push_back(key);
        evicted
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    fn touch(&mut self, key: &str) {
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            self.order.remove(pos);
            self.order.push_back(key.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_key_changes_with_inputs() {
        let a = cache_key(r"c:\video.mp4", 1000, 111, "abc");
        let b = cache_key(r"c:\video.mp4", 2000, 111, "abc"); // size 变
        let c = cache_key(r"c:\video.mp4", 1000, 222, "abc"); // mtime 变
        let d = cache_key(r"c:\video.mp4", 1000, 111, "xyz"); // digest 变
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_ne!(a, d);
        // 盘符大小写不敏感
        assert_eq!(a, cache_key(r"C:\VIDEO.MP4", 1000, 111, "abc"));
    }

    #[test]
    fn interval_scales_with_duration_and_zoom() {
        // 10 分钟视频，1000px 宽，无缩放
        let i = thumbnail_interval_secs(600.0, 1000.0, 1.0);
        assert!(i >= 1.0);
        // 放大后间隔变小（更密集）
        let zoomed = thumbnail_interval_secs(600.0, 1000.0, 4.0);
        assert!(zoomed <= i);
    }

    #[test]
    fn interval_handles_zero() {
        assert_eq!(thumbnail_interval_secs(0.0, 1000.0, 1.0), 1.0);
        assert_eq!(thumbnail_interval_secs(600.0, 0.0, 1.0), 1.0);
    }

    #[test]
    fn thumbnail_args_use_precise_seek() {
        let args = build_thumbnail_args(Path::new("中文.mp4"), 12.5, Path::new("o.png"), 160);
        assert!(args.windows(2).any(|w| w == ["-ss", "12.500"]));
        assert!(args.contains(&"scale=160:-1".to_string()));
        assert!(args.iter().any(|a| a == "中文.mp4"));
    }

    #[test]
    fn lru_evicts_oldest() {
        let mut cache: LruCache<u32> = LruCache::new(2);
        assert!(cache.put("a".into(), 1).is_none());
        assert!(cache.put("b".into(), 2).is_none());
        // 访问 a，使 b 成为最久未用
        assert_eq!(cache.get("a"), Some(1));
        let evicted = cache.put("c".into(), 3);
        assert_eq!(evicted, Some(("b".to_string(), 2)));
        assert!(cache.contains("a"));
        assert!(cache.contains("c"));
        assert!(!cache.contains("b"));
        assert_eq!(cache.len(), 2);
    }
}
