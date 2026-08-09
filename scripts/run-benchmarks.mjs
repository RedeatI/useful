// 可重复 benchmark 执行器：跑前端差量 bench + Rust 采样器 bench + 媒体元数据 bench，
// 汇总结果与参考机器配置写入 docs/BENCHMARK.md。缺少媒体运行时/视频样本时如实标记
// “未执行”，绝不伪造数据。
//
// 用法：
//   node scripts/run-benchmarks.mjs [--video <测试视频路径>]
//
// 前置：Rust 工具链（cargo）、pnpm install 已完成。

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = join(root, "bench-results");
mkdirSync(resultsDir, { recursive: true });

const args = process.argv.slice(2);
const videoIdx = args.indexOf("--video");
const videoPath = videoIdx >= 0 ? args[videoIdx + 1] : null;

function machineInfo() {
  const cpus = os.cpus();
  return {
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    cpu: cpus[0]?.model?.trim() ?? "unknown",
    logicalCores: cpus.length,
    memoryGiB: (os.totalmem() / 1024 ** 3).toFixed(1),
    node: process.version,
  };
}

function runProcTableBench() {
  console.log("== 前端差量处理 benchmark (500 进程) ==");
  const r = spawnSync("pnpm", ["--filter", "@useful/app", "bench"], {
    cwd: root,
    stdio: "inherit",
    shell: true,
  });
  if (r.status !== 0) throw new Error("前端 benchmark 失败");
  return JSON.parse(readFileSync(join(resultsDir, "proctable.json"), "utf8"));
}

function runSamplerBench() {
  console.log("== 后台采样器 benchmark (Rust, release) ==");
  const out = execSync(
    "cargo run --release -p useful-procmon --example bench_sampler",
    { cwd: root, encoding: "utf8" },
  );
  const line = out.trim().split(/\r?\n/).pop();
  const result = JSON.parse(line);
  writeFileSync(join(resultsDir, "sampler.json"), JSON.stringify(result, null, 2));
  return result;
}

async function runMediaBench() {
  console.log("== 媒体元数据 benchmark ==");
  const ffprobe = join(root, "binaries", "ffprobe.exe");
  if (!existsSync(ffprobe)) {
    console.warn("跳过：binaries/ffprobe.exe 不存在（Lite 环境）");
    return { skipped: true, reason: "no ffprobe binary" };
  }
  if (!videoPath || !existsSync(videoPath)) {
    console.warn("跳过：未提供 --video <路径> 或文件不存在");
    return { skipped: true, reason: "no sample video" };
  }
  const times = [];
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    const r = spawnSync(
      ffprobe,
      [
        "-v", "error",
        "-print_format", "json",
        "-show_format", "-show_streams",
        videoPath,
      ],
      { encoding: "utf8" },
    );
    if (r.status !== 0) return { skipped: true, reason: `ffprobe 失败: ${r.stderr}` };
    times.push(performance.now() - start);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * q))];
  const result = {
    skipped: false,
    video: videoPath,
    rounds: times.length,
    avgMs: times.reduce((a, b) => a + b, 0) / times.length,
    p50Ms: p(0.5),
    p95Ms: p(0.95),
  };
  writeFileSync(join(resultsDir, "media.json"), JSON.stringify(result, null, 2));
  return result;
}

function fmtMs(v) {
  return `${v.toFixed(2)} ms`;
}

