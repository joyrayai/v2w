import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { MEDIA_FILE_RE } from "./config.js";

export function safeName(input) {
  return String(input || "video").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 80);
}

export function removePath(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) return;
  fs.rmSync(targetPath, { recursive: true, force: true });
}

export function runCommand(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const { onData, timeoutMs = 0, ...spawnOpts } = opts;
    const child = spawn(command, args, { ...spawnOpts, shell: false });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms\n${stderr || stdout}`));
    }, timeoutMs) : null;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    child.stdout?.on("data", (d) => {
      const text = d.toString();
      stdout += text;
      onData?.(text, "stdout");
    });
    child.stderr?.on("data", (d) => {
      const text = d.toString();
      stderr += text;
      onData?.(text, "stderr");
    });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`${command} exited ${code}\n${stderr || stdout}`));
      });
    });
  });
}

export function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${Math.max(0, Math.round(value))} B`;
}

export function parseSpeed(text) {
  const match = String(text || "").match(/([\d.]+)\s*([KMGT]?i?B|[KMGT]?B|B)\/s/i);
  if (!match) return "";
  const unit = match[2].toUpperCase().replace("IB", "B");
  return `${match[1]} ${unit}/s`;
}

export function listFilesRecursive(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".")) return [];
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFilesRecursive(fullPath);
    return entry.isFile() ? [fullPath] : [];
  });
}

export function pickMediaFile(files) {
  return files.find((file) => MEDIA_FILE_RE.test(file));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
