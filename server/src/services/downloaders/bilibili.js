import path from "node:path";
import { safeName } from "../../utils.js";
import { downloadHttp } from "./http.js";

const BILIBILI_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export function isBilibiliUrl(url) {
  return /(^|\.)bilibili\.com$/i.test(hostnameOf(url)) || /(^|\.)b23\.tv$/i.test(hostnameOf(url));
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

async function bilibiliJson(url, referer = "https://www.bilibili.com/") {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json, text/plain, */*",
      Referer: referer,
      "User-Agent": BILIBILI_UA
    }
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Error(`B 站接口请求失败：HTTP ${res.status}`);
  if (data.code !== 0) throw new Error(data.message || "B 站接口返回失败。");
  return data;
}

function extractBvid(input) {
  const text = String(input || "");
  const direct = text.match(/BV[0-9A-Za-z]{10}/)?.[0];
  if (direct) return direct;
  try {
    return new URL(text).pathname.match(/\/video\/(BV[0-9A-Za-z]{10})/i)?.[1] || "";
  } catch {
    return "";
  }
}

function pageNumber(input) {
  try {
    const parsed = new URL(input);
    const p = Number(parsed.searchParams.get("p") || 1);
    return Number.isFinite(p) && p > 0 ? p : 1;
  } catch {
    return 1;
  }
}

function pickAudio(dash) {
  const audios = Array.isArray(dash?.audio) ? dash.audio : [];
  return audios
    .filter((item) => item?.baseUrl || item?.base_url)
    .sort((a, b) => Number(b.bandwidth || 0) - Number(a.bandwidth || 0))[0] || null;
}

export async function downloadBilibili(job, url, outDir, updateDownloadStats) {
  const bvid = extractBvid(url);
  if (!bvid) throw new Error("B 站链接格式无效，无法识别 BV 号。");

  updateDownloadStats(job, { step: "解析 B 站视频", progress: 10 });
  const referer = `https://www.bilibili.com/video/${bvid}/`;
  const view = await bilibiliJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, referer);
  const pages = Array.isArray(view.data?.pages) ? view.data.pages : [];
  const selectedPage = pages.find((item) => Number(item.page) === pageNumber(url)) || pages[0];
  if (!selectedPage?.cid) throw new Error("B 站视频解析失败：没有拿到 cid。");

  const playUrl = new URL("https://api.bilibili.com/x/player/playurl");
  playUrl.searchParams.set("bvid", bvid);
  playUrl.searchParams.set("cid", String(selectedPage.cid));
  playUrl.searchParams.set("qn", "0");
  playUrl.searchParams.set("fnval", "16");
  playUrl.searchParams.set("fnver", "0");
  playUrl.searchParams.set("fourk", "1");
  const play = await bilibiliJson(playUrl.toString(), referer);
  const audio = pickAudio(play.data?.dash);
  const audioUrl = audio?.baseUrl || audio?.base_url;
  if (!audioUrl) throw new Error("B 站视频解析失败：没有拿到音频下载地址。");

  const title = view.data?.title || job.title || bvid;
  const suffix = pages.length > 1 ? `-P${selectedPage.page}-${selectedPage.part || ""}` : "";
  const dest = path.join(outDir, `${safeName(`${title}${suffix}`)}.m4s`);
  updateDownloadStats(job, { step: "下载 B 站音频", progress: 12 });
  return downloadHttp(audioUrl, dest, job, updateDownloadStats, {
    headers: {
      Accept: "*/*",
      Referer: referer,
      "User-Agent": BILIBILI_UA
    }
  });
}
