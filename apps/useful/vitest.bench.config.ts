import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

// Benchmark 专用配置：node 环境、只跑 bench 目录，不进入常规 CI test。
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["bench/**/*.spec.ts"],
    // benchmark 单轮可能较久
    testTimeout: 120_000,
  },
});
