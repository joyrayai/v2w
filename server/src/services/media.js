import path from "node:path";
import OSS from "ali-oss";
import { nanoid } from "nanoid";
import { AUDIO_DIR } from "../config.js";
import { runCommand } from "../utils.js";

export async function extractAudio(videoPath, settings, job, updateJob) {
  const ffmpeg = settings.ffmpegPath || "ffmpeg";
  const audioPath = path.join(AUDIO_DIR, `${job.id}-${nanoid(8)}.mp3`);
  await runCommand(ffmpeg, ["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", audioPath]);
  updateJob(job, { audioPath });
  return audioPath;
}

export async function probeDurationSec(filePath, settings = {}) {
  const ffprobe = settings.ffprobePath || "ffprobe";
  try {
    const result = await runCommand(
      ffprobe,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        filePath
      ],
      { timeoutMs: settings.ffprobeTimeoutMs || 30000 }
    );
    const duration = Number.parseFloat(String(result.stdout || "").trim());
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  } catch {
    return 0;
  }
}

export function publicBaseUrl(settings) {
  return String(settings.publicBaseUrl || process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
}

export function temporaryMediaUrl(filePath, settings) {
  const base = publicBaseUrl(settings);
  if (!base) {
    throw new Error("缺少公网访问地址。请通过服务器公网地址打开页面，或设置 PUBLIC_BASE_URL。");
  }
  return `${base}/temp-media/${encodeURIComponent(path.basename(filePath))}`;
}

export function hasOssConfig(settings) {
  return Boolean(settings.oss?.region && settings.oss?.bucket && settings.oss?.accessKeyId && settings.oss?.accessKeySecret);
}

export async function resolveAsrMediaUrl(filePath, settings, job, updateJob) {
  if (!hasOssConfig(settings)) {
    const url = temporaryMediaUrl(filePath, settings);
    updateJob(job, { mediaUrl: url, mediaUrlType: "temporary" });
    return url;
  }

  const client = new OSS({
    region: settings.oss.region,
    bucket: settings.oss.bucket,
    accessKeyId: settings.oss.accessKeyId,
    accessKeySecret: settings.oss.accessKeySecret,
    secure: true
  });
  const objectName = `${settings.oss.prefix || "video-to-word"}/${job.id}/${path.basename(filePath)}`;
  await client.put(objectName, filePath);
  const url = client.signatureUrl(objectName, { expires: 60 * 60 * 24 });
  updateJob(job, { mediaUrl: url, mediaUrlType: "oss" });
  return url;
}
