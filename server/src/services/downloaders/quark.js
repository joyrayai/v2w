import fs from "node:fs";
import path from "node:path";
import { MEDIA_FILE_RE } from "../../config.js";
import { formatBytes, pickMediaFile, safeName, sleep } from "../../utils.js";
import { downloadHttp } from "./http.js";

const QUARK_BASE = "https://drive-pc.quark.cn/1/clouddrive";
const QUARK_DRIVE_BASE = "https://drive.quark.cn/1/clouddrive";
const QUARK_REFERER = "https://pan.quark.cn/";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";
const CLIENT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.56 Chrome/100.0.4896.160 Electron/18.3.5.12 Safari/537.36 Channel/pckk_other_ch";
const TEMP_FOLDER_NAME = "视频转Word临时文件";

function looksLikeQuarkCookies(cookies) {
  return /__pus=|__puus=|__kp=|kps=|sign=|vcode=/i.test(String(cookies || ""));
}

function isQuarkDir(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function nowParams(extra = {}) {
  return new URLSearchParams({
    pr: "ucpro",
    fr: "pc",
    uc_param_str: "",
    __dt: String(600 + Math.floor(Math.random() * 9400)),
    __t: String(Date.now()),
    ...extra
  });
}

function quarkHeaders(cookies, userAgent = BROWSER_UA) {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Content-Type": "application/json",
    Cookie: cookies,
    Origin: "https://pan.quark.cn",
    Referer: QUARK_REFERER,
    "User-Agent": userAgent
  };
}

