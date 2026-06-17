import path from "node:path";
import { parseSpeed, runCommand, safeName } from "../../utils.js";

export async function downloadWithYtDlp(job, url, outDir, updateDownloadStats) {
  const outputTemplate = path.join(outDir, `${safeName(job.title || "video")}.%(ext)s`);
  updateDownloadStats(job, { step: "解析视频页面", progress: 10 });
  return runCommand("yt-dlp", [
    "--no-playlist",
    "--newline",
    "-f",
    "bestaudio/best",
    "-o",
    outputTemplate,
    url
  ], {
    onData: (text) => {
      const speed = parseSpeed(text);
      const pct = String(text).match(/\[download\]\s+([\d.]+)%/i)?.[1];
      const progress = pct ? Math.min(24, 10 + Math.round((Number(pct) / 100) * 14)) : Math.max(job.progress || 10, 10);
      if (speed || pct) {
        updateDownloadStats(job, {
          downloadSpeed: speed || job.downloadSpeed || "",
          progress,
          step: speed ? `下载音频 ${speed}` : `下载音频 ${pct}%`
        });
      }
    }
  });
}
