import dns from "node:dns/promises";
import net from "node:net";
import { APP_CONFIG } from "../config.js";

const MAX_RESPONSE_EXCERPT = 2000;
const MAX_CHUNK_CHARS = 3000;
const MAX_TEMPLATE_CHARS = 60000;
const DELIVERY_PRESETS = new Set(["standard", "okf", "chunks", "custom"]);
const DELIVERY_AUTH_TYPES = new Set(["none", "bearer", "header"]);
const BLOCKED_IPV4_RANGES = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
];

function ipv4ToInt(address) {
  return address.split(".").reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
}

function ipv4InCidr(address, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(address) & mask) === (ipv4ToInt(base) & mask);
}

function isBlockedIpv4(address) {
  return BLOCKED_IPV4_RANGES.some(([base, bits]) => ipv4InCidr(address, base, bits));
}

function isBlockedIpv6(address) {
  const value = String(address || "").toLowerCase();
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isBlockedIp(mapped[1]);
  if (value === "::" || value === "::1") return true;
  if (value.startsWith("2001:db8")) return true;
  const first = Number.parseInt(value.split(":")[0] || "0", 16);
  if (!Number.isFinite(first)) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  return false;
}

function isBlockedIp(address) {
  const family = net.isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

function isBlockedHostname(hostname) {
  const value = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
  return !value
    || value === "localhost"
    || value.endsWith(".localhost")
    || value.endsWith(".local");
}

function normalizeResolvedAddresses(records) {
  const list = Array.isArray(records) ? records : [records];
  return list
    .map((item) => typeof item === "string" ? item : item?.address)
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

async function defaultResolveHost(hostname) {
  return dns.lookup(hostname, { all: true, verbatim: true });
}

function deliveryTimeoutError(timeoutMs) {
  const error = new Error(`自定义接口输出超时（${Math.ceil(Number(timeoutMs || 0) / 1000)} 秒）。`);
  error.code = "DELIVERY_TIMEOUT";
  return error;
}

export async function assertDeliveryUrlAllowed(url, {
  allowPrivateUrls = APP_CONFIG.deliveryAllowPrivateUrls,
  resolveHost = defaultResolveHost
} = {}) {
  let parsed;
  try {
    parsed = new URL(String(url || "").trim());
  } catch {
    throw new Error("自定义接口输出地址必须是 HTTP/HTTPS URL。");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("自定义接口输出地址必须是 HTTP/HTTPS URL。");
  }
  if (parsed.username || parsed.password) {
    throw new Error("自定义接口输出地址不允许包含用户名或密码。");
  }
  if (allowPrivateUrls) return parsed;

  const hostname = parsed.hostname;
  if (isBlockedHostname(hostname)) {
    throw new Error("自定义接口输出地址不允许访问本机地址。");
  }
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) throw new Error("自定义接口输出地址不允许访问内网或私有地址。");
    return parsed;
  }

  let records;
  try {
    records = await resolveHost(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new Error(`自定义接口输出地址 DNS 解析失败：${err.message}`);
  }
  const addresses = normalizeResolvedAddresses(records);
  if (!addresses.length) throw new Error("自定义接口输出地址 DNS 未返回可用地址。");
  if (addresses.some((address) => isBlockedIp(address))) {
    throw new Error("自定义接口输出地址不允许访问内网或私有地址。");
  }
  return parsed;
}

function valueAtPath(source, keyPath) {
  const parts = String(keyPath || "").trim().split(".").filter(Boolean);
  let current = source;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function escapeJsonStringContent(value) {
  return JSON.stringify(String(value ?? "")).slice(1, -1);
}

export function renderDeliveryTemplate(template, context) {
  return String(template || "").replace(/{{\s*(json\s+)?([A-Za-z0-9_$.-]+)\s*}}/g, (_match, jsonMode, keyPath) => {
    const value = valueAtPath(context, keyPath);
    if (jsonMode) return JSON.stringify(value ?? null);
    return escapeJsonStringContent(value);
  });
}

function sourceFromContext(context) {
  const job = context.job || {};
  return {
    title: job.title || "",
    url: job.link || "",
    jobId: job.id || "",
    createdAt: job.createdAt || ""
  };
}

function chunkText(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const chunks = [];
  for (let start = 0; start < raw.length; start += MAX_CHUNK_CHARS) {
    const content = raw.slice(start, start + MAX_CHUNK_CHARS);
    chunks.push({
      chunkIndex: chunks.length,
      content
    });
  }
  return chunks;
}

function absoluteUrl(url, baseUrl = "") {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  const base = String(baseUrl || "").trim();
  if (!base) return value;
  try {
    return new URL(value, base).toString();
  } catch {
    return value;
  }
}

function outputDownloadUrl(job, file, index, publicBaseUrl = "") {
  if (!job?.id) return absoluteUrl(file?.url || "", publicBaseUrl);
  return absoluteUrl(`/api/jobs/${encodeURIComponent(job.id)}/download/${index}`, publicBaseUrl);
}

function documentsFromReviewOutputs(job, reviewOutputs = [], publicBaseUrl = "") {
  const sorted = [...(reviewOutputs || [])].sort((a, b) => Number(a.orderIndex || 0) - Number(b.orderIndex || 0));
  if (sorted.length) {
    return sorted.map((item, index) => ({
      id: item.id || "",
      label: item.label || `文件 ${index + 1}`,
      text: item.text || "",
      sourceUrl: absoluteUrl(item.url || "", publicBaseUrl),
      downloadUrl: outputDownloadUrl(job, item, index, publicBaseUrl),
      orderIndex: Number(item.orderIndex || index)
    }));
  }
  return (job.outputFiles || []).map((file, index) => ({
    id: file.reviewOutputId || file.type || String(index),
    label: file.label || `文件 ${index + 1}`,
    text: file.reviewOutputId === "raw" || file.label === "原文" ? job.rawText || "" : "",
    sourceUrl: absoluteUrl(file.url || "", publicBaseUrl),
    downloadUrl: outputDownloadUrl(job, file, index, publicBaseUrl),
    orderIndex: index
  }));
}

export function buildDeliveryContext({ job = {}, reviewOutputs = [], publicBaseUrl = "" } = {}) {
  const documents = documentsFromReviewOutputs(job, reviewOutputs, publicBaseUrl);
  const rawDocument = documents.find((item) => item.id === "raw" || item.label === "原文");
  const okfFileIndex = (job.outputFiles || []).findIndex((file) => file.type === "okf" || file.label === "OKF");
  const okfFile = okfFileIndex >= 0 ? job.outputFiles[okfFileIndex] : null;
  const usage = job.usageSummary || {};
  return {
    job,
    source: sourceFromContext({ job }),
    rawText: job.rawText || rawDocument?.text || "",
    documents,
    okf: {
      manifest: job.okfSummary?.manifest || null,
      assetCount: Number(job.okfSummary?.assetCount || 0),
      downloadUrl: okfFile ? outputDownloadUrl(job, okfFile, okfFileIndex, publicBaseUrl) : ""
    },
    metadata: {
      jobId: job.id || "",
      title: job.title || "",
      sourceUrl: job.link || "",
      status: job.status || "",
      createdAt: job.createdAt || "",
      completedAt: job.completedAt || "",
      durationSeconds: Math.ceil(Number(job.audioDurationSec || usage.asrSeconds || 0)),
      asrModel: job.settings?.asrModel || "",
      aiModel: job.settings?.qwenModel || "",
      usage
    }
  };
}

export function completedDeliveryJobSnapshot(job = {}, completedAt = new Date().toISOString()) {
  return {
    ...job,
    status: "done",
    completedAt: job.completedAt || completedAt
  };
}

export function shouldAutoDeliver({ job = {}, extraErrors = [], reviewRun = null, reviewError = "" } = {}) {
  if (!job.deliveryEnabled) return { ok: false, reason: "接口输出未启用。" };
  if (Array.isArray(extraErrors) && extraErrors.length) {
    return { ok: false, reason: "接口输出已跳过：额外文件生成失败，请修复后重试接口输出。" };
  }
  if (String(reviewError || "").trim()) {
    return { ok: false, reason: "接口输出已跳过：审查失败，请重试审查后再推送。" };
  }
  if (reviewRun?.locked || job.reviewLocked) {
    return { ok: false, reason: "接口输出已跳过：高风险审查未放行。" };
  }
  return { ok: true, reason: "" };
}

export function buildDeliveryPayload({ target = {}, context = {} }) {
  const preset = String(target.payloadPreset || "standard").trim() || "standard";
  if (preset === "custom" && String(target.payloadTemplate || "").trim()) {
    const rendered = renderDeliveryTemplate(target.payloadTemplate, context);
    try {
      return JSON.parse(rendered);
    } catch (err) {
      throw new Error(`自定义接口输出 JSON 模板无效：${err.message}`);
    }
  }

  const base = {
    source: sourceFromContext(context),
    metadata: context.metadata || {}
  };
  if (preset === "okf") {
    return {
      ...base,
      okf: context.okf || { manifest: null, assets: [] }
    };
  }
  if (preset === "chunks") {
    return {
      ...base,
      chunks: chunkText(context.rawText).map((chunk) => ({
        ...chunk,
        sourceUrl: context.job?.link || "",
        title: context.job?.title || ""
      }))
    };
  }
  return {
    ...base,
    transcript: context.rawText || "",
    documents: context.documents || [],
    okf: context.okf || { manifest: null, assets: [] }
  };
}

function normalizeMethod(method) {
  const value = String(method || "POST").trim().toUpperCase();
  return ["POST", "PUT", "PATCH"].includes(value) ? value : "POST";
}

function normalizeHeaders(headers) {
  if (!headers) return {};
  if (typeof headers === "string") {
    try {
      const parsed = JSON.parse(headers);
      return normalizeHeaders(parsed);
    } catch {
      return {};
    }
  }
  if (typeof headers !== "object" || Array.isArray(headers)) return {};
  return Object.fromEntries(Object.entries(headers)
    .map(([key, value]) => [String(key || "").trim(), String(value ?? "").trim()])
    .filter(([key, value]) => key && value)
    .slice(0, 50));
}

function normalizePreset(value) {
  const preset = String(value || "standard").trim();
  return DELIVERY_PRESETS.has(preset) ? preset : "standard";
}

function normalizeAuthType(value) {
  const authType = String(value || "none").trim();
  return DELIVERY_AUTH_TYPES.has(authType) ? authType : "none";
}

export function normalizeDeliveryTarget(input = {}, existing = {}) {
  return {
    ...existing,
    id: String(input.id || existing.id || "").trim(),
    userId: String(input.userId || existing.userId || "").trim(),
    name: String(input.name || existing.name || "自定义接口").trim().slice(0, 80) || "自定义接口",
    enabled: input.enabled == null ? Boolean(existing.enabled) : Boolean(input.enabled),
    method: normalizeMethod(input.method || existing.method),
    url: String(input.url || existing.url || "").trim().slice(0, 2000),
    headers: normalizeHeaders(input.headers ?? existing.headers),
    authType: normalizeAuthType(input.authType || existing.authType),
    authHeaderName: String(input.authHeaderName || existing.authHeaderName || "").trim().slice(0, 120),
    authSecret: String(input.authSecret ?? existing.authSecret ?? "").trim(),
    payloadPreset: normalizePreset(input.payloadPreset || existing.payloadPreset),
    payloadTemplate: String(input.payloadTemplate || existing.payloadTemplate || "").trim().slice(0, MAX_TEMPLATE_CHARS),
    createdAt: existing.createdAt || input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString()
  };
}

export function publicDeliveryTarget(target = {}) {
  const { authSecret, headers, ...rest } = target;
  const safeHeaders = Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => {
    const sensitive = /authorization|token|secret|key|cookie/i.test(key);
    return [key, sensitive && value ? "configured" : value];
  }));
  return {
    ...rest,
    headers: safeHeaders,
    hasAuthSecret: Boolean(authSecret)
  };
}

