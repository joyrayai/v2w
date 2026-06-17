import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, "../..");
export const DATA_DIR = path.join(ROOT, "data");
export const DOWNLOAD_DIR = path.join(DATA_DIR, "downloads");
export const AUDIO_DIR = path.join(DATA_DIR, "audio");
export const OUTPUT_DIR = path.join(DATA_DIR, "outputs");
export const NETDISK_USERS_DIR = path.join(DATA_DIR, "netdisk-users");
export const USERS_FILE = path.join(DATA_DIR, "users.json");
export const SQLITE_FILE = path.join(DATA_DIR, "app.sqlite");
export const DIST_DIR = path.join(ROOT, "dist");

export const SHELL = fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
export const MEDIA_FILE_RE = /\.(mp4|mov|m4v|avi|mkv|flv|webm|mp3|m4a|m4s|wav|aac)(?:$|[?#])/i;
export const CLOUD_DRIVE_RE = /pan\.baidu\.com|yun\.baidu\.com|pan\.quark\.cn|drive\.uc\.cn/i;
export const DEFAULT_NETDISK_TEMP_DIR = "/视频转Word临时文件";
export const GIB = 1024 ** 3;

export const defaultPrompt = `请把下面的视频转写文本整理成适合阅读的中文 Word 文稿：
1. 保留原意，不编造事实。
2. 修正明显口误、重复语气词和错别字。
3. 按主题分段，添加清晰小标题。
4. 提取关键要点和行动项。
5. 输出 Markdown，包含标题、摘要、正文和要点。`;

export function boundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export const APP_CONFIG = {
  maxConcurrency: boundedInt(process.env.MAX_CONCURRENCY, 5, 1, 5),
  maxUserRunning: boundedInt(process.env.MAX_USER_RUNNING, 2, 1, 5),
  maxUserQueued: boundedInt(process.env.MAX_USER_QUEUED, 50, 1, 200),
  minFreeDiskBytes: boundedInt(process.env.MIN_FREE_DISK_GB, 6, 1, 30) * GIB,
  cleanupIntervalMs: 24 * 60 * 60 * 1000
};

export const USAGE_PRICING = {
  currency: "CNY",
  asr: {
    "paraformer-v2": { unit: "second", pricePerUnit: 0.00008 },
    "paraformer-8k-v2": { unit: "second", pricePerUnit: 0.00008 },
    "paraformer-v1": { unit: "second", pricePerUnit: 0.00008 },
    "paraformer-8k-v1": { unit: "second", pricePerUnit: 0.00008 },
    "paraformer-mtl-v1": { unit: "second", pricePerUnit: 0.00008 },
    "paraformer-realtime-v2": { unit: "second", pricePerUnit: 0.00024 },
    "sensevoice-v1": { unit: "second", pricePerUnit: 0.0007 },
    "qwen3-asr-flash-filetrans": { unit: "second", pricePerUnit: 0.00022 },
    "qwen3-asr-flash-filetrans-2025-11-17": { unit: "second", pricePerUnit: 0.00022 },
    "qwen3-asr-flash": { unit: "second", pricePerUnit: 0.00022 },
    "qwen3-asr-flash-2026-02-10": { unit: "second", pricePerUnit: 0.00022 },
    "qwen3-asr-flash-2025-09-08": { unit: "second", pricePerUnit: 0.00022 },
    "qwen3-asr-flash-realtime": { unit: "second", pricePerUnit: 0.00033 },
    "qwen3-asr-flash-realtime-2026-02-10": { unit: "second", pricePerUnit: 0.00033 },
    "qwen3-asr-flash-realtime-2025-10-27": { unit: "second", pricePerUnit: 0.00033 },
    "fun-asr": { unit: "second", pricePerUnit: 0.00022 },
    "fun-asr-2025-11-07": { unit: "second", pricePerUnit: 0.00022 },
    "fun-asr-2025-08-25": { unit: "second", pricePerUnit: 0.00022 },
    "fun-asr-mtl": { unit: "second", pricePerUnit: 0.00022 },
    "fun-asr-mtl-2025-08-25": { unit: "second", pricePerUnit: 0.00022 },
    "fun-asr-realtime": { unit: "second", pricePerUnit: 0.00033 },
    "fun-asr-realtime-2026-02-28": { unit: "second", pricePerUnit: 0.00033 },
    "fun-asr-realtime-2025-11-07": { unit: "second", pricePerUnit: 0.00033 },
    "fun-asr-realtime-2025-09-15": { unit: "second", pricePerUnit: 0.00033 },
    "fun-asr-mtl-realtime": { unit: "second", pricePerUnit: 0.00033 },
    "fun-asr-mtl-realtime-2025-12-10": { unit: "second", pricePerUnit: 0.00033 },
    "fun-asr-flash-8k-realtime": { unit: "second", pricePerUnit: 0.00022 },
    "fun-asr-flash-8k-realtime-2026-01-28": { unit: "second", pricePerUnit: 0.00022 }
  },
  llm: {
    "qwen-max": { inputPer1K: 0.0024, outputPer1K: 0.0096 },
    "qwen-max-latest": { inputPer1K: 0.0024, outputPer1K: 0.0096 },
    "qwen-plus": {
      tiers: [
        { maxInputTokens: 128000, inputPer1K: 0.0008, outputPer1K: 0.002 },
        { maxInputTokens: 256000, inputPer1K: 0.0024, outputPer1K: 0.02 },
        { maxInputTokens: 1000000, inputPer1K: 0.0048, outputPer1K: 0.048 }
      ]
    },
    "qwen-plus-latest": {
      tiers: [
        { maxInputTokens: 128000, inputPer1K: 0.0008, outputPer1K: 0.002 },
        { maxInputTokens: 256000, inputPer1K: 0.0024, outputPer1K: 0.02 },
        { maxInputTokens: 1000000, inputPer1K: 0.0048, outputPer1K: 0.048 }
      ]
    },
    "qwen-long": { inputPer1K: 0.0005, outputPer1K: 0.002 },
    "qwen-long-latest": { inputPer1K: 0.0005, outputPer1K: 0.002 },
    "qwen-turbo": { inputPer1K: 0.0003, outputPer1K: 0.0006 },
    "qwen-flash": {
      tiers: [
        { maxInputTokens: 128000, inputPer1K: 0.00015, outputPer1K: 0.0015 },
        { maxInputTokens: 256000, inputPer1K: 0.0006, outputPer1K: 0.006 },
        { maxInputTokens: 1000000, inputPer1K: 0.0012, outputPer1K: 0.012 }
      ]
    },
    "qwen-flash-2025-07-28": {
      tiers: [
        { maxInputTokens: 128000, inputPer1K: 0.00015, outputPer1K: 0.0015 },
        { maxInputTokens: 256000, inputPer1K: 0.0006, outputPer1K: 0.006 },
        { maxInputTokens: 1000000, inputPer1K: 0.0012, outputPer1K: 0.012 }
      ]
    },
    "qwen3.5-flash": {
      tiers: [
        { maxInputTokens: 128000, inputPer1K: 0.0002, outputPer1K: 0.002 },
        { maxInputTokens: 256000, inputPer1K: 0.0008, outputPer1K: 0.008 },
        { maxInputTokens: 1000000, inputPer1K: 0.0012, outputPer1K: 0.012 }
      ]
    },
    "qwen3.6-flash": {
      tiers: [
        { maxInputTokens: 256000, inputPer1K: 0.0012, outputPer1K: 0.0072 },
        { maxInputTokens: 1000000, inputPer1K: 0.0048, outputPer1K: 0.0288 }
      ]
    },
    "qwen3.5-plus": {
      tiers: [
        { maxInputTokens: 128000, inputPer1K: 0.0008, outputPer1K: 0.0048 },
        { maxInputTokens: 256000, inputPer1K: 0.002, outputPer1K: 0.012 },
        { maxInputTokens: 1000000, inputPer1K: 0.004, outputPer1K: 0.024 }
      ]
    },
    "qwen3.5-plus-2026-04-20": {
      tiers: [
        { maxInputTokens: 128000, inputPer1K: 0.0008, outputPer1K: 0.0048 },
        { maxInputTokens: 256000, inputPer1K: 0.002, outputPer1K: 0.012 },
        { maxInputTokens: 1000000, inputPer1K: 0.004, outputPer1K: 0.024 }
      ]
    },
    "qwen3.5-plus-2026-02-15": {
      tiers: [
        { maxInputTokens: 128000, inputPer1K: 0.0008, outputPer1K: 0.0048 },
        { maxInputTokens: 256000, inputPer1K: 0.002, outputPer1K: 0.012 },
        { maxInputTokens: 1000000, inputPer1K: 0.004, outputPer1K: 0.024 }
      ]
    },
    "qwen3.6-plus": {
      tiers: [
        { maxInputTokens: 256000, inputPer1K: 0.002, outputPer1K: 0.012 },
        { maxInputTokens: 1000000, inputPer1K: 0.008, outputPer1K: 0.048 }
      ]
    },
    "qwen3.6-plus-2026-04-02": {
      tiers: [
        { maxInputTokens: 256000, inputPer1K: 0.002, outputPer1K: 0.012 },
        { maxInputTokens: 1000000, inputPer1K: 0.008, outputPer1K: 0.048 }
      ]
    },
    "qwen3.7-plus": {
      tiers: [
        { maxInputTokens: 256000, inputPer1K: 0.002, outputPer1K: 0.008 },
        { maxInputTokens: 1000000, inputPer1K: 0.006, outputPer1K: 0.024 }
      ]
    },
    "qwen3.7-plus-2026-05-26": {
      tiers: [
        { maxInputTokens: 256000, inputPer1K: 0.002, outputPer1K: 0.008 },
        { maxInputTokens: 1000000, inputPer1K: 0.006, outputPer1K: 0.024 }
      ]
    },
    "qwen3-max": {
      tiers: [
        { maxInputTokens: 32000, inputPer1K: 0.0025, outputPer1K: 0.01 },
        { maxInputTokens: 128000, inputPer1K: 0.004, outputPer1K: 0.016 },
        { maxInputTokens: 256000, inputPer1K: 0.007, outputPer1K: 0.028 }
      ]
    },
    "qwen3-max-2026-01-23": {
      tiers: [
        { maxInputTokens: 32000, inputPer1K: 0.0025, outputPer1K: 0.01 },
        { maxInputTokens: 128000, inputPer1K: 0.004, outputPer1K: 0.016 },
        { maxInputTokens: 256000, inputPer1K: 0.007, outputPer1K: 0.028 }
      ]
    },
    "qwen3-max-2025-09-23": {
      tiers: [
        { maxInputTokens: 32000, inputPer1K: 0.006, outputPer1K: 0.024 },
        { maxInputTokens: 128000, inputPer1K: 0.01, outputPer1K: 0.04 },
        { maxInputTokens: 256000, inputPer1K: 0.015, outputPer1K: 0.06 }
      ]
    },
    "qwen3-max-preview": {
      tiers: [
        { maxInputTokens: 32000, inputPer1K: 0.006, outputPer1K: 0.024 },
        { maxInputTokens: 128000, inputPer1K: 0.01, outputPer1K: 0.04 },
        { maxInputTokens: 256000, inputPer1K: 0.015, outputPer1K: 0.06 }
      ]
    },
    "qwen3.7-max": { inputPer1K: 0.012, outputPer1K: 0.036 },
    "qwen3.7-max-2026-06-08": { inputPer1K: 0.012, outputPer1K: 0.036 },
    "qwen3.7-max-2026-05-20": { inputPer1K: 0.012, outputPer1K: 0.036 },
    "qwq-plus": { inputPer1K: 0.0016, outputPer1K: 0.004 },
    "qwen-coder-plus": { inputPer1K: 0.0035, outputPer1K: 0.007 },
    "qwen-coder-turbo": { inputPer1K: 0.002, outputPer1K: 0.006 },
    "deepseek-v4-flash": { inputPer1K: 0.001, outputPer1K: 0.002 },
    "deepseek-v4-pro": { inputPer1K: 0.012, outputPer1K: 0.024 },
    "deepseek-v3.2": { inputPer1K: 0.002, outputPer1K: 0.003 },
    "deepseek-v3.2-exp": { inputPer1K: 0.002, outputPer1K: 0.003 },
    "deepseek-v3.1": { inputPer1K: 0.004, outputPer1K: 0.012 },
    "deepseek-v3": { inputPer1K: 0.002, outputPer1K: 0.008 },
    "deepseek-chat": { inputPer1K: 0.001, outputPer1K: 0.002 },
    "deepseek-ai/DeepSeek-V3": { inputPer1K: 0.001, outputPer1K: 0.002 }
  }
};

export function ensureDataDirs() {
  for (const dir of [DATA_DIR, DOWNLOAD_DIR, AUDIO_DIR, OUTPUT_DIR, NETDISK_USERS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
