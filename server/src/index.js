import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import express from "express";
import cors from "cors";
import {
  APP_CONFIG,
  AUDIO_DIR,
  CLOUD_DRIVE_RE,
  DATA_DIR,
  DEFAULT_NETDISK_TEMP_DIR,
  DIST_DIR,
  DOWNLOAD_DIR,
  GIB,
  MEDIA_FILE_RE,
  NETDISK_USERS_DIR,
  OUTPUT_DIR,
  SHELL,
  SQLITE_FILE,
  USERS_FILE,
  ensureDataDirs
} from "./config.js";
import { createRequireAuth, normalizeUsername } from "./auth.js";
import { createStore } from "./store.js";
import {
  formatBytes,
  listFilesRecursive,
  parseSpeed,
  pickMediaFile,
  removePath,
  runCommand,
  safeName,
  sleep
} from "./utils.js";
import {
  generateDocumentTitleDetailed,
  pollAsr,
  polishTextDetailed,
  submitAsr,
  transcriptToText
} from "./services/ai.js";
import { writeWord } from "./services/word.js";
import { registerRoutes } from "./routes.js";
import { registerMcpRoutes } from "./mcp/http.js";
import { detectNetdiskProvider, unsupportedNetdiskMessage } from "./services/netdisk.js";
import { extractAudio, hasOssConfig, probeDurationSec, resolveAsrMediaUrl } from "./services/media.js";
import { downloadHttp } from "./services/downloaders/http.js";
import { downloadWithYtDlp } from "./services/downloaders/ytdlp.js";
import { downloadQuarkShare, getQuarkAccount, loginQuark as loginQuarkAccount } from "./services/downloaders/quark.js";
import { downloadBilibili, isBilibiliUrl } from "./services/downloaders/bilibili.js";
import { normalizeUsageRecord, summarizeJobUsage } from "./services/usage.js";
import { createBaiduQrLoginManager } from "./services/baidu-qr-login.js";

const require = createRequire(import.meta.url);
const archiverModule = require("archiver");
ensureDataDirs();

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/outputs", express.static(OUTPUT_DIR));
app.use("/temp-media", express.static(AUDIO_DIR, {
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-store");
  }
}));

const store = createStore({ sqliteFile: SQLITE_FILE, usersFile: USERS_FILE });
const jobs = new Map();
const queue = [];
let running = 0;
let maxConcurrency = APP_CONFIG.maxConcurrency;
let queuePaused = false;
let queuePauseReason = "";
let users = store.loadUsers();
const requireAuth = createRequireAuth(() => users);
loadJobsFromDatabase();

function loadJobsFromDatabase() {
  for (const job of store.loadJobs()) {
    jobs.set(job.id, job);
    if (job.status === "queued") queue.push(job);
  }
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    isAdmin: normalizeUsername(user.username) === "admin",
    provider: user.provider || "password",
    createdAt: user.createdAt
  };
}

function removeJobFiles(job) {
  removePath(path.join(DOWNLOAD_DIR, job.id));
  removePath(job.audioPath || path.join(AUDIO_DIR, `${job.id}.mp3`));
  for (const output of job.outputFiles || []) {
    const urlPath = decodeURIComponent(output.url || "").replace(/^\/outputs\//, "");
    if (urlPath) removePath(path.join(OUTPUT_DIR, path.basename(urlPath)));
  }
}

function removeJobRuntimeFiles(job) {
  removePath(path.join(DOWNLOAD_DIR, job.id));
  removePath(job.audioPath || path.join(AUDIO_DIR, `${job.id}.mp3`));
}

function removeDownloadedSource(job, sourcePath) {
  if (!sourcePath) return;
  const jobDownloadDir = path.resolve(DOWNLOAD_DIR, job.id);
  const resolved = path.resolve(sourcePath);
  if (!resolved.startsWith(`${jobDownloadDir}${path.sep}`)) return;
  removePath(resolved);
  const marker = `${resolved}.BaiduPCS-Go-downloading`;
  removePath(marker);
}

function isActiveJob(job) {
  return job?.status === "queued" || job?.status === "running";
}

function diskStats(targetPath = DATA_DIR) {
  const stats = fs.statfsSync(targetPath);
  const total = stats.blocks * stats.bsize;
  const free = stats.bavail * stats.bsize;
  return {
    total,
    free,
    used: total - free,
    freeRatio: total ? free / total : 0
  };
}

function runtimeStats() {
  const disk = diskStats(DATA_DIR);
  const memory = {
    total: os.totalmem(),
    free: os.freemem(),
    used: os.totalmem() - os.freemem(),
    freeRatio: os.totalmem() ? os.freemem() / os.totalmem() : 0
  };
  const allJobs = [...jobs.values()];
  return {
    config: {
      maxConcurrency,
      maxUserRunning: APP_CONFIG.maxUserRunning,
      maxUserQueued: APP_CONFIG.maxUserQueued,
      minFreeDiskBytes: APP_CONFIG.minFreeDiskBytes
    },
    cpu: {
      cores: os.cpus()?.length || 1,
      loadavg: os.loadavg()
    },
    memory,
    disk,
    queue: {
      paused: queuePaused,
      reason: queuePauseReason,
      queued: queue.length,
      running,
      totalJobs: allJobs.length,
      done: allJobs.filter((job) => job.status === "done").length,
      failed: allJobs.filter((job) => job.status === "error").length
    }
  };
}

function hasEnoughDiskForNextJob() {
  return diskStats(DATA_DIR).free >= APP_CONFIG.minFreeDiskBytes;
}

function userRunningCount(userId) {
  return [...jobs.values()].filter((job) => job.userId === userId && job.status === "running").length;
}

function userQueuedCount(userId) {
  return [...jobs.values()].filter((job) => job.userId === userId && job.status === "queued").length;
}

function jobReferenceTime(job) {
  return new Date(job.completedAt || job.updatedAt || job.createdAt || Date.now()).getTime();
}

function summarizeError(message) {
  const text = String(message || "");
  if (!text) return "";
  if (text.includes("BaiduPCS-Go") || text.includes("百度网盘下载")) {
    return text.length > 1200 ? `${text.slice(0, 1200)}...` : text;
  }
  const freeTier = text.includes("AllocationQuota.FreeTierOnly") || text.includes("free tier");
  if (freeTier) return "Qwen 免费额度已用完，且阿里云控制台开启了仅使用免费额度。请关闭该限制或换一个有额度的 AI 处理模型。";
  try {
    const jsonStart = text.indexOf("{");
    if (jsonStart >= 0) {
      const parsed = JSON.parse(text.slice(jsonStart));
      const taskStatus = parsed.output?.task_status;
      const taskMessage = parsed.output?.message || parsed.output?.results?.[0]?.message;
      if (taskStatus === "FAILED" || taskMessage) {
        return taskMessage ? `转写任务失败：${taskMessage}` : "转写任务失败，请检查链接是否可访问、音频是否有效，或稍后重试。";
      }
      return parsed.error?.message || text.slice(0, 240);
    }
  } catch {
    // Fall back to a compact raw message.
  }
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

function update(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  if (job.id && job.userId) store.saveJob(job);
}

function markStarted(job, step, progress) {
  update(job, {
    status: "running",
    step,
    progress,
    startedAt: job.startedAt || new Date().toISOString()
  });
}

function jobPhaseTotal(job) {
  const extraCount = Array.isArray(job.extraPrompts) ? job.extraPrompts.filter((item) => item.prompt?.trim()).length : 0;
  const hasSmartTitle = Array.isArray(job.extraPrompts) && job.extraPrompts.some((item) => item.prompt?.trim() && item.smartTitle);
  return 3 + extraCount + (hasSmartTitle ? 1 : 0);
}

function phaseProgressFromOverall(progress, start, end) {
  const value = Number(progress || 0);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(((value - start) / Math.max(1, end - start)) * 100)));
}