export function publicDeliveryRun(run = {}) {
  if (!run) return null;
  return {
    id: run.id,
    jobId: run.jobId,
    targetId: run.targetId,
    status: run.status,
    httpStatus: run.httpStatus,
    responseExcerpt: run.responseExcerpt || "",
    error: run.error || "",
    attempts: run.attempts || 0,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt
  };
}

function responseExcerpt(text) {
  return String(text || "").slice(0, MAX_RESPONSE_EXCERPT);
}

export async function deliverToTarget({
  target = {},
  context = {},
  fetchImpl = fetch,
  timeoutMs = APP_CONFIG.deliveryTimeoutMs,
  allowPrivateUrls = APP_CONFIG.deliveryAllowPrivateUrls,
  resolveHost = defaultResolveHost
}) {
  const url = String(target.url || "").trim();
  const parsedUrl = await assertDeliveryUrlAllowed(url, { allowPrivateUrls, resolveHost });
  const payload = buildDeliveryPayload({ target, context });
  const headers = {
    "Content-Type": "application/json",
    ...(target.headers || {})
  };
  if (target.authType === "bearer" && target.authSecret) {
    headers.Authorization = `Bearer ${target.authSecret}`;
  }
  if (target.authType === "header" && target.authHeaderName && target.authSecret) {
    headers[String(target.authHeaderName)] = target.authSecret;
  }

  const controller = new AbortController();
  let timedOut = false;
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(deliveryTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  let res;
  try {
    res = await Promise.race([
      fetchImpl(parsedUrl.toString(), {
        method: normalizeMethod(target.method),
        headers,
        body: JSON.stringify(payload),
        redirect: "manual",
        signal: controller.signal
      }),
      timeoutPromise
    ]);
  } catch (err) {
    if (timedOut || err?.name === "AbortError" || err?.code === "DELIVERY_TIMEOUT") {
      throw deliveryTimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
  const text = await res.text().catch(() => "");
  const excerpt = responseExcerpt(text);
  if (!res.ok) {
    const error = new Error(`自定义接口输出失败：HTTP ${res.status}${excerpt ? ` ${excerpt}` : ""}`);
    error.httpStatus = res.status;
    error.responseExcerpt = excerpt;
    throw error;
  }
  return {
    httpStatus: res.status,
    responseExcerpt: excerpt,
    payload
  };
}
