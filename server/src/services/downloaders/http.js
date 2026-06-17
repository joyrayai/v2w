import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { formatBytes } from "../../utils.js";

export async function downloadHttp(url, dest, job, updateDownloadStats, options = {}) {
  const res = await fetch(url, {
    headers: options.headers || undefined,
    redirect: options.redirect || "follow"
  });
  if (!res.ok || !res.body) throw new Error(`下载失败：${res.status} ${res.statusText}`);
  const total = Number(res.headers.get("content-length") || 0);
  let downloaded = 0;
  let lastTime = Date.now();
  let lastBytes = 0;
  const stream = new TransformStream({
    transform(chunk, controller) {
      downloaded += chunk.byteLength;
      const now = Date.now();
      if (job && now - lastTime >= 1000) {
        const speed = ((downloaded - lastBytes) / Math.max((now - lastTime) / 1000, 0.001));
        const pct = total ? Math.min(24, 10 + Math.round((downloaded / total) * 14)) : 10;
        updateDownloadStats(job, {
          progress: pct,
          downloadedBytes: downloaded,
          downloadSpeed: `${formatBytes(speed)}/s`,
          downloadTotalBytes: total || undefined,
          step: total ? `下载视频 ${formatBytes(downloaded)} / ${formatBytes(total)}` : `下载视频 ${formatBytes(downloaded)}`
        });
        lastTime = now;
        lastBytes = downloaded;
      }
      controller.enqueue(chunk);
    }
  });
  await pipeline(Readable.fromWeb(res.body.pipeThrough(stream)), createWriteStream(dest));
  if (job) {
    updateDownloadStats(job, {
      progress: 24,
      downloadedBytes: downloaded,
      downloadSpeed: "",
      step: "下载完成，检查文件"
    });
  }
  return dest;
}
