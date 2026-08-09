//! 可重复的采样器 benchmark：连续采样 N 轮，输出每轮耗时分位数与
//! 估算 CPU 占用（采样耗时 / 1s 采样间隔），JSON 打到 stdout。
//!
//! 运行：cargo run --release -p useful-procmon --example bench_sampler

use useful_procmon::diff::{build_map, diff, SnapshotMap};
use useful_procmon::sampler::Sampler;

fn percentile(sorted_ms: &[f64], p: f64) -> f64 {
    if sorted_ms.is_empty() {
        return 0.0;
    }
    let idx = ((sorted_ms.len() as f64 - 1.0) * p).round() as usize;
    sorted_ms[idx.min(sorted_ms.len() - 1)]
}

fn main() {
    const ROUNDS: usize = 20;
    // 与产品一致的完整采样器（含 ETW/PDH；无权限时自动降级为不可用）
    let mut sampler = Sampler::new();
    let mut prev: SnapshotMap = SnapshotMap::default();
    let mut times_ms: Vec<f64> = Vec::with_capacity(ROUNDS);
    let mut process_count = 0usize;

    // 预热一轮（首轮包含静态信息收集，成本偏高，单独记录）
    let warm_start = std::time::Instant::now();
    let next = build_map(sampler.sample());
    let _ = diff(&prev, &next);
    prev = next;
    let warmup_ms = warm_start.elapsed().as_secs_f64() * 1000.0;

    for _ in 0..ROUNDS {
        let start = std::time::Instant::now();
        let next = build_map(sampler.sample());
        let _delta = diff(&prev, &next);
        process_count = next.len();
        prev = next;
        times_ms.push(start.elapsed().as_secs_f64() * 1000.0);
        // 模拟 1 秒采样节奏（缩短为 200ms 保持 benchmark 可快速重复；
        // CPU 估算仍按产品实际的 1000ms 周期折算）
        std::thread::sleep(std::time::Duration::from_millis(200));
    }

    let mut sorted = times_ms.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let avg: f64 = times_ms.iter().sum::<f64>() / times_ms.len() as f64;
    // 每 1000ms 周期内采样占用 avg 毫秒 => 单核占比；换算为全机 CPU 百分比
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1) as f64;
    let est_cpu_percent = (avg / 1000.0) * 100.0 / cores;

    let json = format!(
        "{{\"rounds\":{ROUNDS},\"processCount\":{process_count},\"warmupMs\":{warmup_ms:.2},\
         \"avgMs\":{avg:.2},\"p50Ms\":{:.2},\"p95Ms\":{:.2},\"maxMs\":{:.2},\
         \"estimatedCpuPercent\":{est_cpu_percent:.3},\"cores\":{cores},\
         \"netAvailable\":{},\"gpuAvailable\":{}}}",
        percentile(&sorted, 0.50),
        percentile(&sorted, 0.95),
        sorted.last().copied().unwrap_or(0.0),
        sampler.net_available(),
        sampler.gpu_available(),
    );
    println!("{json}");
}