function updatePhase(job, phaseIndex, step, progress, stageProgress) {
  update(job, {
    step,
    progress,
    phaseIndex,
    phaseTotal: jobPhaseTotal(job),
    phaseProgress: Math.max(0, Math.min(100, Math.round(Number(stageProgress ?? progress ?? 0))))
  });
}

function markFinished(job, patch = {}) {
  const completedAt = new Date().toISOString();
  const started = job.startedAt ? new Date(job.startedAt).getTime() : new Date(job.createdAt).getTime();
  update(job, {
    ...patch,
    settings: scrubJobSettings(job.settings),
    completedAt,
    durationMs: Math.max(0, new Date(completedAt).getTime() - started)
  });
}

function scrubJobSettings(settings = {}) {
  if (!settings || typeof settings !== "object") return {};
  return {
    asrModel: settings.asrModel || "",
    qwenModel: settings.qwenModel || "",
    llmProvider: settings.llmProvider || "",
    llmBaseUrl: settings.llmBaseUrl || "",
    directUrlMode: settings.directUrlMode,
    publicBaseUrl: settings.publicBaseUrl || "",
    mediaUrlType: settings.mediaUrlType || "",
    netdiskTempDir: settings.netdiskTempDir || ""
  };
}

function createZipArchive(options) {
  if (typeof archiverModule === "function") return archiverModule("zip", options);
  if (typeof archiverModule.default === "function") return archiverModule.default("zip", options);
  if (typeof archiverModule.ZipArchive === "function") return new archiverModule.ZipArchive(options);
  throw new Error("当前 archiver 版本不支持 zip 打包");
}

function pauseQueue(reason) {
  queuePaused = true;
  queuePauseReason = reason || "队列已暂停";
}