function renderReport({ machine, proctable, sampler, media }) {
  const now = new Date().toISOString();
  const mediaSection = media.skipped
    ? `> **未执行**：${media.reason}。需在含 \`binaries/ffprobe.exe\`（Full 运行时）的机器上\n> 运行 \`node scripts/run-benchmarks.mjs --video <4K样本.mp4>\` 补测。\n> 首帧时间（P95 < 3s）与硬解丢帧率（< 1%）需真机 GUI 环境实测，无法在无桌面环境验证。`
    : `- 样本：\`${media.video}\`\n- 元数据读取（ffprobe，${media.rounds} 轮）：平均 ${fmtMs(media.avgMs)}，P50 ${fmtMs(media.p50Ms)}，**P95 ${fmtMs(media.p95Ms)}**（目标 < 2000 ms：${media.p95Ms < 2000 ? "✅ 达标" : "❌ 未达标"}）\n- 首帧时间与硬解丢帧率需 GUI 真机实测（mpv HWND 嵌入），本脚本不覆盖。`;

  return `# 性能 Benchmark 报告

> 本报告由 \`node scripts/run-benchmarks.mjs\` 自动生成（生成时间 ${now}）。
> 所有数字来自真实运行，缺失环境的项目如实标记"未执行"，不伪造。

## 参考机器配置

| 项 | 值 |
| --- | --- |
| 操作系统 | ${machine.os} |
| CPU | ${machine.cpu} |
| 逻辑核心 | ${machine.logicalCores} |
| 内存 | ${machine.memoryGiB} GiB |
| Node.js | ${machine.node} |

## 进程监视器

### 前端差量处理（500 进程，${proctable.rounds} 轮，applyDelta + 树/列表重建）

| 指标 | 值 | 目标 | 结果 |
| --- | --- | --- | --- |
| 平均 | ${fmtMs(proctable.avgMs)} | — | — |
| P50 | ${fmtMs(proctable.p50Ms)} | — | — |
| P95 | ${fmtMs(proctable.p95Ms)} | < 50 ms | ${proctable.p95Ms < 50 ? "✅ 达标" : "❌ 未达标"} |
| 最大 | ${fmtMs(proctable.maxMs)} | — | — |

> 说明：视图层为虚拟化表格，仅渲染可见行；此处测量的数据层重建是每轮差量的主要成本。
> 运行方式：\`pnpm --filter @useful/app bench\`（vitest, node 环境）。

### 后台采样器（Rust release，完整采样含 ETW/PDH 降级路径，${sampler.rounds} 轮）

| 指标 | 值 | 目标 | 结果 |
| --- | --- | --- | --- |
| 实际进程数 | ${sampler.processCount} | — | — |
| 首轮（含静态信息） | ${fmtMs(sampler.warmupMs)} | — | — |
| 每轮平均 | ${fmtMs(sampler.avgMs)} | — | — |
| 每轮 P95 | ${fmtMs(sampler.p95Ms)} | — | — |
| 估算 CPU 占用（1s 周期 / ${sampler.cores} 核） | ${sampler.estimatedCpuPercent.toFixed(3)} % | < 2 % | ${sampler.estimatedCpuPercent < 2 ? "✅ 达标" : "❌ 未达标"} |
| ETW 网络可用 | ${sampler.netAvailable} | — | 无权限时按设计显示"不可用" |
| PDH GPU 可用 | ${sampler.gpuAvailable} | — | 同上 |

> 运行方式：\`cargo run --release -p useful-procmon --example bench_sampler\`。

## 视频（元数据 / 首帧 / 丢帧）

参考文件要求：常见 H.264/H.265 4K、时长可达 2 小时、码率 ≤ 120 Mbps。

${mediaSection}

## 交互延迟目标（真机 GUI 验证项）

以下指标依赖交互桌面，无法用脚本可靠测量，发布验收时用真机手测 + 开发者性能面板复核：

- 按钮点击到界面反馈 P95 < 100 ms
- 结束进程命令提交 P95 < 100 ms（实际结束结果异步显示）
- 500 进程滚动/展开无明显掉帧
- 快速无损裁剪（NVMe、输出 ≤ 10GB）目标 < 30 s；精确重编码显示 ETA，不承诺时长
`;
}

const machine = machineInfo();
const proctable = runProcTableBench();
const sampler = runSamplerBench();
const media = await runMediaBench();

const report = renderReport({ machine, proctable, sampler, media });
mkdirSync(join(root, "docs"), { recursive: true });
writeFileSync(join(root, "docs", "BENCHMARK.md"), report);
console.log("\n已生成 docs/BENCHMARK.md");
console.log(pathToFileURL(join(root, "docs", "BENCHMARK.md")).href);