async function quarkJson(url, { cookies, method = "GET", body, userAgent } = {}) {
  const res = await fetch(url, {
    method,
    headers: quarkHeaders(cookies, userAgent),
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    throw new Error(`夸克接口请求失败：HTTP ${res.status}`);
  }
  return data;
}

function assertQuarkOk(data, fallback) {
  const ok = data?.status === 200 || data?.code === 0 || data?.message === "ok";
  if (!ok) throw new Error(data?.message || data?.error_msg || fallback);
  return data;
}

export function parseQuarkLink(raw) {
  const url = String(raw || "").match(/https?:\/\/[^\s]+/)?.[0] || String(raw || "").trim();
  let pwdId = "";
  let passcode = String(raw || "").match(/(?:提取码|密码|pwd|code|passcode)[:：=\s]*([A-Za-z0-9]{4})/i)?.[1] || "";
  try {
    const parsed = new URL(url);
    pwdId = parsed.pathname.match(/\/s\/([^/?#]+)/)?.[1] || "";
    passcode = parsed.searchParams.get("pwd") || parsed.searchParams.get("password") || passcode;
  } catch {
    // Keep regex parsed values.
  }
  return { url, pwdId, passcode };
}

async function inspectQuarkCookies(cookies, savedAccount = "") {
  const accountApis = [
    "https://pan.quark.cn/account/info?fr=pc&platform=pc",
    `${QUARK_BASE}/member?${nowParams().toString()}`,
    `${QUARK_BASE}/capacity/growth/info?${nowParams().toString()}`
  ];
  let lastError = "";
  for (const api of accountApis) {
    try {
      const data = await quarkJson(api, { cookies });
      const nickname = data?.data?.nickname || data?.data?.member?.nickname || data?.data?.user_info?.nickname || savedAccount || "";
      return {
        provider: "quark",
        installed: true,
        loggedIn: Boolean(data?.data || nickname),
        account: nickname,
        raw: data?.message || "ok"
      };
    } catch (err) {
      lastError = err.message || "夸克登录态校验失败";
    }
  }

  if (looksLikeQuarkCookies(cookies)) {
    return {
      provider: "quark",
      installed: true,
      loggedIn: true,
      account: savedAccount || "已保存 Cookies",
      raw: "已保存夸克 Cookies，下载任务会继续校验分享访问权限。"
    };
  }

  return {
    provider: "quark",
    installed: true,
    loggedIn: false,
    account: savedAccount || "",
    raw: lastError || "夸克登录态校验失败"
  };
}

export async function getQuarkAccount(store, userId) {
  const saved = store.getNetdiskAccount(userId, "quark");
  if (!saved?.cookies) {
    return { provider: "quark", installed: true, loggedIn: false, account: "", raw: "未登录夸克网盘" };
  }
  return inspectQuarkCookies(saved.cookies, saved.account || "");
}

export async function loginQuark(store, userId, cookies) {
  const normalized = String(cookies || "").trim();
  if (!normalized) throw new Error("请填写夸克网盘 Cookies。");
  const account = await inspectQuarkCookies(normalized);
  if (!account.loggedIn) {
    throw new Error(`夸克网盘登录失败：${account.raw || "请确认 Cookies 中包含有效登录态。"}`);
  }
  store.saveNetdiskAccount(userId, "quark", {
    cookies: normalized,
    account: account.account,
    updatedAt: new Date().toISOString()
  });
  return account;
}

async function getShareToken(cookies, pwdId, passcode) {
  const api = `${QUARK_BASE}/share/sharepage/token?${nowParams().toString()}`;
  const data = assertQuarkOk(await quarkJson(api, {
    cookies,
    method: "POST",
    body: { pwd_id: pwdId, passcode: passcode || "" }
  }), "夸克分享验证失败，请检查链接或提取码。");
  const stoken = data?.data?.stoken;
  if (!stoken) throw new Error(data?.message || "夸克分享验证失败：没有返回 stoken。");
  return stoken;
}

async function getShareDetail(cookies, pwdId, stoken, pdirFid = "0", page = 1) {
  const params = nowParams({
    pwd_id: pwdId,
    stoken,
    pdir_fid: pdirFid,
    force: "0",
    _page: String(page),
    _size: "50",
    _sort: "file_type:asc,updated_at:desc"
  });
  const data = assertQuarkOk(await quarkJson(`${QUARK_BASE}/share/sharepage/detail?${params.toString()}`, { cookies }), "夸克分享详情读取失败。");
  return data;
}

async function listShareFiles(cookies, pwdId, stoken, pdirFid = "0", depth = 0) {
  if (depth > 4) return [];
  const files = [];
  let page = 1;
  while (page <= 20) {
    const data = await getShareDetail(cookies, pwdId, stoken, pdirFid, page);
    const items = Array.isArray(data?.data?.list) ? data.data.list : [];
    for (const item of items) {
      const normalized = {
        fid: item.fid,
        fileName: item.file_name,
        fileType: item.file_type,
        dir: isQuarkDir(item.dir),
        pdirFid: item.pdir_fid,
        shareFidToken: item.share_fid_token || item.fid_token,
        size: Number(item.size || 0),
        raw: item
      };
      files.push(normalized);
      if (normalized.dir && normalized.fid) {
        files.push(...await listShareFiles(cookies, pwdId, stoken, normalized.fid, depth + 1));
      }
    }
    const total = Number(data?.metadata?._total || items.length);
    const size = Number(data?.metadata?._size || 50);
    const current = Number(data?.metadata?._page || page);
    if (!items.length || size * current >= total) break;
    page += 1;
  }
  return files;
}

function pickQuarkMedia(files) {
  return files.find((file) => !file.dir && MEDIA_FILE_RE.test(file.fileName || "")) || null;
}

async function listDriveFiles(cookies, pdirFid = "0") {
  const params = nowParams({
    pdir_fid: pdirFid,
    _page: "1",
    _size: "100",
    _fetch_total: "true",
    _fetch_sub_dirs: "1",
    _sort: "file_type:asc,updated_at:desc"
  });
  const data = assertQuarkOk(await quarkJson(`${QUARK_BASE}/file/sort?${params.toString()}`, { cookies }), "夸克网盘目录读取失败。");
  return Array.isArray(data?.data?.list) ? data.data.list : [];
}

async function ensureQuarkTempFolder(cookies) {
  const rootFiles = await listDriveFiles(cookies, "0").catch(() => []);
  const existing = rootFiles.find((item) => isQuarkDir(item?.dir) && item.file_name === TEMP_FOLDER_NAME);
  if (existing?.fid) return existing.fid;
  const api = `${QUARK_BASE}/file?${nowParams().toString()}`;
  const data = await quarkJson(api, {
    cookies,
    method: "POST",
    body: {
      pdir_fid: "0",
      file_name: TEMP_FOLDER_NAME,
      dir_path: "",
      dir_init_lock: false
    }
  });
  if (data?.data?.fid) return data.data.fid;
  const refreshed = await listDriveFiles(cookies, "0").catch(() => []);
  return refreshed.find((item) => isQuarkDir(item?.dir) && item.file_name === TEMP_FOLDER_NAME)?.fid || "0";
}

async function saveShareFile(cookies, pwdId, stoken, file, targetFid) {
  const api = `${QUARK_DRIVE_BASE}/share/sharepage/save?${nowParams().toString()}`;
  const data = assertQuarkOk(await quarkJson(api, {
    cookies,
    method: "POST",
    body: {
      fid_list: [file.fid],
      fid_token_list: [file.shareFidToken],
      to_pdir_fid: targetFid || "0",
      pwd_id: pwdId,
      stoken,
      pdir_fid: file.pdirFid || "0",
      scene: "link"
    }
  }), "夸克分享文件转存失败。");
  const taskId = data?.data?.task_id;
  if (!taskId) throw new Error(data?.message || "夸克分享文件转存失败：没有返回任务 ID。");
  return taskId;
}

function extractSavedFids(taskData) {
  const fids = new Set();
  const preferred = taskData?.save_as?.save_as_top_fids
    || taskData?.save_as_top_fids
    || taskData?.file_fids
    || taskData?.fids;
  if (Array.isArray(preferred)) {
    for (const fid of preferred) {
      if (typeof fid === "string" && fid.length >= 12) fids.add(fid);
    }
  }
  const walk = (value, key = "") => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key);
      return;
    }
    if (value && typeof value === "object") {
      for (const [childKey, childValue] of Object.entries(value)) walk(childValue, childKey);
      return;
    }
    if (typeof value === "string" && /^(fid|file_id)$/i.test(key) && value.length >= 12) {
      fids.add(value);
    }
  };
  walk(taskData);
  return [...fids];
}

async function waitForSaveTask(cookies, taskId) {
  for (let retry = 0; retry < 60; retry += 1) {
    await sleep(1000);
    const params = nowParams({ task_id: taskId, retry_index: String(retry) });
    const data = assertQuarkOk(await quarkJson(`${QUARK_BASE}/task?${params.toString()}`, { cookies }), "夸克转存任务查询失败。");
    const status = Number(data?.data?.status ?? data?.data?.task_status);
    const fids = extractSavedFids(data?.data || {});
    if (status === 2 || (Number.isNaN(status) && fids.length > 0)) {
      return { data, fids };
    }
    if (status === 3 || status < 0) throw new Error(data?.data?.message || "夸克转存任务失败。");
  }
  throw new Error("夸克转存任务超时。");
}

async function getDownloadList(cookies, fids, userAgent = BROWSER_UA) {
  const params = new URLSearchParams({
    pr: "ucpro",
    fr: "pc",
    sys: "win32",
    ve: "2.5.56",
    ut: "",
    guid: ""
  });
  const data = await quarkJson(`${QUARK_BASE}/file/download?${params.toString()}`, {
    cookies,
    method: "POST",
    body: { fids },
    userAgent
  });
  if (data?.code === 23018 && userAgent !== CLIENT_UA) {
    return getDownloadList(cookies, fids, CLIENT_UA);
  }
  assertQuarkOk(data, "夸克下载地址获取失败。");
  return Array.isArray(data?.data) ? data.data : [];
}

async function resolveDownloadEntry(cookies, savedFids, originalFile) {
  let entries = [];
  if (savedFids.length) entries = await getDownloadList(cookies, savedFids).catch(() => []);
  const byName = entries.find((entry) => entry?.download_url && entry.file_name === originalFile.fileName);
  if (byName) return byName;
  const firstMedia = entries.find((entry) => entry?.download_url && MEDIA_FILE_RE.test(entry.file_name || ""));
  if (firstMedia) return firstMedia;

  const targetFids = savedFids.length ? savedFids : [originalFile.fid];
  entries = await getDownloadList(cookies, targetFids);
  return entries.find((entry) => entry?.download_url && MEDIA_FILE_RE.test(entry.file_name || "")) || entries[0] || null;
}

async function findSavedQuarkFile(cookies, folderFid, originalFile) {
  const files = await listDriveFiles(cookies, folderFid).catch(() => []);
  const expectedSize = Number(originalFile.size || 0);
  const found = files.find((item) => {
    if (isQuarkDir(item?.dir)) return false;
    if (item.file_name !== originalFile.fileName) return false;
    return !expectedSize || Number(item.size || 0) === expectedSize;
  }) || files.find((item) => !isQuarkDir(item?.dir) && MEDIA_FILE_RE.test(item?.file_name || ""));
  return found?.fid || "";
}

export async function downloadQuarkShare(job, link, outDir, { store, updateDownloadStats }) {
  const account = store.getNetdiskAccount(job.userId, "quark");
  if (!account?.cookies) {
    throw new Error("夸克网盘未登录或登录态已失效。请到“模型配置 > 网盘账号登录”选择夸克并粘贴 Cookies。");
  }

  const { pwdId, passcode } = parseQuarkLink(link);
  if (!pwdId) throw new Error("夸克网盘链接格式无效，请使用 https://pan.quark.cn/s/... 分享链接。");
  fs.mkdirSync(outDir, { recursive: true });

  updateDownloadStats(job, { step: "读取夸克分享", progress: 10 });
  const stoken = await getShareToken(account.cookies, pwdId, passcode);
  const files = await listShareFiles(account.cookies, pwdId, stoken);
  const media = pickQuarkMedia(files);
  if (!media) {
    throw new Error("夸克分享中没有找到可处理的音视频文件。当前只会自动选择 mp4/mov/m4a/mp3 等音视频。");
  }

  updateDownloadStats(job, {
    step: media.size ? `转存夸克文件 ${formatBytes(media.size)}` : "转存夸克文件",
    progress: 12
  });
  const tempFolderFid = await ensureQuarkTempFolder(account.cookies);
  const taskId = await saveShareFile(account.cookies, pwdId, stoken, media, tempFolderFid);
  const taskResult = await waitForSaveTask(account.cookies, taskId);
  const savedFids = taskResult.fids.length
    ? taskResult.fids
    : [await findSavedQuarkFile(account.cookies, tempFolderFid, media)].filter(Boolean);
  const downloadEntry = await resolveDownloadEntry(account.cookies, savedFids, media);
  if (!downloadEntry?.download_url) {
    throw new Error("夸克文件转存成功，但没有拿到可下载地址。请确认夸克 Cookies 有下载权限。");
  }

  const fileName = downloadEntry.file_name || media.fileName || `${safeName(job.title)}.mp4`;
  const ext = path.extname(fileName) || ".mp4";
  const dest = path.join(outDir, `${safeName(path.basename(fileName, ext))}${ext}`);
  updateDownloadStats(job, { step: "下载夸克视频", progress: 14 });
  const downloaded = await downloadHttp(downloadEntry.download_url, dest, job, updateDownloadStats, {
    headers: {
      Cookie: account.cookies,
      Referer: QUARK_REFERER,
      Origin: "https://pan.quark.cn",
      "User-Agent": BROWSER_UA
    }
  });
  if (!pickMediaFile([downloaded]) || !fs.existsSync(downloaded) || fs.statSync(downloaded).size <= 0) {
    throw new Error("夸克视频下载完成但文件不可用。请重新提交或更换 Cookies。");
  }
  return downloaded;
}