function netdiskConfigDir(userId) {
  const dir = path.join(NETDISK_USERS_DIR, safeName(userId || "anonymous"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function netdiskEnv(userId) {
  return {
    ...process.env,
    BAIDUPCS_GO_CONFIG_DIR: netdiskConfigDir(userId)
  };
}

function prepareJobPcsEnv(job, outDir) {
  const sourceDir = netdiskConfigDir(job.userId);
  const jobConfigDir = path.join(outDir, ".pcs-config");
  removePath(jobConfigDir);
  fs.mkdirSync(jobConfigDir, { recursive: true });
  if (fs.existsSync(sourceDir)) {
    fs.cpSync(sourceDir, jobConfigDir, { recursive: true, force: true });
  }
  return {
    ...process.env,
    BAIDUPCS_GO_CONFIG_DIR: jobConfigDir
  };
}

function runPcsCommand(args, userId, opts = {}) {
  return runCommand("BaiduPCS-Go", args, { env: netdiskEnv(userId), ...opts });
}

async function loginBaiduCookies(userId, cookies) {
  const result = await runPcsCommand(["login", `-cookies=${String(cookies || "").trim()}`], userId, { timeoutMs: 20000 });
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

function redactSecret(text, secrets = []) {
  let output = String(text || "");
  for (const secret of secrets.filter(Boolean)) {
    output = output.replaceAll(String(secret), "******");
  }
  output = output.replace(/BDUSS=[^;\s]+/gi, "BDUSS=******");
  output = output.replace(/STOKEN=[^;\s]+/gi, "STOKEN=******");
  output = output.replace(/PTOKEN=[^;\s]+/gi, "PTOKEN=******");
  output = output.replace(/--?password[=\s]+[^\s]+/gi, "password=******");
  return output.trim();
}

async function getBaiduNetdiskAccount(userId) {
  const pcsPath = await runCommand(SHELL, ["-lc", "command -v BaiduPCS-Go"]).then((r) => r.stdout.trim()).catch(() => "");
  if (!pcsPath) return { provider: "baidu", installed: false, loggedIn: false, account: "", raw: "未安装 BaiduPCS-Go" };
  const result = await runPcsCommand(["who"], userId).catch((err) => ({ stdout: "", stderr: err.message }));
  const raw = `${result.stdout || ""}${result.stderr || ""}`.trim();
  const uid = raw.match(/uid:\s*(\d+)/i)?.[1] || "";
  const name = raw.match(/用户名:\s*([^,\n]+)/)?.[1]?.trim() || "";
  const apiStatus = uid && uid !== "0" ? await checkBaiduApiAccess(userId) : { ok: false, message: "" };
  return {
    provider: "baidu",
    installed: true,
    loggedIn: Boolean(uid && uid !== "0" && apiStatus.ok),
    uid,
    account: name,
    raw: apiStatus.ok || !apiStatus.message ? raw : `${raw}\n${apiStatus.message}`
  };
}

async function checkBaiduApiAccess(userId) {
  const userConfig = getPcsUserConfig(userId);
  const cookie = userConfig?.cookies || "";
  if (!cookie) return { ok: false, message: "百度网盘 Cookies 缺失，请重新登录。" };
  const params = new URLSearchParams({
    clienttype: "0",
    app_id: "250528",
    web: "1",
    order: "time",
    desc: "1",
    num: "1",
    page: "1",
    dir: "/"
  });
  try {
    const res = await fetch(`https://pan.baidu.com/api/list?${params.toString()}`, {
      headers: {
        Accept: "application/json, text/plain, */*",
        Cookie: cookie,
        Referer: "https://pan.baidu.com/disk/main?from=homeFlow",
        "User-Agent": userConfig.user_agent || "Mozilla/5.0",
        "X-Requested-With": "XMLHttpRequest"
      }
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.errno === 0) return { ok: true, message: "" };
    const message = data?.show_msg || data?.errmsg || `百度网盘文件接口不可用 errno=${data?.errno ?? "unknown"}`;
    return { ok: false, message: `${message}。请重新复制已登录百度网盘浏览器里的完整 Cookies。` };
  } catch (err) {
    return { ok: false, message: `百度网盘登录状态校验失败：${err.message || err}` };
  }
}

async function getNetdiskAccount(userId, provider = "baidu") {
  if (provider === "quark") return getQuarkAccount(store, userId);
  return getBaiduNetdiskAccount(userId);
}

function updateDownloadStats(job, patch = {}) {
  const progress = patch.progress ?? job.progress ?? 10;
  update(job, {
    phaseIndex: 1,
    phaseTotal: jobPhaseTotal(job),
    phaseProgress: patch.phaseProgress ?? phaseProgressFromOverall(progress, 10, 24),
    ...patch,
    step: patch.step || "下载视频"
  });
}

function publicJob(job) {
  const { settings, prompt, rawText, ...rest } = job;
  const usageSummary = Array.isArray(job.usageRecords)
    ? summarizeJobUsage(job.usageRecords)
    : job.usageSummary;
  return { ...rest, usageSummary, errorSummary: summarizeError(job.error) };
}

function recordUsage(job, record) {
  if (!job?.id || !job?.userId) return null;
  const usageRecord = normalizeUsageRecord(job, record);
  store.saveUsageRecord(usageRecord);
  const usageRecords = [...(job.usageRecords || []), usageRecord];
  update(job, {
    usageRecords,
    usageSummary: summarizeJobUsage(usageRecords)
  });
  return usageRecord;
}

function hasUsageRecord(job, type) {
  return (job.usageRecords || []).some((record) => record.type === type);
}

function recordAsrUsage(job, settings, durationSec, meta = {}) {
  const metricValue = Math.ceil(Number(durationSec || 0));
  if (!metricValue || hasUsageRecord(job, "asr")) return null;
  return recordUsage(job, {
    type: "asr",
    provider: "aliyun",
    model: settings.asrModel || "paraformer-v2",
    metricUnit: "second",
    metricValue,
    meta
  });
}

function parseBaiduLink(raw) {
  const matchedUrl = raw.match(/https?:\/\/[^\s]+/)?.[0] || raw.trim();
  let url = matchedUrl;
  let pwd = raw.match(/(?:提取码|密码|pwd|code)[:：=\s]*([A-Za-z0-9]{4})/i)?.[1] || "";
  try {
    const parsed = new URL(matchedUrl);
    pwd = pwd || parsed.searchParams.get("pwd") || "";
    if (parsed.searchParams.has("pwd")) {
      parsed.searchParams.delete("pwd");
      url = parsed.toString().replace(/\?$/, "");
    }
  } catch {
    // Keep the raw URL fallback.
  }
  return { url, pwd };
}

function getBaiduShareShortUrl(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/s\/([^/?#]+)/);
    return match?.[1]?.replace(/^1/, "") || "";
  } catch {
    return "";
  }
}

function getPcsUserConfig(userId) {
  const configPath = path.join(netdiskConfigDir(userId), "pcs_config.json");
  if (!fs.existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const activeUid = String(parsed.baidu_active_uid || "");
    const users = Array.isArray(parsed.baidu_user_list) ? parsed.baidu_user_list : [];
    return users.find((user) => String(user.uid || "") === activeUid) || users[0] || null;
  } catch {
    return null;
  }
}

async function fetchBaiduShareList(job, url, pwd, dir = "") {
  const shortUrl = getBaiduShareShortUrl(url);
  const userConfig = getPcsUserConfig(job.userId);
  let cookie = userConfig?.cookies || "";
  if (!shortUrl || !cookie) return null;

  async function requestList(activeCookie) {
    const params = new URLSearchParams({
      shorturl: shortUrl,
      root: dir ? "0" : "1",
      page: "1",
      num: "100"
    });
    if (dir) params.set("dir", dir);
    const res = await fetch(`https://pan.baidu.com/share/list?${params.toString()}`, {
      headers: {
        Accept: "application/json, text/plain, */*",
        Cookie: activeCookie,
        Referer: url,
        "User-Agent": userConfig.user_agent || "Mozilla/5.0",
        "X-Requested-With": "XMLHttpRequest"
      }
    });
    const data = await res.json().catch(() => null);
    return data ? { ...data, httpStatus: res.status } : { errno: -1, show_msg: `share/list 响应解析失败：HTTP ${res.status}` };
  }

  let data = await requestList(cookie);
  if (data?.errno === -9 && pwd) {
    const verify = await verifyBaiduSharePassword(shortUrl, url, pwd, userConfig, cookie);
    if (verify.cookie) {
      cookie = verify.cookie;
      data = await requestList(cookie);
    } else if (verify.data) {
      data = { ...verify.data, verifyFailed: true };
    }
  }
  return data;
}

async function verifyBaiduSharePassword(shortUrl, url, pwd, userConfig, cookie) {
  const verifyUrl = `https://pan.baidu.com/share/verify?channel=chunlei&clienttype=0&web=1&surl=${encodeURIComponent(shortUrl)}&t=${Date.now()}`;
  const res = await fetch(verifyUrl, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Cookie: cookie,
      Referer: url,
      "User-Agent": userConfig.user_agent || "Mozilla/5.0",
      "X-Requested-With": "XMLHttpRequest"
    },
    body: new URLSearchParams({ pwd, vcode: "", vcode_str: "" })
  });
  const data = await res.json().catch(() => null);
  const setCookie = res.headers.get("set-cookie") || "";
  const bdclnd = setCookie.match(/BDCLND=([^;]+)/)?.[1] || data?.randsk || "";
  if (!res.ok || !data || data.errno !== 0 || !bdclnd) return { data };
  const nextCookie = `${cookie.replace(/BDCLND=[^;]+;?\s*/i, "")}; BDCLND=${bdclnd}`;
  return { data, cookie: nextCookie };
}

function describeBaiduRootShare(shareList) {
  const items = Array.isArray(shareList?.list) ? shareList.list : [];
  const directMedia = items.find((entry) => String(entry.isdir) === "0" && pickMediaFile([entry.path || entry.server_filename || ""]));
  const hasDirectory = items.some((entry) => String(entry.isdir) === "1");
  return { directMedia, hasDirectory, items };
}

async function assertBaiduShareIsDirectMedia(job, url, pwd) {
  const shareList = await fetchBaiduShareList(job, url, pwd);
  const { directMedia, hasDirectory, items } = describeBaiduRootShare(shareList);
  if (directMedia?.path) return directMedia;
  if (hasDirectory) {
    throw new Error("当前百度网盘分享的是文件夹。只支持直接分享音视频文件转文字，请进入文件夹后分享具体的视频或音频文件。");
  }
  if (Array.isArray(items) && items.length > 0) {
    throw new Error("当前百度网盘分享中没有可处理的音视频文件。只支持直接分享 mp4、mov、m4a、mp3、wav 等文件。");
  }
  return null;
}

async function findShareMediaItem(job, url, pwd, dir = "", depth = 0) {
  if (depth > 0) return null;
  const shareList = await fetchBaiduShareList(job, url, pwd, dir);
  return describeBaiduRootShare(shareList).directMedia || null;
}

async function findShareMediaItemWithLog(job, url, pwd) {
  const item = await findShareMediaItem(job, url, pwd);
  if (!item) {
    const rootList = await fetchBaiduShareList(job, url, pwd).catch((err) => ({ error: err.message }));
    console.error("[netdisk-share-media-not-found]", {
      jobId: job.id,
      userId: job.userId,
      errno: rootList?.errno,
      showMsg: rootList?.show_msg || rootList?.error,
      count: Array.isArray(rootList?.list) ? rootList.list.length : 0,
      names: Array.isArray(rootList?.list) ? rootList.list.slice(0, 10).map((entry) => ({
        isdir: entry.isdir,
        path: entry.path,
        server_filename: entry.server_filename
      })) : []
    });
  }
  return item;
}

async function searchBaiduRealMediaPath(job, shareItem) {
  const userConfig = getPcsUserConfig(job.userId);
  const cookie = userConfig?.cookies || "";
  const fileName = String(shareItem?.server_filename || path.basename(shareItem?.path || "")).trim();
  if (!cookie || !fileName) return null;

  const params = new URLSearchParams({
    clienttype: "0",
    app_id: "250528",
    web: "1",
    recursion: "1",
    page: "1",
    num: "100",
    key: fileName
  });
  const res = await fetch(`https://pan.baidu.com/api/search?${params.toString()}`, {
    headers: {
      Accept: "application/json, text/plain, */*",
      Cookie: cookie,
      Referer: "https://pan.baidu.com/disk/main?from=homeFlow",
      "User-Agent": userConfig.user_agent || "Mozilla/5.0",
      "X-Requested-With": "XMLHttpRequest"
    }
  });
  const data = await res.json().catch(() => null);
  const items = Array.isArray(data?.list) ? data.list : [];
  const expectedSize = Number(shareItem?.size || 0);
  const media = items.find((entry) => {
    if (String(entry.isdir) !== "0") return false;
    if (!pickMediaFile([entry.path || entry.server_filename || ""])) return false;
    if (entry.server_filename !== fileName) return false;
    return !expectedSize || Number(entry.size || 0) === expectedSize;
  }) || items.find((entry) => {
    if (String(entry.isdir) !== "0") return false;
    if (!pickMediaFile([entry.path || entry.server_filename || ""])) return false;
    return entry.server_filename === fileName;
  });

  if (!media?.path) {
    console.error("[netdisk-real-path-not-found]", {
      jobId: job.id,
      userId: job.userId,
      fileName,
      expectedSize,
      errno: data?.errno,
      count: items.length,
      candidates: items.slice(0, 10).map((entry) => ({
        isdir: entry.isdir,
        path: entry.path,
        server_filename: entry.server_filename,
        size: entry.size
      }))
    });
    return null;
  }
  return media;
}

function isMediaFileUrl(link) {
  try {
    const url = new URL(link.trim());
    return /^https?:$/.test(url.protocol) && MEDIA_FILE_RE.test(url.pathname);
  } catch {
    return false;
  }
}

function existingMediaFile(dir) {
  const media = pickMediaFile(listFilesRecursive(dir));
  if (!media || !fs.existsSync(media)) return "";
  return fs.statSync(media).size > 0 ? media : "";
}

function adoptSavedMediaFromCommandOutput(commandOutput, outDir) {
  const savedPaths = [...String(commandOutput || "").matchAll(/保存位置:\s*(.+?)(?:\n|$)/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  for (const savedPath of savedPaths) {
    if (!path.isAbsolute(savedPath) || !fs.existsSync(savedPath)) continue;
    if (!pickMediaFile([savedPath])) continue;
    const current = path.resolve(savedPath);
    const targetDir = path.resolve(outDir);
    if (current.startsWith(`${targetDir}${path.sep}`)) return current;
    fs.mkdirSync(outDir, { recursive: true });
    const targetPath = path.join(outDir, path.basename(savedPath));
    if (fs.existsSync(targetPath)) removePath(targetPath);
    fs.renameSync(savedPath, targetPath);
    return targetPath;
  }
  return "";
}

async function waitForStableMediaFile(dir, job, timeoutMs = 15 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  let files = [];
  let candidate = "";
  let lastSize = -1;
  let stableChecks = 0;
  let lastTime = Date.now();
  let lastTotalBytes = 0;

  while (Date.now() < deadline) {
    files = listFilesRecursive(dir);
    const totalBytes = files.reduce((sum, file) => {
      try {
        return sum + fs.statSync(file).size;
      } catch {
        return sum;
      }
    }, 0);
    const now = Date.now();
    if (job && now - lastTime >= 3000) {
      const speed = (totalBytes - lastTotalBytes) / Math.max((now - lastTime) / 1000, 0.001);
      updateDownloadStats(job, {
        progress: Math.min(24, Math.max(job.progress || 10, 12)),
        downloadedBytes: totalBytes,
        downloadSpeed: speed > 0 ? `${formatBytes(speed)}/s` : job.downloadSpeed || "",
        step: totalBytes > 0 ? `下载视频 ${formatBytes(totalBytes)}` : "等待网盘下载文件"
      });
      lastTime = now;
      lastTotalBytes = totalBytes;
    }
    const video = pickMediaFile(files);
    if (video && fs.existsSync(video)) {
      const size = fs.statSync(video).size;
      if (video === candidate && size > 0 && size === lastSize) {
        stableChecks += 1;
        if (stableChecks >= 3) return { video, files };
      } else {
        candidate = video;
        lastSize = size;
        stableChecks = 0;
      }
    }
    await sleep(3000);
  }

  return { video: "", files };
}

function compactCommandOutput(result) {
  const text = `${result?.stdout || ""}\n${result?.stderr || ""}`.trim();
  return text.length > 1600 ? `${text.slice(-1600)}` : text;
}

function hasPcsFailure(output) {
  const text = String(output || "");
  if (!text.trim()) return false;
  return /(^|\n).*(失败|错误|error|failed|获取分享项元数据错误|链接地址或提取码非法)/i.test(text);
}

function isRecoverableShareTransferFailure(output) {
  return /获取分享项元数据错误|链接地址或提取码非法|文件重复|文件已存在|已存在/.test(String(output || ""));
}

function isLegacyDownloaderTemplate(template) {
  return !template || /BaiduPCS-Go\s+d\b/.test(template);
}

function netdiskTempDir(settings = {}) {
  const dir = String(settings.netdiskTempDir || DEFAULT_NETDISK_TEMP_DIR).trim();
  return dir.startsWith("/") ? dir : `/${dir}`;
}

async function preparePcsRemoteTempDir(job, pcsEnv, settings) {
  const remoteDir = netdiskTempDir(settings);
  await runCommand("BaiduPCS-Go", ["mkdir", remoteDir], { env: pcsEnv }).catch(() => {});
  await runCommand("BaiduPCS-Go", ["cd", remoteDir], { env: pcsEnv });
  update(job, { netdiskTempDir: remoteDir });
  return remoteDir;
}

async function runPcsDownloadPath(job, remotePath, outDir, pcsEnv = netdiskEnv(job.userId)) {
  return runCommand("BaiduPCS-Go", ["download", "--saveto", outDir, remotePath], {
    env: pcsEnv,
    onData: (text) => {
      const speed = parseSpeed(text);
      if (speed) updateDownloadStats(job, { downloadSpeed: speed, step: `下载视频 ${speed}` });
    }
  });
}

function pcsDownloadProgressHandler(job) {
  return (text) => {
    const speed = parseSpeed(text);
    if (speed) updateDownloadStats(job, { downloadSpeed: speed, step: `下载视频 ${speed}` });
  };
}

async function runPcsTransferDownload(job, url, pwd, pcsEnv, extraArgs = []) {
  const transferArgs = ["transfer", "--download", ...extraArgs, url];
  if (pwd) transferArgs.push(pwd);
  return runCommand("BaiduPCS-Go", transferArgs, {
    env: pcsEnv,
    onData: pcsDownloadProgressHandler(job)
  });
}

async function downloadWithTemplate(job, settings) {
  const { url, pwd } = parseBaiduLink(job.link);
  const outDir = path.join(DOWNLOAD_DIR, job.id);
  let commandOutput = "";
  fs.mkdirSync(outDir, { recursive: true });
  const existing = existingMediaFile(outDir);
  if (existing) {
    updateDownloadStats(job, { step: "复用已下载文件", progress: Math.max(job.progress || 10, 12) });
    return existing;
  }

  const netdiskProvider = detectNetdiskProvider(url);
  if (netdiskProvider && !netdiskProvider.supported) {
    throw new Error(unsupportedNetdiskMessage(netdiskProvider));
  }

  if (netdiskProvider?.id === "quark") {
    return downloadQuarkShare(job, job.link, outDir, { store, updateDownloadStats });
  }

  if (!netdiskProvider) {
    if (!isMediaFileUrl(url)) {
      if (isBilibiliUrl(url)) {
        try {
          return await downloadBilibili(job, url, outDir, updateDownloadStats);
        } catch (err) {
          throw new Error(`B 站视频解析失败：${err.message || err}`);
        }
      }
      const result = await downloadWithYtDlp(job, url, outDir, updateDownloadStats);
      commandOutput = compactCommandOutput(result);
      const pageMedia = await waitForStableMediaFile(outDir, job);
      if (pageMedia.video) return pageMedia.video;
      throw new Error(`视频页面解析或下载失败。请确认服务器已安装 yt-dlp，或换成真实音视频直链。\n${commandOutput}`);
    }
    const ext = path.extname(new URL(url).pathname) || ".mp4";
    return downloadHttp(url, path.join(outDir, `${safeName(job.title)}${ext}`), job, updateDownloadStats);
  }

  const template = settings.baiduDownloaderTemplate || 'BaiduPCS-Go d -savedir "{outDir}" "{url}"';
  if (isLegacyDownloaderTemplate(template)) {
    const account = await getNetdiskAccount(job.userId, "baidu");
    if (!account.loggedIn) {
      throw new Error("百度网盘未登录或登录态已失效。请到“模型配置 > 网盘账号登录”重新登录后再提交任务。");
    }
    await assertBaiduShareIsDirectMedia(job, url, pwd);
    const pcsEnv = prepareJobPcsEnv(job, outDir);
    await runCommand("BaiduPCS-Go", ["config", "set", "-savedir", outDir], { env: pcsEnv });
    await preparePcsRemoteTempDir(job, pcsEnv, settings);
    try {
      const transferResult = await runPcsTransferDownload(job, url, pwd, pcsEnv);
      commandOutput = compactCommandOutput(transferResult);
    } catch (err) {
      commandOutput = String(err.message || "");
      let recoveredByRename = false;
      if (/文件重复|文件已存在|已存在/.test(commandOutput)) {
        const shareItem = await findShareMediaItemWithLog(job, url, pwd);
        const realItem = shareItem ? await searchBaiduRealMediaPath(job, shareItem) : null;
        if (realItem?.path) {
          updateDownloadStats(job, { step: "文件已在网盘，定位真实路径下载", progress: 12 });
          try {
            const fallbackResult = await runPcsDownloadPath(job, realItem.path, outDir, pcsEnv);
            commandOutput = compactCommandOutput(fallbackResult);
            recoveredByRename = Boolean(existingMediaFile(outDir));
            if (!recoveredByRename) {
              commandOutput = `${commandOutput}\n真实路径下载未生成可处理的音视频文件。`.trim();
            }
          } catch (downloadErr) {
            commandOutput = `${commandOutput}\n真实路径下载失败：${downloadErr.message || downloadErr}`.trim();
          }
        }
        if (!recoveredByRename) {
          updateDownloadStats(job, { step: "文件重复，随机改名后下载", progress: 12 });
          const retryResult = await runPcsTransferDownload(job, url, pwd, pcsEnv, ["--rname"]);
          commandOutput = compactCommandOutput(retryResult);
          recoveredByRename = true;
        }
      }
      if (!recoveredByRename && !isRecoverableShareTransferFailure(commandOutput)) {
        throw err;
      }
    }
  } else {
    const rendered = template
      .replaceAll("{url}", url)
      .replaceAll("{pwd}", pwd)
      .replaceAll("{outDir}", outDir);
    const result = await runCommand(SHELL, ["-lc", rendered], {
      env: netdiskEnv(job.userId),
      onData: (text) => {
        const speed = parseSpeed(text);
        if (speed) updateDownloadStats(job, { downloadSpeed: speed, step: `下载视频 ${speed}` });
      }
    });
    commandOutput = compactCommandOutput(result);
  }

  if (hasPcsFailure(commandOutput)) {
    if (isLegacyDownloaderTemplate(template) && isRecoverableShareTransferFailure(commandOutput)) {
      const item = await findShareMediaItemWithLog(job, url, pwd);
      const realItem = item ? await searchBaiduRealMediaPath(job, item) : null;
      if (realItem?.path) {
        const duplicate = /文件重复|文件已存在|已存在/.test(commandOutput);
        updateDownloadStats(job, { step: duplicate ? "文件已在网盘，定位真实路径下载" : "分享已在当前网盘，定位真实路径下载", progress: 12 });
        const fallbackResult = await runPcsDownloadPath(job, realItem.path, outDir, prepareJobPcsEnv(job, outDir));
        commandOutput = `${commandOutput}\n${compactCommandOutput(fallbackResult)}`.trim();
      } else {
        throw new Error(`百度网盘下载命令失败。\n${commandOutput}`);
      }
    } else {
      throw new Error(`百度网盘下载命令失败。\n${commandOutput}`);
    }
  }

  const { video, files } = await waitForStableMediaFile(outDir, job, 30 * 1000);
  if (!video) {
    const adopted = adoptSavedMediaFromCommandOutput(commandOutput, outDir);
    if (adopted) return adopted;
  }
  if (!video) {
    console.error("[netdisk-download-empty]", {
      jobId: job.id,
      userId: job.userId,
      outDir,
      files,
      commandOutput
    });
    throw new Error(`百度网盘下载完成后没有找到可处理的音视频文件。请确认分享链接里包含视频，或检查网盘登录状态。\n${commandOutput}`);
  }
  return video;
}

function isCloudDriveLink(link) {
  return CLOUD_DRIVE_RE.test(link);
}

function isDirectMediaUrl(link) {
  return isMediaFileUrl(link) && !isCloudDriveLink(link);
}

function llmUsageFromResponse(result) {
  const usage = result?.usage || {};
  return {
    inputTokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
    outputTokens: Number(usage.completion_tokens || usage.output_tokens || 0),
    totalTokens: Number(usage.total_tokens || 0)
  };
}

function outputFilePath(file) {
  const urlPath = decodeURIComponent(file?.url || "").replace(/^\/outputs\//, "");
  if (!urlPath) return "";
  return path.join(OUTPUT_DIR, path.basename(urlPath));
}

function renameOutputFiles(job, files, baseTitle) {
  const finalBase = String(baseTitle || "").trim();
  if (!finalBase || !files.length) return files;
  const used = new Set();
  return files.map((file) => {
    const oldPath = outputFilePath(file);
    if (!oldPath || !fs.existsSync(oldPath)) return file;
    const safeBase = safeName(finalBase);
    const safeLabel = safeName(file.label || "Word");
    let fileName = `${String(job.order + 1).padStart(2, "0")}_${safeBase}_${safeLabel}.docx`;
    let nextPath = path.join(OUTPUT_DIR, fileName);
    let count = 2;
    while ((used.has(fileName) || (fs.existsSync(nextPath) && nextPath !== oldPath)) && count < 100) {
      fileName = `${String(job.order + 1).padStart(2, "0")}_${safeBase}_${safeLabel}_${count}.docx`;
      nextPath = path.join(OUTPUT_DIR, fileName);
      count += 1;
    }
    used.add(fileName);
    if (nextPath !== oldPath) fs.renameSync(oldPath, nextPath);
    return { ...file, url: `/outputs/${encodeURIComponent(fileName)}` };
  });
}

function extraPromptEntries(job) {
  return Array.isArray(job.extraPrompts)
    ? job.extraPrompts
      .map((item, index) => ({ ...item, index }))
      .filter((item) => item.prompt?.trim())
    : [];
}

function fileExistsForLabel(files = [], label) {
  const target = String(label || "").trim();
  return files.some((file) => String(file?.label || "").trim() === target && fs.existsSync(outputFilePath(file)));
}

async function generateExtraFilesForJob(job, rawText, entries, options = {}) {
  const settings = options.settingsOverride || job.settings || {};
  const files = Array.isArray(job.outputFiles) ? [...job.outputFiles] : [];
  const extraErrors = [];
  const completedIndexes = new Set(job.completedExtraIndexes || []);
  const failedIndexes = [];
  const generatedExtraOutputs = [];
  const totalExtras = extraPromptEntries(job).length;

  for (let localIndex = 0; localIndex < entries.length; localIndex += 1) {
    const item = entries[localIndex];
    const docLabel = item.title || `额外文档 ${item.index + 1}`;
    if (options.skipExisting && completedIndexes.has(item.index) && fileExistsForLabel(files, docLabel)) continue;
    updatePhase(
      job,
      4 + item.index,
      options.retry ? `重试额外文档 ${localIndex + 1}/${entries.length}` : `生成额外文档 ${item.index + 1}/${totalExtras}`,
      82 + Math.round((item.index / Math.max(totalExtras, 1)) * 14),
      15
    );
    try {
      const result = await polishTextDetailed(rawText, item.prompt, settings);
      const llmUsage = llmUsageFromResponse(result);
      const totalTokens = llmUsage.totalTokens || llmUsage.inputTokens + llmUsage.outputTokens;
      if (totalTokens || llmUsage.inputTokens || llmUsage.outputTokens) {
        recordUsage(job, {
          type: "llm",
          provider: settings.llmProvider || "llm",
          model: result.model || settings.qwenModel || "",
          metricUnit: "token",
          metricValue: totalTokens,
          inputTokens: llmUsage.inputTokens,
          outputTokens: llmUsage.outputTokens,
          totalTokens,
          meta: {
            extraTitle: docLabel,
            promptPreview: String(item.prompt || "").slice(0, 500),
            retry: Boolean(options.retry)
          }
        });
      }
      const output = await writeWord(job, result.content, {
        suffix: docLabel,
        title: `${job.title} - ${docLabel}`
      });
      const fileEntry = { label: docLabel, url: `/outputs/${encodeURIComponent(output.fileName)}` };
      const existingIndex = files.findIndex((file) => String(file.label || "") === docLabel);
      if (existingIndex >= 0) files[existingIndex] = fileEntry;
      else files.push(fileEntry);
      generatedExtraOutputs.push({ label: docLabel, content: result.content });
      completedIndexes.add(item.index);
      update(job, {
        phaseProgress: 100,
        outputFiles: files,
        outputUrl: files[0]?.url,
        completedExtraIndexes: [...completedIndexes],
        failedExtraIndexes: failedIndexes,
        retryableExtraFailure: false
      });
    } catch (err) {
      failedIndexes.push(item.index);
      extraErrors.push(`${docLabel}：${err.message}`);
    }
  }

  return {
    files,
    extraErrors,
    completedExtraIndexes: [...completedIndexes],
    failedExtraIndexes: failedIndexes,
    generatedExtraOutputs
  };
}

async function smartRenameExtraOutputsIfNeeded(job, rawText, generatedExtraOutputs, optionalWarnings, settingsOverride = null) {
  const extraPrompts = extraPromptEntries(job);
  const shouldSmartNameOutputs = extraPrompts.some((item) => item.smartTitle);
  if (!shouldSmartNameOutputs || !generatedExtraOutputs.length) return job.outputFiles || [];
  const settings = settingsOverride || job.settings || {};
  const namePhaseIndex = 4 + extraPrompts.length;
  updatePhase(job, namePhaseIndex, "生成统一文件名", 97, 20);
  try {
    const titleResult = await generateDocumentTitleDetailed(rawText, generatedExtraOutputs, settings);
    const finalOutputBaseTitle = titleResult.title;
    if (finalOutputBaseTitle) update(job, { outputBaseTitle: finalOutputBaseTitle });
    const llmUsage = llmUsageFromResponse(titleResult);
    const totalTokens = llmUsage.totalTokens || llmUsage.inputTokens + llmUsage.outputTokens;
    if (totalTokens || llmUsage.inputTokens || llmUsage.outputTokens) {
      recordUsage(job, {
        type: "llm",
        provider: settings.llmProvider || "llm",
        model: titleResult.model || settings.qwenModel || "",
        metricUnit: "token",
        metricValue: totalTokens,
        inputTokens: llmUsage.inputTokens,
        outputTokens: llmUsage.outputTokens,
        totalTokens,
        meta: { purpose: "output_title" }
      });
    }
    update(job, { phaseProgress: 100 });
    if (finalOutputBaseTitle) {
      const finalFiles = renameOutputFiles(job, job.outputFiles || [], finalOutputBaseTitle);
      update(job, { outputBaseTitle: finalOutputBaseTitle, outputFiles: finalFiles, outputUrl: finalFiles[0]?.url });
      return finalFiles;
    }
  } catch (err) {
    optionalWarnings.push(`智能命名失败：${err.message}`);
  }
  return job.outputFiles || [];
}

async function processJob(job) {
  const settings = job.settings;
  let mediaUrl = job.link.trim();
  let audioDurationSec = 0;
  let asrUsageMeta = null;
  const extraPrompts = extraPromptEntries(job);
  if (settings.directUrlMode !== false && isDirectMediaUrl(mediaUrl)) {
    markStarted(job, "直链提交转写服务", 35);
    updatePhase(job, 1, "直链提交转写服务", 35, 40);
    audioDurationSec = await probeDurationSec(mediaUrl, settings);
    if (audioDurationSec > 0) {
      update(job, { audioDurationSec });
      asrUsageMeta = { source: "ffprobe_direct_url" };
    }
  } else {
    markStarted(job, "下载视频", 10);
    update(job, { phaseIndex: 1, phaseTotal: jobPhaseTotal(job), phaseProgress: 0 });
    const videoPath = await downloadWithTemplate(job, settings);
    updatePhase(job, 1, "抽取音频", 25, 80);
    update(job, { downloadSpeed: "" });
    const audioPath = await extractAudio(videoPath, settings, job, update);
    audioDurationSec = await probeDurationSec(audioPath, settings);
    if (audioDurationSec > 0) {
      update(job, { audioDurationSec });
      asrUsageMeta = { source: "ffprobe" };
    }
    removeDownloadedSource(job, videoPath);
    updatePhase(job, 1, hasOssConfig(settings) ? "上传 OSS" : "生成临时访问 URL", 40, 90);
    mediaUrl = await resolveAsrMediaUrl(audioPath, settings, job, update);
    updatePhase(job, 1, "提交转写服务", 50, 100);
  }
  const taskId = await submitAsr(mediaUrl, settings);
  updatePhase(job, 2, "等待转写结果", 65, 35);
  update(job, { asrTaskId: taskId });
  const transcript = await pollAsr(taskId, settings);
  if (audioDurationSec > 0) {
    recordAsrUsage(job, settings, audioDurationSec, asrUsageMeta || {});
  }
  const rawText = transcriptToText(transcript);
  update(job, { rawText });
  updatePhase(job, 3, "生成转写原文", 78, 70);
  const files = [];
  const rawOutput = await writeWord(job, rawText, { suffix: "原文", title: `${job.title} - 原文` });
  files.push({ label: "原文", url: `/outputs/${encodeURIComponent(rawOutput.fileName)}` });
  update(job, { phaseProgress: 100 });
  update(job, {
    outputFiles: files,
    outputUrl: files[0]?.url,
    completedExtraIndexes: [],
    failedExtraIndexes: [],
    retryableExtraFailure: false
  });

  const optionalWarnings = [];
  const extraResult = await generateExtraFilesForJob(job, rawText, extraPrompts);
  if (!extraResult.extraErrors.length) {
    await smartRenameExtraOutputsIfNeeded(job, rawText, extraResult.generatedExtraOutputs, optionalWarnings);
  }
  const finalFiles = job.outputFiles || extraResult.files;

  markFinished(job, {
    status: "done",
    step: extraResult.extraErrors.length ? "完成，部分额外文件失败" : "完成",
    progress: 100,
    phaseIndex: jobPhaseTotal(job),
    phaseTotal: jobPhaseTotal(job),
    phaseProgress: 100,
    outputFiles: finalFiles,
    outputUrl: finalFiles[0]?.url,
    error: [...extraResult.extraErrors, ...optionalWarnings].join("\n") || undefined,
    completedExtraIndexes: extraResult.completedExtraIndexes,
    failedExtraIndexes: extraResult.failedExtraIndexes,
    retryableExtraFailure: extraResult.extraErrors.length > 0
  });
  if (extraResult.extraErrors.length) {
    pauseQueue(summarizeError(extraResult.extraErrors[0]) || "额外文件生成失败，已暂停后续任务。");
  } else {
    removeJobRuntimeFiles(job);
  }
}

async function retryJobExtraDocs(job, retrySettings = {}) {
  if (!job?.rawText) throw new Error("该任务缺少原文缓存，无法只重试额外文件。请重新提交任务。");
  if (job.status === "running" || job.status === "queued") throw new Error("任务正在处理，不能重复重试。");
  const allExtraEntries = extraPromptEntries(job);
  const failedSet = new Set(Array.isArray(job.failedExtraIndexes) ? job.failedExtraIndexes : []);
  const retryEntries = allExtraEntries.filter((item) => failedSet.has(item.index));
  if (!retryEntries.length) throw new Error("没有可重试的失败额外文件。");
  const settingsOverride = Object.keys(retrySettings || {}).length
    ? { ...(job.settings || {}), ...retrySettings }
    : null;

  removeJobRuntimeFiles(job);
  markStarted(job, "重试失败的额外文件", Math.max(82, Number(job.progress || 0)));
  update(job, { error: "", retryableExtraFailure: false });
  const optionalWarnings = [];
  const extraResult = await generateExtraFilesForJob(job, job.rawText, retryEntries, {
    retry: true,
    skipExisting: true,
    settingsOverride
  });
  if (!extraResult.extraErrors.length) {
    await smartRenameExtraOutputsIfNeeded(job, job.rawText, extraResult.generatedExtraOutputs, optionalWarnings, settingsOverride);
  }
  const remainingFailed = extraResult.failedExtraIndexes;
  markFinished(job, {
    status: "done",
    step: remainingFailed.length ? "完成，部分额外文件失败" : "完成",
    progress: 100,
    phaseIndex: jobPhaseTotal(job),
    phaseTotal: jobPhaseTotal(job),
    phaseProgress: 100,
    outputFiles: job.outputFiles || extraResult.files,
    outputUrl: (job.outputFiles || extraResult.files)[0]?.url,
    error: [...extraResult.extraErrors, ...optionalWarnings].join("\n") || undefined,
    completedExtraIndexes: extraResult.completedExtraIndexes,
    failedExtraIndexes: remainingFailed,
    retryableExtraFailure: remainingFailed.length > 0
  });
  if (remainingFailed.length) {
    pauseQueue(summarizeError(extraResult.extraErrors[0]) || "额外文件生成失败，已暂停后续任务。");
  } else if (queuePaused) {
    queuePaused = false;
    queuePauseReason = "";
    pumpQueue();
  }
}

function requeueJob(job, settings = {}) {
  if (!job || job.status === "running" || job.status === "queued") throw new Error("任务正在处理，不能重复重试。");
  removeJobRuntimeFiles(job);
  update(job, {
    settings: { ...(job.settings || {}), ...settings },
    status: "queued",
    step: "排队中",
    progress: 0,
    phaseIndex: 0,
    phaseProgress: 0,
    error: "",
    retryableExtraFailure: false,
    failedExtraIndexes: [],
    completedExtraIndexes: [],
    downloadSpeed: "",
    downloadedBytes: 0,
    downloadTotalBytes: 0,
    mediaUrl: "",
    mediaUrlType: "",
    audioPath: "",
    audioDurationSec: 0,
    asrTaskId: ""
  });
  queue.push(job);
  pumpQueue();
}

function pumpQueue() {
  if (queuePaused) return;
  if (!hasEnoughDiskForNextJob()) {
    pauseQueue(`磁盘剩余空间不足 ${Math.round(APP_CONFIG.minFreeDiskBytes / GIB)}GB，已暂停新任务。请清理缓存后继续。`);
    return;
  }
  while (running < maxConcurrency && queue.length) {
    const index = queue.findIndex((item) => userRunningCount(item.userId) < APP_CONFIG.maxUserRunning);
    if (index < 0) return;
    const [job] = queue.splice(index, 1);
    running += 1;
    processJob(job)
      .catch((err) => markFinished(job, { status: "error", step: "失败", error: err.message, progress: job.progress || 0 }))
      .finally(() => {
        running -= 1;
        pumpQueue();
      });
  }
}

function clearCompletedCache() {
  const now = Date.now();
  for (const job of [...jobs.values()]) {
    if (isActiveJob(job)) continue;
    if (job.status === "done") {
      removeJobRuntimeFiles(job);
      continue;
    }
    if (job.status === "error" && now - jobReferenceTime(job) > APP_CONFIG.cleanupIntervalMs) {
      removeJobRuntimeFiles(job);
      update(job, { cacheExpired: true });
    }
  }

  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

function scheduleDailyCleanup() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  setTimeout(() => {
    clearCompletedCache();
    setInterval(clearCompletedCache, 24 * 60 * 60 * 1000);
  }, next.getTime() - now.getTime());
}

scheduleDailyCleanup();
pumpQueue();

const baiduQrLogin = createBaiduQrLoginManager({
  checkBaiduApiAccess,
  getNetdiskAccount,
  loginBaiduCookies
});

registerRoutes(app, {
  baiduQrLogin,
  createZipArchive,
  getNetdiskAccount,
  hasEnoughDiskForNextJob,
  jobs,
  loginQuark(userId, cookies) {
    return loginQuarkAccount(store, userId, cookies);
  },
  publicJob,
  publicUser,
  pumpQueue,
  queue,
  redactSecret,
  removeJobFiles,
  requireAuth,
  resumeQueue() {
    queuePaused = false;
    queuePauseReason = "";
    pumpQueue();
  },
  retryJobExtras(job, retrySettings = {}) {
    if (job.status === "running" || job.status === "queued") throw new Error("任务正在处理，不能重复重试。");
    running += 1;
    retryJobExtraDocs(job, retrySettings)
      .catch((err) => markFinished(job, {
        status: "done",
        step: "完成，部分额外文件失败",
        error: err.message,
        retryableExtraFailure: true,
        progress: 100,
        phaseProgress: 100
      }))
      .finally(() => {
        running -= 1;
        pumpQueue();
      });
  },
  retryJob(job, settings = {}) {
    requeueJob(job, settings);
  },
  runCommand,
  runPcsCommand,
  runtimeStats,
  setMaxConcurrency(value) {
    maxConcurrency = value;
  },
  store,
  userQueuedCount,
  userRunningCount,
  users
});

registerMcpRoutes(app, {
  baiduQrLogin,
  getNetdiskAccount,
  hasEnoughDiskForNextJob,
  jobs,
  publicJob,
  pumpQueue,
  queue,
  removeJobFiles,
  retryJob(job, settings = {}) {
    requeueJob(job, settings);
  },
  retryJobExtras(job, retrySettings = {}) {
    if (job.status === "running" || job.status === "queued") throw new Error("任务正在处理，不能重复重试。");
    running += 1;
    retryJobExtraDocs(job, retrySettings)
      .catch((err) => markFinished(job, {
        status: "done",
        step: "完成，部分额外文件失败",
        error: err.message,
        retryableExtraFailure: true,
        progress: 100,
        phaseProgress: 100
      }))
      .finally(() => {
        running -= 1;
        pumpQueue();
      });
  },
  runCommand,
  runtimeStats,
  setMaxConcurrency(value) {
    maxConcurrency = value;
  },
  store,
  userQueuedCount,
  userRunningCount,
  users
});

if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR, {
    etag: false,
    maxAge: 0,
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-store");
    }
  }));
}

app.use((_req, res, next) => {
  const indexPath = path.join(DIST_DIR, "index.html");
  if (!fs.existsSync(indexPath)) return next();
  res.sendFile(indexPath);
});

function markRunningJobsInterrupted(reason) {
  for (const job of jobs.values()) {
    if (job.status !== "running") continue;
    markFinished(job, {
      status: "error",
      step: "服务重启后暂停",
      error: reason,
      progress: job.progress || 0
    });
  }
}

const port = Number(process.env.PORT || 5174);
const server = app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down`);
  markRunningJobsInterrupted("服务正在重启，当前任务已暂停。请重新提交或删除任务。");
  baiduQrLogin.closeAll().finally(() => server.close(() => {
    store.close();
    process.exit(0);
  }));
  setTimeout(() => process.exit(0), 8000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
