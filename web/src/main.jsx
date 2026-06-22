import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDown,
  ArrowUp,
  Archive,
  AlertTriangle,
  BarChart3,
  Download,
  Eye,
  FileText,
  Folder,
  KeyRound,
  Layers,
  Link as LinkIcon,
  Mic,
  Play,
  Plus,
  QrCode,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  Unlock,
  Users,
  UserRound,
  X
} from "lucide-react";
import logoAliyun from "./assets/logo-aliyun.png";
import logoCustom from "./assets/kianakaslana-top-logo.png";
import logoDeepSeek from "./assets/logo-deepseek.png";
import githubMark from "./assets/github-mark.svg";
import logoSilicon from "./assets/logo-silicon.png";
import "./styles.css";

const API = window.location.hostname === "localhost" && window.location.port !== "5174" ? "http://localhost:5174" : "";
const AUTH_TOKEN_KEY = "vtw-auth-token";

function authHeaders() {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function apiFetch(path, options = {}) {
  return fetch(`${API}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...authHeaders()
    }
  });
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${Math.max(0, Math.round(value))} B`;
}

function formatSeconds(seconds) {
  const value = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(value / 60);
  const rest = Math.round(value % 60);
  if (minutes <= 0) return `${rest} 秒`;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Math.round(Number(value || 0)));
}

function formatCost(value) {
  if (value == null) return "未配置";
  const amount = Number(value || 0);
  return amount ? `¥${amount.toFixed(4)}` : "¥0";
}

function numberOrNull(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatUsageCost(usage) {
  if (!usage) return formatCost(0);
  const asrCost = numberOrNull(usage.asrCost);
  const aiCost = numberOrNull(usage.llmCost);
  const totalCost = numberOrNull(usage.estimatedCost);
  const hasAiUsage = Number(usage.llmTokens || 0) > 0 || Number(aiCost || 0) > 0;

  if (hasAiUsage && asrCost != null && aiCost != null) {
    return `ASR ${formatCost(asrCost)} + AI ${formatCost(aiCost)}`;
  }

  if (!hasAiUsage && asrCost != null) {
    return formatCost(asrCost);
  }

  if (hasAiUsage && asrCost != null && totalCost != null) {
    return `ASR ${formatCost(asrCost)} + AI ${formatCost(Math.max(0, totalCost - asrCost))}`;
  }

  return formatCost(totalCost);
}

function formatJobUsage(usage) {
  const parts = [`音频 ${formatSeconds(usage?.asrSeconds || 0)}`];
  if (Number(usage?.llmTokens || 0) > 0) {
    parts.push(`AI 用量 ${formatNumber(usage.llmTokens)} tokens`);
  }
  parts.push(`预估 ${formatUsageCost(usage)}`);
  return `用量：${parts.join(" · ")}`;
}

const PROVIDERS = {
  aliyun: {
    id: "aliyun",
    short: "阿里云",
    name: "阿里云百炼",
    desc: "用于语音转写和 AI 处理。",
    logo: logoAliyun,
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    asr: "paraformer-v2",
    llm: "qwen-plus"
  },
  silicon: {
    id: "silicon",
    short: "硅基流动",
    name: "硅基流动 SiliconFlow",
    desc: "用于 AI 处理，可搭配阿里云转写。",
    logo: logoSilicon,
    baseUrl: "https://api.siliconflow.cn/v1",
    asr: "FunAudioLLM/SenseVoiceSmall",
    llm: "deepseek-ai/DeepSeek-V3"
  },
  deepseek: {
    id: "deepseek",
    short: "DeepSeek",
    name: "DeepSeek",
    desc: "用于 AI 处理，可搭配阿里云转写。",
    logo: logoDeepSeek,
    baseUrl: "https://api.deepseek.com",
    asr: "paraformer-v2",
    llm: "deepseek-chat"
  },
  custom: {
    id: "custom",
    short: "自定义",
    name: "自定义",
    desc: "填写自有模型接口。",
    logo: logoCustom,
    baseUrl: "",
    asr: "",
    llm: ""
  }
};

const providerOrder = ["aliyun", "silicon", "deepseek", "custom"];
const NETDISK_PROVIDERS = {
  baidu: { id: "baidu", name: "百度网盘", supported: true },
  quark: { id: "quark", name: "夸克网盘", supported: true },
  unknown: { id: "unknown", name: "未知网盘", supported: false }
};
const WORK_DRAFT_KEY_PREFIX = "vtw-work-draft";
const DURATION_SAMPLES_KEY = "vtw-duration-samples";
const EXTRA_DOC_TEMPLATES_KEY = "vtw-extra-doc-templates";

function defaultProviderConfig() {
  return Object.fromEntries(
    providerOrder.map((id) => [
      id,
      {
        apiKey: "",
        baseUrl: PROVIDERS[id].baseUrl,
        asr: PROVIDERS[id].asr,
        llm: PROVIDERS[id].llm,
        asrProvider: "aliyun"
      }
    ])
  );
}

function defaultOssConfig() {
  return {
    region: "",
    bucket: "",
    accessKeyId: "",
    accessKeySecret: "",
    prefix: "video-to-word"
  };
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function mergeProviderConfig(saved) {
  const defaults = defaultProviderConfig();
  return Object.fromEntries(
    providerOrder.map((id) => {
      const merged = { ...defaults[id], ...(saved?.[id] || {}) };
      return [id, merged];
    })
  );
}

function formatSavedTime(date) {
  if (!date) return "";
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function defaultWorkDraft() {
  return {
    links: [{ title: "", link: "" }],
    bulkText: "",
    docs: [],
    formatEnabled: false,
    formatRequirement: "",
    okfEnabled: false,
    okfOptions: {
      owner: "",
      version: "1.0",
      tags: ""
    }
  };
}

function normalizeWorkDraft(saved) {
  const defaults = defaultWorkDraft();
  const okfOptions = saved?.okfOptions || {};
  return {
    links: Array.isArray(saved?.links) && saved.links.length ? saved.links : defaults.links,
    bulkText: typeof saved?.bulkText === "string" ? saved.bulkText : defaults.bulkText,
    docs: Array.isArray(saved?.docs) ? saved.docs : defaults.docs,
    formatEnabled: Boolean(saved?.formatEnabled),
    formatRequirement: typeof saved?.formatRequirement === "string" ? saved.formatRequirement : defaults.formatRequirement,
    okfEnabled: Boolean(saved?.okfEnabled),
    okfOptions: {
      owner: typeof okfOptions.owner === "string" ? okfOptions.owner : defaults.okfOptions.owner,
      version: typeof okfOptions.version === "string" ? okfOptions.version : defaults.okfOptions.version,
      tags: Array.isArray(okfOptions.tags) ? okfOptions.tags.join(", ") : typeof okfOptions.tags === "string" ? okfOptions.tags : defaults.okfOptions.tags
    }
  };
}

function formatDuration(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  if (minutes < 60) return `约 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `约 ${hours} 小时 ${rest} 分钟` : `约 ${hours} 小时`;
}

function durationSamplesFromJobs(jobs) {
  return jobs
    .map((job) => Number(job.durationMs))
    .filter((ms) => Number.isFinite(ms) && ms > 10000 && ms < 6 * 60 * 60 * 1000);
}

function readDurationSamples() {
  const saved = readJson(DURATION_SAMPLES_KEY, []);
  return Array.isArray(saved) ? saved.filter((ms) => Number.isFinite(Number(ms))).map(Number) : [];
}

function rememberDurationSamples(jobs) {
  const samples = durationSamplesFromJobs(jobs);
  if (!samples.length) return;
  const merged = [...readDurationSamples(), ...samples].slice(-30);
  localStorage.setItem(DURATION_SAMPLES_KEY, JSON.stringify(merged));
}

function estimateProcessingTime(count, mode, extraDocsCount, jobs) {
  const samples = [...durationSamplesFromJobs(jobs), ...readDurationSamples()];
  const fallback = mode === "cloud" ? 12 * 60 * 1000 : 6 * 60 * 1000;
  const avg = samples.length
    ? samples.reduce((sum, ms) => sum + ms, 0) / samples.length
    : fallback + extraDocsCount * 2 * 60 * 1000;
  return formatDuration(avg * Math.ceil(Math.max(1, count) / 5));
}

function detectNetdiskProvider(link) {
  const text = String(link || "");
  if (/pan\.baidu\.com|yun\.baidu\.com/i.test(text)) return NETDISK_PROVIDERS.baidu;
  if (/pan\.quark\.cn|drive\.uc\.cn/i.test(text)) return NETDISK_PROVIDERS.quark;
  if (/https?:\/\/\S+/i.test(text) && /(pan|drive|cloud|yun|网盘)/i.test(text)) return NETDISK_PROVIDERS.unknown;
  return null;
}

function validateCloudLinks(links) {
  const items = links.filter((item) => item.link?.trim());
  for (let index = 0; index < items.length; index += 1) {
    const provider = detectNetdiskProvider(items[index].link);
    if (!provider) {
      return `第 ${index + 1} 个链接无法识别网盘类型。仅支持百度网盘和夸克网盘。`;
    }
    if (!provider.supported) return unsupportedNetdiskMessage(provider);
  }
  return "";
}

function unsupportedNetdiskMessage(provider) {
  if (!provider) return "";
  return `${provider.name}暂不支持。仅支持百度网盘和夸克网盘；其他来源请使用公网音视频直链。`;
}

function fileNameFromDisposition(header) {
  const encoded = header?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) return decodeURIComponent(encoded);
  const plain = header?.match(/filename="?([^"]+)"?/i)?.[1];
  return plain || `video-to-word-${Date.now()}.zip`;
}

function saveBlobResponse(res, fallbackName = "download") {
  return res.blob().then((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileNameFromDisposition(res.headers.get("content-disposition")) || fallbackName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
}

async function readErrorResponse(res, fallback) {
  const text = await res.text();
  if (!text) return fallback;
  try {
    return JSON.parse(text).error || fallback;
  } catch {
    return text || fallback;
  }
}

function useProviderConfig() {
  const [active, setActive] = useState("aliyun");
  const [cfg, setCfg] = useState(() => mergeProviderConfig(null));
  const [savedAt, setSavedAt] = useState(null);

  function save() {
    setSavedAt(new Date());
  }

  function update(id, patch) {
    setCfg((old) => {
      const base = mergeProviderConfig(old);
      return { ...base, [id]: { ...base[id], ...patch } };
    });
  }

  function select(id) {
    if (!providerOrder.includes(id)) return;
    setActive(id);
  }

  function replace(next = {}) {
    const nextActive = providerOrder.includes(next.active) ? next.active : "aliyun";
    setActive(nextActive);
    setCfg(mergeProviderConfig(next.cfg || next.providers || null));
    if (next.updatedAt) setSavedAt(new Date(next.updatedAt));
  }

  return { active, cfg, update, select, save, replace, savedAt };
}

function useOssConfig() {
  const [oss, setOss] = useState(() => defaultOssConfig());
  const [savedAt, setSavedAt] = useState(null);

  function save() {
    setSavedAt(new Date());
  }

  function update(patch) {
    setOss((old) => ({ ...old, ...patch }));
  }

  function replace(next = {}) {
    setOss({ ...defaultOssConfig(), ...(next || {}) });
  }

  return { oss, update, save, replace, savedAt };
}

function buildUserConfigPayload(providerState, ossState) {
  return {
    provider: {
      active: providerState.active,
      cfg: mergeProviderConfig(providerState.cfg)
    },
    oss: { ...defaultOssConfig(), ...ossState.oss }
  };
}

function buildJobRuntimeSettings(directUrlMode) {
  return {
    directUrlMode,
    publicBaseUrl: window.location.origin
  };
}

function normalizeShareLink(raw) {
  const line = String(raw || "").trim();
  if (!line) return "";
  const match = line.match(/https?:\/\/[^\s)\]）]+/);
  const url = (match?.[0] || line).replace(/[，,。；;]+$/, "");
  const pwdMatch = line.match(/(?:提取码|密码|pwd|code|passcode)[:：=\s]*([A-Za-z0-9]{4})/i);
  if (!pwdMatch) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.get("pwd")) parsed.searchParams.set("pwd", pwdMatch[1]);
    return parsed.toString();
  } catch {
    return `${url}${url.includes("?") ? "&" : "?"}pwd=${pwdMatch[1]}`;
  }
}

function cleanBulkTitle(line, url) {
  return String(line || "")
    .replace(url, "")
    .replace(/\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/(?:链接|地址|url)[:：]?\s*/i, "")
    .replace(/(?:提取码|密码|pwd|code|passcode)[:：=\s]*[A-Za-z0-9]{4}/i, "")
    .replace(/^[\s,，:：|-]+|[\s,，:：|-]+$/g, "");
}

function parseBulkLinks(text) {
  const lines = String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^[-—]{1,2}\s*来自/.test(line));
  const parsed = [];
  let pendingTitle = "";

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const titleMatch = line.match(/(?:通过网盘分享的文件|分享文件|文件名|文件)[:：]\s*(.+)$/);
    const urlMatch = line.match(/https?:\/\/[^\s)\]）]+/);
    if (titleMatch && !urlMatch) {
      pendingTitle = titleMatch[1].trim();
      continue;
    }
    if (!urlMatch) continue;

    const url = urlMatch[0].replace(/[，,。；;]+$/, "");
    const nextLine = lines[i + 1] || "";
    const context = /https?:\/\//.test(nextLine) ? line : `${line} ${nextLine}`;
    const title = pendingTitle || cleanBulkTitle(line, url);
    parsed.push({
      title: title || `视频 ${parsed.length + 1}`,
      link: normalizeShareLink(`${url} ${context}`)
    });
    pendingTitle = "";
  }
  return parsed;
}

function ModelConfig({ providerState }) {
  const { active, cfg, update, select } = providerState;
  const provider = PROVIDERS[active];
  const current = cfg[active];
  const isDeepSeek = active === "deepseek";
  const baseLocked = active !== "custom";
  const [testState, setTestState] = useState({ loading: false, ok: false, message: "" });

  useEffect(() => {
    setTestState({ loading: false, ok: false, message: "" });
  }, [active]);

  async function testConnection() {
    if (testState.loading) return;
    setTestState({ loading: true, ok: false, message: "" });
    try {
      const aliyun = cfg.aliyun;
      const res = await apiFetch("/api/config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            dashscopeApiKey: (active === "aliyun" ? current : aliyun).apiKey,
            llmApiKey: current.apiKey,
            llmBaseUrl: current.baseUrl,
            qwenModel: String(current.llm || "").trim()
          }
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || "连接测试失败。");
      setTestState({ loading: false, ok: true, message: `连接正常${data.model ? `（${data.model}）` : ""}` });
    } catch (err) {
      setTestState({ loading: false, ok: false, message: err.message || "连接测试失败。" });
    }
  }

  return (
    <section className="panel">
      <div className="panelHead">
        <div>
          <h2>模型配置</h2>
          <p>选择转写和 AI 处理使用的模型服务。</p>
        </div>
      </div>

      <div className="mcTabs">
        {providerOrder.map((id) => {
          const item = PROVIDERS[id];
          return (
            <button key={id} className={active === id ? "active" : ""} onClick={() => select(id)}>
              <Logo provider={item} small />
              <span>{item.short}</span>
            </button>
          );
        })}
      </div>

      <div className="mcBody">
        <div className="mcCurrent">
          <Logo provider={provider} />
          <div>
            <strong>{provider.name}</strong>
            <span>{provider.desc}</span>
          </div>
          <b>已选择</b>
        </div>

        <label className="field">API Key
          <input type="password" placeholder="sk-••••••••••••" value={current.apiKey} onChange={(e) => update(active, { apiKey: e.target.value })} />
        </label>

        <label className="field">接口地址 Base URL
          <input className={baseLocked ? "locked" : ""} readOnly={baseLocked} value={current.baseUrl} onChange={(e) => update(active, { baseUrl: e.target.value })} />
        </label>

        {isDeepSeek ? (
          <>
            <label className="field">AI 处理模型
              <input placeholder="输入模型名" value={current.llm} onChange={(e) => update(active, { llm: e.target.value })} />
            </label>
            <div className="asrBox">
              <div className="asrBoxHead"><Mic size={15} />语音转写使用阿里云百炼</div>
              <div className="two">
                <label className="field">转写服务商
                  <input readOnly className="locked" value="阿里云百炼" />
                </label>
                <label className="field">转写模型 (ASR)
                  <input placeholder="输入模型名" value={current.asr} onChange={(e) => update(active, { asr: e.target.value })} />
                </label>
              </div>
            </div>
          </>
        ) : (
          <div className="two">
            <label className="field">转写模型 (ASR)
              <input placeholder="输入模型名" value={current.asr} onChange={(e) => update(active, { asr: e.target.value })} />
            </label>
            <label className="field">AI 处理模型
              <input placeholder="输入模型名" value={current.llm} onChange={(e) => update(active, { llm: e.target.value })} />
            </label>
          </div>
        )}

        <div className="testRow">
          <button className="btn" disabled={testState.loading || !current.apiKey} onClick={testConnection}>
            {testState.loading ? "测试中…" : "测试连接"}
          </button>
          {testState.message && (
            <span className={testState.ok ? "testResult ok" : "testResult err"}>{testState.message}</span>
          )}
        </div>
      </div>
    </section>
  );
}

function NetdiskConfig({ ossState }) {
  const { oss, update } = ossState;
  const [open, setOpen] = useState(false);
  return (
    <section className="panel">
      <div className="panelHead compactHead">
        <div>
          <h2>高级存储</h2>
          <p>一般无需填写。需要使用自有存储服务时，可在这里配置。</p>
        </div>
        <button className="btn" onClick={() => setOpen((value) => !value)}>{open ? "收起" : "展开"}</button>
      </div>
      <div className="notice inlineNotice">
        <Folder size={17} />
        <span>保持为空即可使用默认处理方式。</span>
      </div>
      {open && (
        <div className="two ossFields">
          {["region", "bucket", "accessKeyId", "accessKeySecret", "prefix"].map((key) => (
            <label className="field" key={key}>{key}
              <input
                type={key === "accessKeySecret" ? "password" : "text"}
                value={oss[key] || ""}
                onChange={(e) => update({ [key]: e.target.value })}
              />
            </label>
          ))}
        </div>
      )}
    </section>
  );
}

function NetdiskLogin() {
  const [activeDrive, setActiveDrive] = useState("baidu");
  const [statusMap, setStatusMap] = useState({});
  const [mode, setMode] = useState("cookies");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loginView, setLoginView] = useState("qr");
  const [form, setForm] = useState({ cookies: "", bduss: "", stoken: "", ptoken: "", username: "", password: "" });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [qrSession, setQrSession] = useState(null);
  const [qrImageUrl, setQrImageUrl] = useState("");
  const [qrLoading, setQrLoading] = useState(false);
  const [qrError, setQrError] = useState("");

  async function refreshStatus(provider = activeDrive) {
    const res = await apiFetch(`/api/netdisk/status?provider=${encodeURIComponent(provider)}`);
    const data = await res.json();
    setStatusMap((old) => ({ ...old, [provider]: data }));
    return data;
  }

  useEffect(() => {
    refreshStatus(activeDrive).catch(() => {});
    setLoginView(activeDrive === "baidu" ? "qr" : "manual");
    setShowAdvanced(false);
  }, [activeDrive]);

  function updateForm(patch) {
    setForm((old) => ({ ...old, ...patch }));
  }

  async function login() {
    setLoading(true);
    setMessage("");
    setError("");
    try {
      const res = await apiFetch("/api/netdisk/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: activeDrive, mode: activeDrive === "quark" ? "cookies" : mode, ...form })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || data.output || "登录失败，请检查凭证。");
      setStatusMap((old) => ({ ...old, [activeDrive]: data.account }));
      setMessage(data.account?.account ? `已登录：${data.account.account}` : "登录成功。");
      setForm({ cookies: "", bduss: "", stoken: "", ptoken: "", username: "", password: "" });
    } catch (err) {
      setError(err.message || "登录失败，请稍后重试。");
      await refreshStatus(activeDrive).catch(() => {});
    } finally {
      setLoading(false);
    }
  }

  async function loadQrImage(sessionId) {
    const res = await apiFetch(`/api/netdisk/baidu/qr/${encodeURIComponent(sessionId)}/image`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "二维码读取失败。");
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    setQrImageUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return url;
    });
  }

  async function startQrLogin() {
    setQrLoading(true);
    setQrError("");
    setMessage("");
    setError("");
    setQrImageUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return "";
    });
    try {
      const res = await apiFetch("/api/netdisk/baidu/qr/start", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "扫码登录启动失败。");
      setQrSession(data.session);
      await loadQrImage(data.session.id);
      fetchQrStatus(data.session.id).catch(() => {});
    } catch (err) {
      setQrError(err.message || "扫码登录启动失败。");
    } finally {
      setQrLoading(false);
    }
  }

  async function fetchQrStatus(sessionId = qrSession?.id) {
    if (!sessionId) return null;
    const res = await apiFetch(`/api/netdisk/baidu/qr/${encodeURIComponent(sessionId)}/status`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "扫码状态读取失败。");
    setQrSession(data.session);
    if (data.session.status === "verified") {
      setMessage(data.session.message || "百度网盘登录成功。");
      await refreshStatus("baidu");
      setTimeout(() => cancelQrLogin(), 800);
    }
    if (["failed", "expired"].includes(data.session.status)) {
      setQrError(data.session.lastError || data.session.message || "扫码登录失败，请重试。");
    }
    return data.session;
  }

  async function cancelQrLogin() {
    const id = qrSession?.id;
    if (id) {
      await apiFetch(`/api/netdisk/baidu/qr/${encodeURIComponent(id)}/cancel`, { method: "POST" }).catch(() => {});
    }
    setQrSession(null);
    setQrError("");
    setQrImageUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return "";
    });
  }

  useEffect(() => {
    if (!qrSession?.id || ["verified", "failed", "expired", "cancelled"].includes(qrSession.status)) return undefined;
    fetchQrStatus(qrSession.id).catch((err) => setQrError(err.message || "扫码状态读取失败。"));
    const timer = setInterval(async () => {
      try {
        await fetchQrStatus(qrSession.id);
      } catch (err) {
        setQrError(err.message || "扫码状态读取失败。");
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [qrSession?.id, qrSession?.status]);

  useEffect(() => () => {
    if (qrImageUrl) URL.revokeObjectURL(qrImageUrl);
  }, [qrImageUrl]);

  const activeProvider = NETDISK_PROVIDERS[activeDrive];
  const status = statusMap[activeDrive];
  const loggedText = status?.installed
    ? status.loggedIn ? `已登录${status.account ? `：${status.account}` : ""}` : "未登录"
    : "未授权";
  const isBaidu = activeDrive === "baidu";
  const loginTitle = `${activeProvider.name}授权`;
  const loginDesc = isBaidu
    ? "从已登录的网页版请求中复制包含 BDUSS/STOKEN 的 Cookie。"
    : "从已登录的网页版请求中复制登录 Cookie。";
  const cookiePlaceholder = isBaidu
    ? "示例：BDUSS=...; STOKEN=...; BAIDUID=...;"
    : "示例：__pus=...; __puus=...; __kp=...;";
  const showManualLogin = !isBaidu || loginView === "manual";
  const qrStatusText = qrError || ({
    starting: "正在生成二维码",
    qr_ready: "请扫码",
    waiting_scan: "请扫码",
    waiting_confirm: "扫码成功",
    binding: "登录中",
    verifying: "登录中",
    verified: "登录成功",
    expired: "二维码已过期",
    failed: "登录失败",
    cancelled: "已取消"
  }[qrSession?.status] || (qrLoading ? "正在生成二维码" : "请扫码"));

  return (
    <section className="panel">
      <div className="panelHead compactHead">
        <div>
          <h2>网盘账号登录</h2>
          <p>授权后即可处理对应网盘的分享链接。</p>
        </div>
        <button className="btn" onClick={() => refreshStatus(activeDrive)}><RefreshCw size={15} />刷新状态</button>
      </div>

      <div className="driveTabs">
        {["baidu", "quark"].map((id) => {
          const provider = NETDISK_PROVIDERS[id];
          return (
            <button key={id} className={activeDrive === id ? "active" : ""} onClick={() => setActiveDrive(id)}>
              {provider.name}
            </button>
          );
        })}
      </div>

      <div className="driveLoginCard">
        <div className={status?.loggedIn ? "accountStatus ok" : "accountStatus"}>
          <UserRound size={17} />
          <span>{activeProvider.name}：{loggedText}</span>
        </div>

        {isBaidu && !showManualLogin ? (
          <>
            <div className="qrLoginIntro">
              <div className="qrLoginIcon"><QrCode size={28} /></div>
              <div>
                <strong>扫码授权</strong>
                <span>使用百度网盘 App 扫码，并在手机上确认登录。</span>
              </div>
            </div>
            <div className="loginActions qrDefaultActions">
              <div className="loginHint"><KeyRound size={15} />授权信息仅用于读取你提交的分享文件。</div>
              <div className="loginButtonGroup">
                <button className="linkBtn" onClick={() => setLoginView("manual")}>登录异常？</button>
                <button className="primary compactPrimary" disabled={qrLoading} onClick={startQrLogin}>
                  <QrCode size={16} />{qrLoading ? "生成中" : "扫码登录"}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="cookieGuide">
              <strong>{loginTitle}</strong>
              <span>{loginDesc}</span>
            </div>

            <label className="field">登录凭证
              <textarea
                className="secretArea"
                placeholder={cookiePlaceholder}
                value={form.cookies}
                onChange={(e) => {
                  if (isBaidu) setMode("cookies");
                  updateForm({ cookies: e.target.value });
                }}
              />
            </label>

            {isBaidu && (
              <>
                <button className="advancedToggle" onClick={() => setShowAdvanced((old) => !old)}>
                  {showAdvanced ? "收起更多方式" : "更多方式"}
                </button>

                {showAdvanced && (
                  <div className="advancedLogin">
                    <div className="loginTabs">
                      <button className={mode === "cookies" ? "active" : ""} onClick={() => setMode("cookies")}>浏览器凭证</button>
                      <button className={mode === "bduss" ? "active" : ""} onClick={() => setMode("bduss")}>BDUSS</button>
                      <button className={mode === "password" ? "active" : ""} onClick={() => setMode("password")}>账号密码</button>
                    </div>

                    {mode === "bduss" && (
                      <div className="two">
                        <label className="field">BDUSS
                          <input type="password" value={form.bduss} onChange={(e) => updateForm({ bduss: e.target.value })} />
                        </label>
                        <label className="field">STOKEN
                          <input type="password" value={form.stoken} onChange={(e) => updateForm({ stoken: e.target.value })} />
                        </label>
                        <label className="field">PTOKEN（可选）
                          <input type="password" value={form.ptoken} onChange={(e) => updateForm({ ptoken: e.target.value })} />
                        </label>
                      </div>
                    )}

                    {mode === "password" && (
                      <div className="two">
                        <label className="field">百度账号
                          <input value={form.username} onChange={(e) => updateForm({ username: e.target.value })} />
                        </label>
                        <label className="field">密码
                          <input type="password" value={form.password} onChange={(e) => updateForm({ password: e.target.value })} />
                        </label>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            <div className="loginActions">
              <div className="loginHint"><KeyRound size={15} />授权信息仅用于读取你提交的分享文件。</div>
              <div className="loginButtonGroup">
                {isBaidu && (
                  <button className="linkBtn" onClick={() => setLoginView("qr")}>返回扫码登录</button>
                )}
                <button className={isBaidu ? "btn" : "primary compactPrimary"} disabled={loading || (isBaidu && status?.installed === false)} onClick={login}>
                  {loading ? "登录中" : isBaidu ? "手动登录" : "登录夸克"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {message && <div className="submitNotice slim">{message}</div>}
      {error && <div className="submitNotice err slim">{error}</div>}
      {(qrSession || qrError) && (
        <div className="modalOverlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) cancelQrLogin();
        }}>
          <div className="qrModal panel">
            <div className="qrModalHead">
              <div>
                <h2>百度网盘扫码登录</h2>
                <p>使用百度网盘 App 扫码并在手机上确认。</p>
              </div>
              <button className="miniBtn" onClick={cancelQrLogin}><X size={16} /></button>
            </div>
            <div className="qrImageBox">
              {qrImageUrl ? <img src={qrImageUrl} alt="百度网盘登录二维码" /> : <div className="qrPlaceholder"><QrCode size={42} /></div>}
            </div>
            <div className={qrError ? "qrStatus err" : "qrStatus"}>{qrStatusText}</div>
            <div className="qrActions">
              {["expired", "failed"].includes(qrSession?.status) && (
                <button className="primary compactPrimary" onClick={startQrLogin}>重新生成</button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function ConfigPage({ providerState, ossState }) {
  const [manualSavedAt, setManualSavedAt] = useState(null);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const latestSavedAt = [manualSavedAt, providerState.savedAt, ossState.savedAt]
    .filter(Boolean)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  async function saveAll() {
    if (saving) return;
    setSaving(true);
    setSaveError("");
    setSaveMessage("");
    try {
      const res = await apiFetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: buildUserConfigPayload(providerState, ossState) })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || "保存配置失败。");
      providerState.save();
      ossState.save();
      const savedAt = data.config?.updatedAt ? new Date(data.config.updatedAt) : new Date();
      setManualSavedAt(savedAt);
      setSaveMessage(`保存成功 · ${formatSavedTime(savedAt)}`);
    } catch (err) {
      setSaveMessage("");
      setSaveError(err.message || "保存配置失败。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <section className="configTop panel">
        <div>
          <h1>模型配置</h1>
          <p>配置转写、AI 处理、网盘授权和高级存储，保障 V2W 当前流程稳定运行。</p>
        </div>
        <div className="saveGroup">
          {saveMessage ? <span>{saveMessage}</span> : latestSavedAt && <span>已保存 {formatSavedTime(latestSavedAt)}</span>}
          {saveError && <span className="inlineError">{saveError}</span>}
          <button className="primary compactPrimary" disabled={saving} onClick={saveAll}><Save size={16} />{saving ? "保存中" : "保存配置"}</button>
        </div>
      </section>
      <ModelConfig providerState={providerState} />
      <NetdiskLogin />
      <NetdiskConfig ossState={ossState} />
    </>
  );
}

function Logo({ provider, small = false }) {
  return (
    <span className={small ? "logo small" : "logo"}>
      <img src={provider.logo} alt={provider.name} className={provider.id === "silicon" ? "silicon" : ""} />
    </span>
  );
}

function LinkBuilder({ title, desc, placeholder, links, setLinks, bulkText, setBulkText, showMove }) {
  function move(index, dir) {
    setLinks((old) => {
      const next = [...old];
      const target = index + dir;
      if (target < 0 || target >= next.length) return old;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function importBulk() {
    const parsed = parseBulkLinks(bulkText);
    if (parsed.length) setLinks(parsed);
  }

  return (
    <section className="panel">
      <div className="panelHead">
        <div><h2>{title}</h2><p>{desc}</p></div>
        <button className="btn" onClick={() => setLinks([...links, { title: "", link: "" }])}><Plus size={16} />添加</button>
      </div>
      <div className="bulkBox">
        <div className="bulkHead"><Layers size={15} />批量粘贴 · 每行一个，自动整理成任务</div>
        <div className="bulkInner">
          <textarea placeholder={placeholder} value={bulkText} onChange={(e) => setBulkText(e.target.value)} />
          <button className="btn" onClick={importBulk}>整理成批量任务</button>
        </div>
      </div>
      <div className="rows">
        {links.map((item, index) => (
          <div className="linkCard tile" key={index}>
            <div className="order">{index + 1}</div>
            <div className="linkBody">
              <div className="titleLine">
                <input className="titleInput" placeholder="未命名视频" value={item.title} onChange={(e) => setLinks(links.map((row, i) => i === index ? { ...row, title: e.target.value } : row))} />
                {!showMove && item.link.trim() && (() => {
                  const provider = detectNetdiskProvider(item.link);
                  return provider ? (
                    <span className={provider.supported ? "netdiskBadge" : "netdiskBadge warn"}>
                      {provider.name}{provider.supported ? "" : "暂不支持"}
                    </span>
                  ) : (
                    <span className="netdiskBadge warn">无法识别网盘</span>
                  );
                })()}
              </div>
              <div className="linkInput">
                <LinkIcon size={15} />
                <input placeholder={showMove ? "https://example.com/video.mp4" : "网盘分享链接，可带提取码"} value={item.link} onChange={(e) => setLinks(links.map((row, i) => i === index ? { ...row, link: e.target.value } : row))} />
              </div>
            </div>
            <div className="rowActions">
              {showMove && <button className="miniBtn" title="上移" onClick={() => move(index, -1)}><ArrowUp size={15} /></button>}
              {showMove && <button className="miniBtn" title="下移" onClick={() => move(index, 1)}><ArrowDown size={15} /></button>}
              <button className="miniBtn danger" title="删除" onClick={() => setLinks(links.filter((_, i) => i !== index))}><Trash2 size={15} /></button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ExtraDocs({ docs, setDocs, embedded = false }) {
  const [templates, setTemplates] = useState([]);
  const [templateError, setTemplateError] = useState("");
  const [templateSaving, setTemplateSaving] = useState(false);
  const [templateSavingIndex, setTemplateSavingIndex] = useState(-1);
  const [templateDeletingId, setTemplateDeletingId] = useState("");
  const [openTemplateIndex, setOpenTemplateIndex] = useState(-1);
  const [expanded, setExpanded] = useState(false);
  const [templateModal, setTemplateModal] = useState({ open: false, targetIndex: -1, title: "", prompt: "" });
  const smartTitleEnabled = docs.some((doc) => doc.smartTitle);
  const setSmartTitleEnabled = (enabled) => {
    setDocs(docs.map((doc) => ({ ...doc, smartTitle: enabled })));
  };
  const addDoc = () => {
    setDocs([...docs, {
      title: "",
      prompt: "",
      templateId: "",
      smartTitle: smartTitleEnabled,
      formatEnabled: false,
      formatRequirement: ""
    }]);
    setExpanded(true);
  };
  const loadTemplates = async () => {
    setTemplateError("");
    try {
      const res = await apiFetch("/api/templates");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "模板读取失败");
      const serverTemplates = data.templates || [];
      setTemplates(serverTemplates);

      const localTemplates = readJson(EXTRA_DOC_TEMPLATES_KEY, []);
      if (serverTemplates.length === 0 && Array.isArray(localTemplates) && localTemplates.length) {
        const validLocal = localTemplates.filter((item) => item?.title && item?.prompt).slice(0, 20);
        const created = [];
        for (const item of validLocal) {
          const createRes = await apiFetch("/api/templates", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: item.title, prompt: item.prompt })
          });
          const createData = await createRes.json();
          if (createRes.ok && createData.template) created.push(createData.template);
        }
        if (created.length) {
          setTemplates(created);
        }
        if (validLocal.length && created.length === validLocal.length) {
          localStorage.removeItem(EXTRA_DOC_TEMPLATES_KEY);
        } else if (created.length) {
          setTemplateError("部分本地模板迁移失败，已保留本地副本。");
        }
      }
    } catch (err) {
      setTemplateError(err.message || "模板读取失败。");
    }
  };
  useEffect(() => {
    loadTemplates();
  }, []);
  useEffect(() => {
    if (openTemplateIndex < 0) return undefined;
    const close = (event) => {
      if (!(event.target instanceof Element) || !event.target.closest(".templateSelectWrap")) setOpenTemplateIndex(-1);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [openTemplateIndex]);
  const applyTemplate = (index, templateId) => {
    const template = templates.find((item) => item.id === templateId);
    setOpenTemplateIndex(-1);
    setTemplateError("");
    setDocs(docs.map((item, i) => i === index ? {
      ...item,
      templateId,
      title: templateId ? template?.title || item.title || "" : "",
      prompt: templateId ? template?.prompt || item.prompt || "" : ""
    } : item));
  };
  const openNewTemplate = (index) => {
    const doc = docs[index] || {};
    setTemplateError("");
    setTemplateModal({ open: true, targetIndex: index, title: doc.title || "", prompt: doc.prompt || "" });
  };
  const deleteTemplate = async (templateId) => {
    if (!templateId || templateDeletingId) return;
    const template = templates.find((item) => item.id === templateId);
    if (!template) return;
    if (!window.confirm(`删除模板「${template.title}」？已使用该模板的额外文件会保留当前内容。`)) return;
    setTemplateError("");
    setTemplateDeletingId(templateId);
    try {
      const res = await apiFetch(`/api/templates/${encodeURIComponent(templateId)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "模板删除失败");
      setTemplates(templates.filter((item) => item.id !== templateId));
      setDocs(docs.map((item) => item.templateId === templateId ? { ...item, templateId: "" } : item));
    } catch (err) {
      setTemplateError(err.message || "模板删除失败。");
    } finally {
      setTemplateDeletingId("");
    }
  };
  const saveTemplateFromRow = async (index) => {
    if (templateSavingIndex >= 0) return;
    const doc = docs[index] || {};
    const title = String(doc.title || "").trim();
    const prompt = String(doc.prompt || "").trim();
    if (!title || !prompt) return;
    setTemplateError("");
    setTemplateSavingIndex(index);
    try {
      const res = await apiFetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, prompt })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "模板保存失败");
      const template = data.template;
      setTemplates([template, ...templates]);
      setDocs(docs.map((item, i) => i === index ? {
        ...item,
        templateId: template.id,
        title: template.title,
        prompt: template.prompt
      } : item));
    } catch (err) {
      setTemplateError(err.message || "模板保存失败。");
    } finally {
      setTemplateSavingIndex(-1);
    }
  };
  const createTemplate = async (event) => {
    event.preventDefault();
    if (templateSaving) return;
    const title = templateModal.title.trim();
    const prompt = templateModal.prompt.trim();
    if (!title || !prompt) return;
    setTemplateError("");
    setTemplateSaving(true);
    try {
      const res = await apiFetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, prompt })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "模板保存失败");
      const template = data.template;
      setTemplates([template, ...templates]);
      if (templateModal.targetIndex >= 0) {
        setDocs(docs.map((item, i) => i === templateModal.targetIndex ? {
          ...item,
          templateId: template.id,
          title: template.title,
          prompt: template.prompt
        } : item));
      }
      setTemplateModal({ open: false, targetIndex: -1, title: "", prompt: "" });
    } catch (err) {
      setTemplateError(err.message || "模板保存失败。");
    } finally {
      setTemplateSaving(false);
    }
  };
  const Container = embedded ? "div" : "section";
  const docSummary = docs.length ? `已配置 ${docs.length} 个额外文件` : "不需要额外版本时保持为空";

  return (
    <>
      <Container className={embedded ? "extraDocsEmbedded" : "panel"}>
        <div className={embedded ? "extraDocsHead" : "panelHead"}>
          <div>
            <h2>额外文件</h2>
            <p>选择模板后生成扩写、问答、大纲或其他版本。{embedded ? ` ${docSummary}。` : ""}</p>
          </div>
          <div className="panelActions">
            {docs.length > 0 && (
              <label className="checkLine inline">
                <input type="checkbox" checked={smartTitleEnabled} onChange={(e) => setSmartTitleEnabled(e.target.checked)} />
                生成后统一命名
              </label>
            )}
            {embedded && docs.length > 0 && (
              <button type="button" className="btn" onClick={() => setExpanded((value) => !value)}>
                {expanded ? "收起" : "展开"}
              </button>
            )}
            <button className="btn" onClick={addDoc}><Plus size={16} />添加</button>
          </div>
        </div>
        {!templateModal.open && templateError && <div className="inlineError">{templateError}</div>}
        {docs.length === 0 && !embedded && <div className="empty compact">不需要额外版本时保持为空。</div>}
        {embedded && docs.length > 0 && !expanded && <div className="outputHint">额外文件已折叠，提交时会一起生成。</div>}
        {(!embedded || expanded) && (
        <div className="docRows">
          {docs.map((doc, index) => (
            <div className="docRow" key={index}>
              <div className="docTemplatePane">
                {(() => {
                  const selectedTemplate = templates.find((template) => template.id === doc.templateId);
                  const canSaveTemplate = !doc.templateId && doc.title?.trim() && doc.prompt?.trim();
                  return (
                    <>
                <label className="docField">用户模板
                  <div className="templateSelectWrap">
                    <button
                      type="button"
                      className={`templateSelectButton ${openTemplateIndex === index ? "open" : ""}`}
                      onClick={() => setOpenTemplateIndex(openTemplateIndex === index ? -1 : index)}
                    >
                      <span>{selectedTemplate?.title || "选择模板"}</span>
                      <ArrowDown size={16} />
                    </button>
                    {openTemplateIndex === index && (
                      <div className="templateMenu">
                        <button type="button" className={!doc.templateId ? "active" : ""} onClick={() => applyTemplate(index, "")}>选择模板</button>
                        {templates.map((template) => (
                          <button
                            type="button"
                            key={template.id}
                            className={doc.templateId === template.id ? "active" : ""}
                            onClick={() => applyTemplate(index, template.id)}
                          >
                            {template.title}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </label>
                <div className="templateActions">
                  <button className="btn subtleBtn" onClick={() => openNewTemplate(index)}><Plus size={15} />新建模板</button>
                  {doc.templateId ? (
                    <button
                      className="templateTextAction danger"
                      disabled={templateDeletingId === doc.templateId}
                      onClick={() => deleteTemplate(doc.templateId)}
                    >
                      {templateDeletingId === doc.templateId ? "删除中" : "删除模板"}
                    </button>
                  ) : canSaveTemplate && (
                    <button
                      className="templateTextAction save"
                      disabled={templateSavingIndex === index}
                      onClick={() => saveTemplateFromRow(index)}
                    >
                      {templateSavingIndex === index ? "保存中" : "保存模板"}
                    </button>
                  )}
                </div>
                    </>
                  );
                })()}
              </div>
              <div className="docFields">
                <div className="docTopLine">
                  <label className="docField docName">文件名
                    <input placeholder="演讲稿 / 内容大纲 / 用户问答" value={doc.title} onChange={(e) => setDocs(docs.map((item, i) => i === index ? { ...item, title: e.target.value, templateId: item.templateId || "" } : item))} />
                  </label>
                  <button className="miniBtn danger" title="删除" onClick={() => setDocs(docs.filter((_, i) => i !== index))}><Trash2 size={15} /></button>
                </div>
                <label className="docField docPrompt">提示词
                  <textarea placeholder="例如：请扩写成专家演讲稿，不少于 4000 字；或生成内容大纲、用户问答。" value={doc.prompt} onChange={(e) => setDocs(docs.map((item, i) => i === index ? { ...item, prompt: e.target.value, templateId: item.templateId || "" } : item))} />
                </label>
                <div className={`formatRequirementBox ${doc.formatEnabled ? "open" : ""}`}>
                  <label className="checkLine formatToggle">
                    <input
                      type="checkbox"
                      checked={Boolean(doc.formatEnabled)}
                      onChange={(e) => setDocs(docs.map((item, i) => i === index ? { ...item, formatEnabled: e.target.checked } : item))}
                    />
                    输出格式
                  </label>
                  <div className="formatRequirementBody">
                    <label className="docField">格式要求
                      <textarea
                        placeholder="例如：一级标题宋体二号加粗；正文仿宋三号，固定行距 28 磅，首行缩进 2 字符，两端对齐。"
                        value={doc.formatRequirement || ""}
                        onChange={(e) => setDocs(docs.map((item, i) => i === index ? { ...item, formatRequirement: e.target.value } : item))}
                      />
                    </label>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
        )}
      </Container>

      {templateModal.open && (
        <div className="modalOverlay" role="presentation" onMouseDown={(event) => {
          if (!templateSaving && event.target === event.currentTarget) setTemplateModal({ open: false, targetIndex: -1, title: "", prompt: "" });
        }}>
          <form className="templateModal panel" onSubmit={createTemplate}>
            <div className="panelHead compactHead">
              <div>
                <h2>新建模板</h2>
                <p>保存后可在额外文件里重复选择。</p>
              </div>
            </div>
            <label className="field">模板名称
              <input value={templateModal.title} onChange={(e) => setTemplateModal((old) => ({ ...old, title: e.target.value }))} placeholder="例如：专家演讲稿" autoFocus />
            </label>
            <label className="field">提示词
              <textarea value={templateModal.prompt} onChange={(e) => setTemplateModal((old) => ({ ...old, prompt: e.target.value }))} placeholder="写给模型的处理要求" />
            </label>
            {templateError && <div className="inlineError">{templateError}</div>}
            <div className="modalActions">
              <button type="button" className="btn" disabled={templateSaving} onClick={() => setTemplateModal({ open: false, targetIndex: -1, title: "", prompt: "" })}>取消</button>
              <button className="primary compactPrimary" disabled={templateSaving || !templateModal.title.trim() || !templateModal.prompt.trim()}>
                {templateSaving ? "保存中" : "保存模板"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

function OutputFormatPanel({ enabled, setEnabled, value, setValue }) {
  return (
    <div className="outputSetting formatPanel">
      <div className="outputSettingHead formatHead">
        <div>
          <h2>输出格式</h2>
          <p>需要统一格式时开启，会随额外文件提示词一起发送给 AI。</p>
        </div>
        <label className="checkLine inline formatToggle">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          <span>填写格式要求</span>
        </label>
      </div>
      <div className={`formatBody ${enabled ? "open" : ""}`}>
        <label className="field">格式要求
          <textarea
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="例如：使用一级/二级标题；每段不超过 200 字；结尾输出表格；问答按“问题 / 回答 / 依据”格式呈现。"
          />
        </label>
      </div>
    </div>
  );
}

function friendlyJobError(job) {
  const detail = String(job.errorSummary || job.error || "").trim();
  if (job.status === "done") {
    return { headline: "部分额外文件生成失败，可点击「重试失败部分」重新生成。", detail };
  }
  const rules = [
    [/未登录|登录态|登录已失效|重新登录|Cookies|BDUSS/i, "网盘登录已失效，请到「模型配置 → 网盘账号登录」重新登录后重试。"],
    [/磁盘|空间不足/i, "服务器磁盘空间不足，请联系管理员清理缓存后再试。"],
    [/免费额度|FreeTier|额度已用完/i, "AI 免费额度已用完，请更换模型或检查账户额度。"],
    [/超时|timed out|timeout/i, "处理超时，可能是网络不稳定或文件过大，请稍后重试。"],
    [/yt-dlp|页面解析|视频页面/i, "视频页面解析失败，请确认链接有效，或改用音视频直链。"],
    [/缺少.*API Key|API Key/i, "模型 API Key 缺失或无效，请到「模型配置」检查后重试。"],
    [/转写/i, "语音转写失败，请确认音频有效或稍后重试。"]
  ];
  for (const [pattern, message] of rules) {
    if (pattern.test(detail)) return { headline: message, detail };
  }
  const firstLine = detail.split("\n")[0].slice(0, 120);
  return { headline: firstLine || "任务失败，请稍后重试。", detail };
}

function JobError({ job }) {
  const [open, setOpen] = useState(false);
  const { headline, detail } = friendlyJobError(job);
  const hasDetail = Boolean(detail) && detail.trim() !== headline.trim();
  return (
    <div className={`jobErrBox ${job.status === "done" ? "warn" : ""}`}>
      <div className="jobErrLine">
        <span className="jobErrMsg">{headline}</span>
        {hasDetail && (
          <button type="button" className="jobErrToggle" onClick={() => setOpen((value) => !value)}>
            {open ? "收起详情" : "查看详情"}
          </button>
        )}
      </div>
      {open && hasDetail && <pre className="jobErr">{detail}</pre>}
    </div>
  );
}

const REVIEW_RISK_LABELS = {
  none: "无风险",
  low: "低风险",
  medium: "中风险",
  high: "高风险"
};

function reviewStatusText(job) {
  const review = job.review;
  if (job.reviewLocked) return "高风险审查未放行";
  if (!review && job.reviewStatus === "running") return "审查中";
  if (!review && job.reviewStatus === "error") return "审查失败";
  if (!review) return "";
  if (review.status === "running") return "审查中";
  if (review.status === "error") return "审查失败";
  if (review.status === "done") return `审查通过 · ${REVIEW_RISK_LABELS[review.riskLevel] || review.riskLevel || "已审查"}`;
  return "";
}

function ReviewResultModal({ job, onClose }) {
  const review = job?.review;
  const files = review?.result?.files || [];
  return (
    <div className="modalOverlay" role="presentation" onMouseDown={onClose}>
      <section className="templateModal reviewModal panel" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modalHead">
          <div>
            <h2>审查结果</h2>
            <p>{job?.title || "任务"} · {REVIEW_RISK_LABELS[review?.riskLevel] || review?.riskLevel || "未完成"}</p>
          </div>
          <button className="iconBtn" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </div>
        {review?.error && <div className="inlineError">{review.error}</div>}
        {files.length === 0 ? (
          <div className="usageEmpty">暂无可展示的审查明细。</div>
        ) : (
          <div className="reviewFiles">
            {files.map((file, index) => (
              <article className={`reviewFile risk-${file.riskLevel || "none"}`} key={`${file.label}-${index}`}>
                <header>
                  <strong>{file.label || `文件 ${index + 1}`}</strong>
                  <span>{REVIEW_RISK_LABELS[file.riskLevel] || file.riskLevel || "未标记"}</span>
                </header>
                {file.summary && <p>{file.summary}</p>}
                {!!file.issues?.length && (
                  <ul>
                    {file.issues.map((issue, issueIndex) => (
                      <li key={issueIndex}>
                        <b>{issue.rule || "问题"}</b>
                        <span>{issue.evidence || issue.description || issue.suggestion || "未提供说明"}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function JobList({ jobs, onDelete, onRetry, onRetryExtra, onRetryReview, queueState, onResume }) {
  const doneJobs = jobs.filter((job) => (job.outputFiles?.length || job.outputUrl) && !job.reviewLocked);
  const [downloadError, setDownloadError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [singleDownloading, setSingleDownloading] = useState("");
  const [reviewModalJob, setReviewModalJob] = useState(null);

  async function downloadAll() {
    if (!doneJobs.length || downloading) return;
    setDownloadError("");
    setDownloading(true);
    try {
      const res = await apiFetch(`/api/downloads/all.zip?ids=${encodeURIComponent(doneJobs.map((job) => job.id).join(","))}`);
      if (!res.ok) {
        const text = await res.text();
        let message = text;
        try {
          message = JSON.parse(text).error || text;
        } catch {
          // Keep the raw response text.
        }
        throw new Error(message || `批量下载失败：${res.status}`);
      }
      await saveBlobResponse(res, "video-to-word.zip");
    } catch (err) {
      setDownloadError(err.message || "批量下载失败，请稍后重试。");
    } finally {
      setDownloading(false);
    }
  }

  async function downloadOne(file, job) {
    if (!file?.url || job.reviewLocked || singleDownloading) return;
    setDownloadError("");
    setSingleDownloading(file.url);
    try {
      const res = await apiFetch(file.url);
      if (!res.ok) throw new Error(await readErrorResponse(res, "文件下载失败"));
      const fallbackExt = file.extension || (file.type === "okf" ? ".zip" : ".docx");
      await saveBlobResponse(res, `${file.label || "文件"}${fallbackExt}`);
    } catch (err) {
      setDownloadError(err.message || "文件下载失败，请稍后重试。");
    } finally {
      setSingleDownloading("");
    }
  }

  return (
    <section className="panel">
      <div className="panelHead jobsHead">
        <h2>任务</h2>
        <button className="batchDownload" disabled={!doneJobs.length || downloading} onClick={downloadAll}>
          <Archive size={15} />{downloading ? "打包中" : "批量下载"}
        </button>
      </div>
      {downloadError && <div className="inlineError">{downloadError}</div>}
      {reviewModalJob && <ReviewResultModal job={reviewModalJob} onClose={() => setReviewModalJob(null)} />}
      {queueState?.paused && (
        <div className="queuePaused">
          <div>
            <strong>队列已暂停</strong>
            <span>{queueState.reason || "额外文件生成失败，已暂停后续任务。"}</span>
          </div>
          <button className="btn" onClick={onResume}>恢复处理</button>
        </div>
      )}
      <div className="jobs">
        {jobs.length === 0 && (
          <div className="emptyJobs">
            <div className="ring"><FileText size={22} /></div>
            <span>还没有任务，添加链接并开始转写后会显示在这里。</span>
          </div>
        )}
        {jobs.map((job) => {
          const files = job.outputFiles || (job.outputUrl ? [{ label: "Word", url: job.outputUrl }] : []);
          const barClass = job.status === "done" ? "done" : job.status === "error" ? "err" : "";
          const dotClass = job.status === "running" ? "run" : job.status === "done" ? "done" : job.status === "error" ? "err" : "queue";
          const statusText = { running: "处理中", done: "已完成", error: "失败", queued: "排队中" }[job.status] || "排队中";
          const usage = job.usageSummary;
          const phaseText = job.phaseIndex && job.phaseTotal ? `${job.phaseIndex}/${job.phaseTotal}` : "";
          const reviewText = job.reviewEnabled ? reviewStatusText(job) : "";
          const barValue = job.status === "done"
            ? 100
            : Math.max(0, Math.min(100, Math.round(Number(job.progress ?? 0))));
          return (
            <div className="job tile" key={job.id}>
              <div className="jobMain">
                <div className="jobMeta">
                  <span className="title">{job.order + 1}. {job.title}</span>
                  <span className="jobStatus"><span className={`dot ${dotClass}`}></span>{phaseText && <b>{phaseText}</b>}{job.step} · {statusText}</span>
                  {job.status === "running" && job.downloadSpeed && (
                    <span className="downloadStat">
                      下载速度 {job.downloadSpeed}
                      {job.downloadedBytes ? ` · 已下载 ${formatBytes(job.downloadedBytes)}` : ""}
                    </span>
                  )}
                  {usage?.records > 0 && (
                    <span className="usageStat">
                      {formatJobUsage(usage)}
                    </span>
                  )}
                  {reviewText && (
                    <span className={`reviewStat ${job.reviewLocked ? "locked" : job.review?.riskLevel || job.reviewStatus || ""}`}>
                      <ShieldCheck size={14} />{reviewText}
                    </span>
                  )}
                </div>
                <div className="bar">
                  <div className="barTrack"><div className={`barFill ${barClass}`} style={{ width: `${barValue}%` }} /></div>
                  <span className="barPct">{barValue}%</span>
                </div>
              </div>
              <div className="jobFooter">
                {job.error && <JobError job={job} />}
                {job.reviewEnabled && job.review?.error && <div className="jobErrMsg">审查失败：{job.review.error}</div>}
                <div className="downloads">
                  {files.map((file) => (
                    <button
                      className={`chip ${job.reviewLocked ? "disabled" : ""}`}
                      key={file.url}
                      disabled={job.reviewLocked || singleDownloading === file.url}
                      onClick={() => downloadOne(file, job)}
                      title={job.reviewLocked ? "高风险审查未放行" : ""}
                    >
                      <Download size={15} />{singleDownloading === file.url ? "下载中" : file.label}
                    </button>
                  ))}
                  {job.reviewEnabled && job.review && (
                    <button className="chip inspect" onClick={() => setReviewModalJob(job)}><Eye size={15} />审查结果</button>
                  )}
                  {job.reviewEnabled && (job.review?.status === "error" || job.reviewStatus === "error") && (
                    <button className="chip retry" onClick={() => onRetryReview(job.id)}><RefreshCw size={15} />重试审查</button>
                  )}
                  {job.status === "error" && (
                    <button className="chip retry" onClick={() => onRetry(job.id)}><RefreshCw size={15} />重试</button>
                  )}
                  {job.retryableExtraFailure && job.status !== "running" && (
                    <button className="chip retry" onClick={() => onRetryExtra(job.id)}>重试失败部分</button>
                  )}
                  {job.status !== "running" && <button className="chip ghost" onClick={() => onDelete(job.id)}><Trash2 size={15} />删除</button>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function OkfPanel({ enabled, setEnabled, options, setOptions }) {
  function patchOptions(patch) {
    setOptions((old) => ({ ...old, ...patch }));
  }

  return (
    <div className="outputSetting okfPanel">
      <div className="outputSettingHead formatHead">
        <div>
          <h2>OKF 知识格式</h2>
          <p>生成 Markdown 知识资产 ZIP，便于 Agent、RAG 和知识库复用。</p>
        </div>
        <label className="checkLine inline formatToggle">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          <span>生成 OKF</span>
        </label>
      </div>
      {enabled && (
        <div className="okfBody open">
          <div className="okfHint">
            <span>输出目录包含 knowledge/rules、knowledge/metrics、knowledge/sop 和 manifest.json。</span>
          </div>
          <details className="okfAdvanced">
            <summary>高级设置</summary>
            <div className="okfFields">
              <label className="field">负责人
                <input value={options.owner || ""} onChange={(event) => patchOptions({ owner: event.target.value })} placeholder="例如：销售管理部 / AI 中台" />
              </label>
              <label className="field">版本
                <input value={options.version || ""} onChange={(event) => patchOptions({ version: event.target.value })} placeholder="1.0" />
              </label>
              <label className="field full">标签
                <input value={options.tags || ""} onChange={(event) => patchOptions({ tags: event.target.value })} placeholder="用逗号分隔，例如：制度, 销售, SOP" />
              </label>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

function OutputSettings({
  docs,
  setDocs,
  formatEnabled,
  setFormatEnabled,
  formatRequirement,
  setFormatRequirement,
  okfEnabled,
  setOkfEnabled,
  okfOptions,
  setOkfOptions,
  canStart,
  submitState,
  onSubmit,
  linkCount
}) {
  const outputSummary = [
    "Word 文档默认生成",
    okfEnabled ? "OKF ZIP" : "",
    docs.length ? `${docs.length} 个额外文件` : "",
    formatEnabled ? "已填写格式要求" : ""
  ].filter(Boolean).join(" · ");

  return (
    <section className="panel outputSettings">
      <div className="panelHead outputSettingsHead">
        <div>
          <h2>输出设置</h2>
          <p>{outputSummary}</p>
        </div>
      </div>

      <div className="defaultOutput">
        <FileText size={18} />
        <div>
          <strong>Word 文档</strong>
          <span>默认输出，保持现有下载和审查流程。</span>
        </div>
      </div>

      <div className="outputSettingsGrid">
        <OutputFormatPanel
          enabled={formatEnabled}
          setEnabled={setFormatEnabled}
          value={formatRequirement}
          setValue={setFormatRequirement}
        />
        <OkfPanel
          enabled={okfEnabled}
          setEnabled={setOkfEnabled}
          options={okfOptions}
          setOptions={setOkfOptions}
        />
        <ExtraDocs docs={docs} setDocs={setDocs} embedded />
      </div>

      <div className="submitBar">
        <div>
          <strong>准备提交</strong>
          <span>{linkCount ? `${linkCount} 个来源会加入任务队列` : "先添加至少一个链接"}</span>
        </div>
        <button className="primary" disabled={!canStart || submitState.loading} onClick={onSubmit}>
          <Play size={17} />{submitState.loading ? "提交中" : "开始转写"}
        </button>
      </div>
    </section>
  );
}

function NetdiskStatusBar({ onGoConfig }) {
  const [statuses, setStatuses] = useState({ baidu: null, quark: null });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all(["baidu", "quark"].map((provider) =>
      apiFetch(`/api/netdisk/status?provider=${provider}`)
        .then((r) => r.json())
        .then((data) => [provider, data])
        .catch(() => [provider, null])
    )).then((entries) => {
      if (cancelled) return;
      setStatuses(Object.fromEntries(entries));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <section className="netdiskBar">
      {["baidu", "quark"].map((provider) => {
        const status = statuses[provider];
        const loggedIn = Boolean(status?.loggedIn);
        const name = NETDISK_PROVIDERS[provider].name;
        return (
          <span key={provider} className={`netdiskStatusBadge ${loading ? "pending" : loggedIn ? "ok" : "off"}`}>
            <span className="netdiskDot" />
            {name}：{loading ? "检查中" : loggedIn ? `已登录${status.account ? ` ${status.account}` : ""}` : "未登录"}
          </span>
        );
      })}
      {!loading && !statuses.baidu?.loggedIn && !statuses.quark?.loggedIn && (
        <button type="button" className="netdiskBarLink" onClick={onGoConfig}>去登录</button>
      )}
    </section>
  );
}

function RoadmapNotice() {
  const items = [
    { icon: <Mic size={15} />, text: "V2W 后续以性能优化、稳定性提升和 BUG 修复为主" },
    { icon: <Layers size={15} />, text: "V2K 支持将 Word、视频、音频和结构化知识统一整理为 OKF" },
    { icon: <Folder size={15} />, text: "V2K 将提供线上知识存储、统一管理和基础问答能力" }
  ];
  return (
    <details className="roadmapNotice" aria-label="后续更新预告">
      <summary className="roadmapNoticeHead">
        <span>后续更新预告</span>
        <strong>V2W 进入维护期，新能力将在 V2K 更新</strong>
        <p>V2W 后续不再继续堆叠新功能，主要保障现有转写、Word 和 OKF 流程更快、更稳；新的知识管理能力会迁移到 V2K 平台。</p>
      </summary>
      <div className="roadmapNoticeItems">
        {items.map((item) => (
          <span key={item.text}>
            {item.icon}
            {item.text}
          </span>
        ))}
      </div>
    </details>
  );
}

function WorkPage({ mode, providerState, oss, jobs, setJobs, queueState, onDelete, onRetry, onRetryExtra, onRetryReview, onResume, onGoConfig }) {
  const draftKey = `${WORK_DRAFT_KEY_PREFIX}-${mode}`;
  const initialDraft = useMemo(() => normalizeWorkDraft(readJson(draftKey, null)), [draftKey]);
  const [links, setLinks] = useState(initialDraft.links);
  const [bulkText, setBulkText] = useState(initialDraft.bulkText);
  const [docs, setDocs] = useState(initialDraft.docs);
  const [formatEnabled, setFormatEnabled] = useState(initialDraft.formatEnabled);
  const [formatRequirement, setFormatRequirement] = useState(initialDraft.formatRequirement);
  const [okfEnabled, setOkfEnabled] = useState(initialDraft.okfEnabled);
  const [okfOptions, setOkfOptions] = useState(initialDraft.okfOptions);
  const [submitState, setSubmitState] = useState({ loading: false, message: "", error: "" });
  const jobSectionRef = useRef(null);
  const isCloud = mode === "cloud";
  const linkCount = links.filter((item) => item.link.trim()).length;
  const canStart = linkCount > 0;

  useEffect(() => {
    localStorage.setItem(draftKey, JSON.stringify({ links, bulkText, docs, formatEnabled, formatRequirement, okfEnabled, okfOptions }));
  }, [draftKey, links, bulkText, docs, formatEnabled, formatRequirement, okfEnabled, okfOptions]);

  useEffect(() => {
    setSubmitState((state) => {
      if (state.loading || (!state.error && !state.message)) return state;
      return { loading: false, message: "", error: "" };
    });
  }, [links, bulkText, docs, formatEnabled, formatRequirement, okfEnabled, okfOptions, mode]);

  async function submit() {
    const normalizedLinks = links
      .filter((item) => item.link.trim())
      .map((item) => ({ ...item, link: isCloud ? normalizeShareLink(item.link) : item.link.trim() }));
    const validLinks = normalizedLinks;
    if (isCloud) {
      const cloudError = validateCloudLinks(validLinks);
      if (cloudError) {
        setSubmitState({ loading: false, message: "", error: cloudError });
        return;
      }
    }
    const eta = estimateProcessingTime(validLinks.length, mode, docs.filter((doc) => doc.prompt?.trim()).length, jobs);
    setSubmitState({ loading: true, message: "", error: "" });
    try {
      const res = await apiFetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          links: validLinks,
          extraPrompts: docs,
          formatRequirement: formatEnabled ? formatRequirement : "",
          okfEnabled,
          okfOptions,
          concurrency: 5,
          settings: buildJobRuntimeSettings(!isCloud)
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "任务提交失败");
      const created = data.jobs || [];
      setJobs((old) => [...old, ...created]);
      setSubmitState({
        loading: false,
        message: `任务提交成功：${created.length} 个任务已加入队列，并发 5 个处理，预计完成时间 ${eta}。`,
        error: ""
      });
      setTimeout(() => jobSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    } catch (err) {
      setSubmitState({ loading: false, message: "", error: err.message || "任务提交失败，请检查配置。" });
    }
  }

  return (
    <>
      <section className="pageHeader">
        <div className="pageHeaderText">
          <span>{isCloud ? "网盘来源" : "直链来源"}</span>
          <h1>新建转写任务</h1>
          <p>{isCloud ? "粘贴百度网盘或夸克网盘分享链接，生成 Word、OKF 或额外文档。" : "粘贴音视频直链或可解析的视频页面，生成 Word、OKF 或额外文档。"}</p>
        </div>
        <div className="headerModeBadge">{isCloud ? "网盘任务" : "直链任务"}</div>
      </section>

      {isCloud && <NetdiskStatusBar onGoConfig={onGoConfig} />}

      {(submitState.message || submitState.error) && (
        <section className={submitState.error ? "submitNotice err" : "submitNotice"}>
          {submitState.error || submitState.message}
        </section>
      )}

      <LinkBuilder
        title={isCloud ? "网盘链接" : "视频链接"}
        desc={isCloud ? "每行一个分享链接，可带提取码。" : "每行一个链接，可填写标题。"}
        placeholder={isCloud ? "批量粘贴：\n第一课 https://pan.baidu.com/s/xxxx 提取码 abcd\n第二课 https://pan.quark.cn/s/yyyy 提取码 efgh" : "批量粘贴：\n第一课 https://example.com/1.mp4\n第二课 https://www.bilibili.com/video/BVxxxx"}
        links={links}
        setLinks={setLinks}
        bulkText={bulkText}
        setBulkText={setBulkText}
        showMove={!isCloud}
      />
      <OutputSettings
        docs={docs}
        setDocs={setDocs}
        formatEnabled={formatEnabled}
        setFormatEnabled={setFormatEnabled}
        formatRequirement={formatRequirement}
        setFormatRequirement={setFormatRequirement}
        okfEnabled={okfEnabled}
        setOkfEnabled={setOkfEnabled}
        okfOptions={okfOptions}
        setOkfOptions={setOkfOptions}
        canStart={canStart}
        submitState={submitState}
        onSubmit={submit}
        linkCount={linkCount}
      />
      <div ref={jobSectionRef}>
        <JobList jobs={jobs} onDelete={onDelete} onRetry={onRetry} onRetryExtra={onRetryExtra} onRetryReview={onRetryReview} queueState={queueState} onResume={onResume} />
      </div>
      <RoadmapNotice />
    </>
  );
}

function UsagePage({ user }) {
  const [range, setRange] = useState("month");
  const [summary, setSummary] = useState(null);
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function loadUsage(activeRange = range) {
    setLoading(true);
    setError("");
    try {
      const [summaryRes, recordsRes] = await Promise.all([
        apiFetch(`/api/usage/summary?range=${activeRange}`),
        apiFetch(`/api/usage/records?range=${activeRange}&page=1&pageSize=80`)
      ]);
      const summaryData = await summaryRes.json();
      const recordsData = await recordsRes.json();
      if (!summaryRes.ok) throw new Error(summaryData.error || "用量汇总读取失败");
      if (!recordsRes.ok) throw new Error(recordsData.error || "用量明细读取失败");
      setSummary(summaryData.summary);
      setRecords(recordsData.records || []);
    } catch (err) {
      setError(err.message || "用量统计读取失败。");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadUsage(range);
  }, [range]);

  const modelRows = summary?.byModel || [];

  return (
    <>
      <section className="configTop panel">
        <div>
          <h1>个人中心</h1>
          <p>查看个人转写任务、Word/OKF 输出相关用量和模型消耗。</p>
        </div>
        <div className="saveGroup">
          <span>{user?.username}</span>
          <button className="btn" onClick={() => loadUsage(range)}>{loading ? "刷新中" : "刷新"}</button>
        </div>
      </section>

      <section className="panel usagePanel">
        <div className="panelHead compactHead">
          <div>
            <h2>用量概览</h2>
            <p>按当前模型配置估算。</p>
          </div>
          <div className="usageRange">
            <button className={range === "today" ? "active" : ""} onClick={() => setRange("today")}>今日</button>
            <button className={range === "month" ? "active" : ""} onClick={() => setRange("month")}>本月</button>
          </div>
        </div>

        {error && <div className="inlineError">{error}</div>}

        <div className="usageCards">
          <div className="usageCard">
            <span>ASR 音频时长</span>
            <strong>{formatSeconds(summary?.asrSeconds || 0)}</strong>
          </div>
          <div className="usageCard">
            <span>AI 用量</span>
            <strong>{formatNumber(summary?.llmTokens || 0)}</strong>
          </div>
          <div className="usageCard">
            <span>调用记录</span>
            <strong>{formatNumber(summary?.records || 0)}</strong>
          </div>
          <div className="usageCard">
            <span>预估成本</span>
            <strong>{formatUsageCost(summary)}</strong>
          </div>
        </div>
      </section>

      <section className="panel usagePanel">
        <div className="panelHead compactHead">
          <div>
            <h2>模型分布</h2>
            <p>按服务和模型汇总消耗。</p>
          </div>
        </div>
        <div className="usageTable">
          <div className="usageTableHead">
            <span>类型</span><span>服务商</span><span>模型</span><span>用量</span><span>成本</span>
          </div>
          {modelRows.length === 0 && <div className="usageEmpty">暂无用量数据。</div>}
          {modelRows.map((row, index) => (
            <div className="usageTableRow" key={`${row.type}-${row.provider}-${row.model}-${index}`}>
              <span>{row.type === "asr" ? "ASR" : "AI 处理"}</span>
              <span>{row.provider || "-"}</span>
              <span>{row.model || "-"}</span>
              <span>{row.type === "asr" ? formatSeconds(row.metricValue) : `${formatNumber(row.totalTokens)} tokens`}</span>
              <span>{formatCost(row.estimatedCost)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel usagePanel">
        <div className="panelHead compactHead">
          <div>
            <h2>用量明细</h2>
            <p>最近 80 条调用记录。</p>
          </div>
        </div>
        <div className="usageTable usageRecords">
          <div className="usageTableHead">
            <span>时间</span><span>任务</span><span>类型</span><span>模型</span><span>用量</span>
          </div>
          {records.length === 0 && <div className="usageEmpty">暂无用量明细。</div>}
          {records.map((record) => (
            <div className="usageTableRow" key={record.id}>
              <span>{new Date(record.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
              <span>{record.jobTitle || "-"}</span>
              <span>{record.type === "asr" ? "ASR" : "AI 处理"}</span>
              <span>{record.model || "-"}</span>
              <span>
                {record.type === "asr"
                  ? formatSeconds(record.metricValue)
                  : `${formatNumber(record.totalTokens)} tokens`}
              </span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function AdminUsersPanel({
  users,
  resetUserId,
  setResetUserId,
  resetPassword,
  setResetPassword,
  resetMessage,
  onResetPassword,
  onToggleReviewEntitlement
}) {
  return (
    <>
      <div className="usageTable adminUsersTable">
        <div className="usageTableHead">
          <span>账号</span><span>身份</span><span>任务</span><span>本期用量</span><span>审查服务</span><span>创建时间</span>
        </div>
        {users.length === 0 && <div className="usageEmpty">暂无账号。</div>}
        {users.map((item) => (
          <div className="usageTableRow" key={item.id}>
            <span title={item.username}>{item.username}</span>
            <span>{item.isAdmin ? "管理员" : item.provider || "password"}</span>
            <span>总 {item.jobs?.total || 0} · 完成 {item.jobs?.done || 0} · 失败 {item.jobs?.error || 0}</span>
            <span>{formatJobUsage(item.usage || {})}</span>
            <span>
              <button type="button" className={`miniSwitch ${item.reviewEnabled ? "on" : ""}`} onClick={() => onToggleReviewEntitlement(item.id, !item.reviewEnabled)}>
                {item.reviewEnabled ? "已启用" : "未启用"}
              </button>
            </span>
            <span>{item.createdAt ? new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false }) : "-"}</span>
          </div>
        ))}
      </div>

      <form className="adminResetForm tile" onSubmit={onResetPassword}>
        <label className="field">选择账号
          <select value={resetUserId} onChange={(e) => setResetUserId(e.target.value)}>
            <option value="">选择要重置密码的账号</option>
            {users.filter((item) => item.provider === "password").map((item) => (
              <option key={item.id} value={item.id}>{item.username}</option>
            ))}
          </select>
        </label>
        <label className="field">新密码
          <input type="password" value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} placeholder="至少 6 位" />
        </label>
        <button className="primary compactPrimary" disabled={!resetUserId || resetPassword.length < 6}>重置密码</button>
        {resetMessage && <span className="adminOk">{resetMessage}</span>}
      </form>
    </>
  );
}

function AdminUsagePanel({ summary, records }) {
  const modelRows = summary?.byModel || [];
  const userRows = summary?.byUser || [];

  return (
    <>
      <div className="usageCards">
        <div className="usageCard">
          <span>ASR 音频时长</span>
          <strong>{formatSeconds(summary?.asrSeconds || 0)}</strong>
        </div>
        <div className="usageCard">
          <span>AI 用量</span>
          <strong>{formatNumber(summary?.llmTokens || 0)}</strong>
        </div>
        <div className="usageCard">
          <span>调用记录</span>
          <strong>{formatNumber(summary?.records || 0)}</strong>
        </div>
        <div className="usageCard">
          <span>预估成本</span>
          <strong>{formatUsageCost(summary)}</strong>
        </div>
      </div>

      <div className="usageTable adminUsageUsers">
        <div className="usageTableHead">
          <span>账号</span><span>ASR</span><span>AI 用量</span><span>记录</span><span>成本</span>
        </div>
        {userRows.length === 0 && <div className="usageEmpty">暂无用户用量。</div>}
        {userRows.map((row) => (
          <div className="usageTableRow" key={row.id}>
            <span>{row.username}</span>
            <span>{formatSeconds(row.asrSeconds)}</span>
            <span>{formatNumber(row.llmTokens)}</span>
            <span>{formatNumber(row.records)}</span>
            <span>{formatUsageCost(row)}</span>
          </div>
        ))}
      </div>

      <div className="usageTable">
        <div className="usageTableHead">
          <span>类型</span><span>服务商</span><span>模型</span><span>用量</span><span>成本</span>
        </div>
        {modelRows.length === 0 && <div className="usageEmpty">暂无模型用量。</div>}
        {modelRows.map((row, index) => (
          <div className="usageTableRow" key={`${row.type}-${row.provider}-${row.model}-${index}`}>
            <span>{row.type === "asr" ? "ASR" : "AI 处理"}</span>
            <span>{row.provider || "-"}</span>
            <span>{row.model || "-"}</span>
            <span>{row.type === "asr" ? formatSeconds(row.metricValue) : `${formatNumber(row.totalTokens)} tokens`}</span>
            <span>{formatCost(row.estimatedCost)}</span>
          </div>
        ))}
      </div>

      <div className="usageTable adminUsageRecords">
        <div className="usageTableHead">
          <span>时间</span><span>账号</span><span>任务</span><span>类型</span><span>模型</span><span>用量</span>
        </div>
        {records.length === 0 && <div className="usageEmpty">暂无用量明细。</div>}
        {records.map((record) => (
          <div className="usageTableRow" key={record.id}>
            <span>{new Date(record.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
            <span>{record.username || "-"}</span>
            <span>{record.jobTitle || "-"}</span>
            <span>{record.type === "asr" ? "ASR" : "AI 处理"}</span>
            <span>{record.model || "-"}</span>
            <span>{record.type === "asr" ? formatSeconds(record.metricValue) : `${formatNumber(record.totalTokens)} tokens`}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function AdminReviewRulesPanel({
  reviewRuleName,
  setReviewRuleName,
  reviewRuleVersion,
  setReviewRuleVersion,
  reviewRuleDraft,
  setReviewRuleDraft,
  reviewRulePacks,
  onImportRulePack,
  onActivateRulePack
}) {
  return (
    <div className="adminReviewGrid">
      <div className="tile adminReviewForm">
        <label className="field">规则包名称
          <input value={reviewRuleName} onChange={(e) => setReviewRuleName(e.target.value)} placeholder="例如：医药合规审查规则" />
        </label>
        <label className="field">版本
          <input value={reviewRuleVersion} onChange={(e) => setReviewRuleVersion(e.target.value)} placeholder="例如：2026-06" />
        </label>
        <label className="field full">Markdown 规则
          <textarea value={reviewRuleDraft} onChange={(e) => setReviewRuleDraft(e.target.value)} placeholder="# 规则包名称&#10;version: 2026-06&#10;&#10;## 高风险&#10;- ..." />
        </label>
        <button type="button" className="primary compactPrimary" onClick={onImportRulePack} disabled={!reviewRuleDraft.trim()}>导入规则包</button>
      </div>
      <div className="usageTable adminRuleTable">
        <div className="usageTableHead">
          <span>名称</span><span>版本</span><span>状态</span><span>创建时间</span><span>操作</span>
        </div>
        {reviewRulePacks.length === 0 && <div className="usageEmpty">暂无规则包。</div>}
        {reviewRulePacks.map((pack) => (
          <div className="usageTableRow" key={pack.id}>
            <span title={pack.name}>{pack.name}</span>
            <span>{pack.version || "-"}</span>
            <span>{pack.active ? "当前启用" : "未启用"}</span>
            <span>{pack.createdAt ? new Date(pack.createdAt).toLocaleString("zh-CN", { hour12: false }) : "-"}</span>
            <span><button type="button" className="miniSwitch on" disabled={pack.active} onClick={() => onActivateRulePack(pack.id)}>{pack.active ? "已启用" : "启用"}</button></span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AdminReviewConfigPanel({
  reviewConfig,
  setReviewConfig,
  onTestReviewModel,
  onSaveReviewConfig
}) {
  return (
    <div className="tile adminReviewForm">
      <label className="checkLine">
        <input type="checkbox" checked={Boolean(reviewConfig.enabled)} onChange={(e) => setReviewConfig((old) => ({ ...old, enabled: e.target.checked }))} />
        启用企业审查模型
      </label>
      <label className="field">API Key
        <input type="password" value={reviewConfig.apiKey || ""} onChange={(e) => setReviewConfig((old) => ({ ...old, apiKey: e.target.value }))} placeholder={reviewConfig.apiKey ? "已配置，留空不改" : "sk-..."} />
      </label>
      <label className="field">Base URL
        <input value={reviewConfig.baseUrl || ""} onChange={(e) => setReviewConfig((old) => ({ ...old, baseUrl: e.target.value }))} placeholder="https://.../v1" />
      </label>
      <label className="field">模型
        <input value={reviewConfig.model || ""} onChange={(e) => setReviewConfig((old) => ({ ...old, model: e.target.value }))} placeholder="例如：qwen-max" />
      </label>
      <label className="field">上下文预算 tokens
        <input type="number" min="10000" max="2000000" value={reviewConfig.contextLimitTokens || 1000000} onChange={(e) => setReviewConfig((old) => ({ ...old, contextLimitTokens: e.target.value }))} />
      </label>
      <div className="adminReviewActions">
        <button type="button" className="btn" onClick={onTestReviewModel}>测试连接</button>
        <button type="button" className="primary compactPrimary" onClick={onSaveReviewConfig}>保存配置</button>
      </div>
    </div>
  );
}

function AdminReviewManagePanel({
  reviewRuns,
  overrideReasons,
  setOverrideReasons,
  onOverrideReview
}) {
  return (
    <div className="usageTable adminReviewRuns">
      <div className="usageTableHead">
        <span>任务</span><span>状态</span><span>风险</span><span>模型</span><span>放行理由</span><span>操作</span>
      </div>
      {reviewRuns.length === 0 && <div className="usageEmpty">暂无待放行任务。</div>}
      {reviewRuns.map((run) => (
        <div className="usageTableRow" key={run.id}>
          <span title={run.jobId}>{run.jobId}</span>
          <span>{run.status || "-"}</span>
          <span>{REVIEW_RISK_LABELS[run.riskLevel] || run.riskLevel || "-"}</span>
          <span>{run.model || "-"}</span>
          <span>
            <input
              className="inlineInput"
              value={overrideReasons[run.jobId] || ""}
              onChange={(e) => setOverrideReasons((old) => ({ ...old, [run.jobId]: e.target.value }))}
              placeholder="填写放行理由"
            />
          </span>
          <span><button type="button" className="miniSwitch danger" onClick={() => onOverrideReview(run.jobId)}>放行</button></span>
        </div>
      ))}
    </div>
  );
}

function AdminPanelContent(props) {
  if (props.section === "users") {
    return (
      <AdminUsersPanel
        users={props.users}
        resetUserId={props.resetUserId}
        setResetUserId={props.setResetUserId}
        resetPassword={props.resetPassword}
        setResetPassword={props.setResetPassword}
        resetMessage={props.resetMessage}
        onResetPassword={props.onResetPassword}
        onToggleReviewEntitlement={props.onToggleReviewEntitlement}
      />
    );
  }
  if (props.section === "usage") {
    return <AdminUsagePanel summary={props.summary} records={props.records} />;
  }
  if (props.section === "reviewRules") {
    return (
      <AdminReviewRulesPanel
        reviewRuleName={props.reviewRuleName}
        setReviewRuleName={props.setReviewRuleName}
        reviewRuleVersion={props.reviewRuleVersion}
        setReviewRuleVersion={props.setReviewRuleVersion}
        reviewRuleDraft={props.reviewRuleDraft}
        setReviewRuleDraft={props.setReviewRuleDraft}
        reviewRulePacks={props.reviewRulePacks}
        onImportRulePack={props.onImportRulePack}
        onActivateRulePack={props.onActivateRulePack}
      />
    );
  }
  if (props.section === "reviewConfig") {
    return (
      <AdminReviewConfigPanel
        reviewConfig={props.reviewConfig}
        setReviewConfig={props.setReviewConfig}
        onTestReviewModel={props.onTestReviewModel}
        onSaveReviewConfig={props.onSaveReviewConfig}
      />
    );
  }
  if (props.section === "reviewManage") {
    return (
      <AdminReviewManagePanel
        reviewRuns={props.reviewRuns}
        overrideReasons={props.overrideReasons}
        setOverrideReasons={props.setOverrideReasons}
        onOverrideReview={props.onOverrideReview}
      />
    );
  }
  return <div className="usageEmpty">请选择管理功能。</div>;
}

function AdminPage() {
  const [section, setSection] = useState("users");
  const [range, setRange] = useState("month");
  const [users, setUsers] = useState([]);
  const [summary, setSummary] = useState(null);
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [resetUserId, setResetUserId] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const [resetMessage, setResetMessage] = useState("");
  const [reviewRulePacks, setReviewRulePacks] = useState([]);
  const [reviewConfig, setReviewConfig] = useState({ enabled: false, baseUrl: "", model: "", apiKey: "", contextLimitTokens: 1000000 });
  const [reviewRuns, setReviewRuns] = useState([]);
  const [reviewRuleDraft, setReviewRuleDraft] = useState("");
  const [reviewRuleName, setReviewRuleName] = useState("");
  const [reviewRuleVersion, setReviewRuleVersion] = useState("");
  const [reviewMessage, setReviewMessage] = useState("");
  const [overrideReasons, setOverrideReasons] = useState({});

  async function loadAdmin(activeRange = range) {
    setLoading(true);
    setError("");
    try {
      const [usersRes, summaryRes, recordsRes, packsRes, reviewConfigRes, reviewsRes] = await Promise.all([
        apiFetch(`/api/admin/users?range=${activeRange}`),
        apiFetch(`/api/admin/usage/summary?range=${activeRange}`),
        apiFetch(`/api/admin/usage/records?range=${activeRange}&page=1&pageSize=100`),
        apiFetch("/api/admin/review/rule-packs"),
        apiFetch("/api/admin/review/config"),
        apiFetch("/api/admin/reviews?locked=true")
      ]);
      const usersData = await usersRes.json();
      const summaryData = await summaryRes.json();
      const recordsData = await recordsRes.json();
      const packsData = await packsRes.json();
      const reviewConfigData = await reviewConfigRes.json();
      const reviewsData = await reviewsRes.json();
      if (!usersRes.ok) throw new Error(usersData.error || "账号列表读取失败");
      if (!summaryRes.ok) throw new Error(summaryData.error || "用量汇总读取失败");
      if (!recordsRes.ok) throw new Error(recordsData.error || "用量明细读取失败");
      if (!packsRes.ok) throw new Error(packsData.error || "审查规则读取失败");
      if (!reviewConfigRes.ok) throw new Error(reviewConfigData.error || "审查配置读取失败");
      if (!reviewsRes.ok) throw new Error(reviewsData.error || "审查记录读取失败");
      setUsers(usersData.users || []);
      setSummary(summaryData.summary);
      setRecords(recordsData.records || []);
      setReviewRulePacks(packsData.rulePacks || []);
      setReviewConfig((old) => ({ ...old, ...(reviewConfigData.config || {}) }));
      setReviewRuns(reviewsData.reviews || []);
    } catch (err) {
      setError(err.message || "管理后台读取失败。");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAdmin(range);
  }, [range]);

  async function resetPasswordForUser(e) {
    e.preventDefault();
    setResetMessage("");
    setError("");
    if (!resetUserId || !resetPassword) return;
    try {
      const res = await apiFetch(`/api/admin/users/${resetUserId}/password`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: resetPassword })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "密码重置失败");
      const target = users.find((item) => item.id === resetUserId);
      setResetMessage(`${target?.username || "账号"} 密码已重置`);
      setResetPassword("");
    } catch (err) {
      setError(err.message || "密码重置失败。");
    }
  }

  async function toggleReviewEntitlement(userId, enabled) {
    setError("");
    try {
      const res = await apiFetch(`/api/admin/users/${userId}/review-entitlement`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "审查服务开关保存失败");
      setUsers((old) => old.map((item) => item.id === userId ? { ...item, reviewEnabled: enabled } : item));
    } catch (err) {
      setError(err.message || "审查服务开关保存失败。");
    }
  }

  async function importRulePack() {
    setReviewMessage("");
    setError("");
    try {
      const res = await apiFetch("/api/admin/review/rule-packs/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: reviewRuleName, version: reviewRuleVersion, markdown: reviewRuleDraft })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "规则包导入失败");
      setReviewRuleDraft("");
      setReviewRuleName("");
      setReviewRuleVersion("");
      setReviewMessage("规则包已导入");
      loadAdmin(range);
    } catch (err) {
      setError(err.message || "规则包导入失败。");
    }
  }

  async function activateRulePack(id) {
    setReviewMessage("");
    setError("");
    try {
      const res = await apiFetch(`/api/admin/review/rule-packs/${id}/activate`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "规则包启用失败");
      setReviewRulePacks(data.rulePacks || []);
      setReviewMessage("规则包已启用");
    } catch (err) {
      setError(err.message || "规则包启用失败。");
    }
  }

  async function saveReviewConfig() {
    setReviewMessage("");
    setError("");
    try {
      const res = await apiFetch("/api/admin/review/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: reviewConfig })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "审查配置保存失败");
      setReviewConfig((old) => ({ ...old, ...(data.config || {}) }));
      setReviewMessage("审查配置已保存");
    } catch (err) {
      setError(err.message || "审查配置保存失败。");
    }
  }

  async function testReviewModel() {
    setReviewMessage("");
    setError("");
    try {
      const res = await apiFetch("/api/admin/review/config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: reviewConfig })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "审查模型连接失败");
      setReviewMessage(`连接正常：${data.model || reviewConfig.model}`);
    } catch (err) {
      setError(err.message || "审查模型连接失败。");
    }
  }

  async function overrideReview(jobId) {
    const reason = String(overrideReasons[jobId] || "").trim();
    setReviewMessage("");
    setError("");
    try {
      const res = await apiFetch(`/api/admin/reviews/${jobId}/override`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "放行失败");
      setOverrideReasons((old) => ({ ...old, [jobId]: "" }));
      setReviewRuns((old) => old.filter((item) => item.jobId !== jobId));
      setReviewMessage("已放行该任务");
    } catch (err) {
      setError(err.message || "放行失败。");
    }
  }

  return (
    <>
      <section className="configTop panel">
        <div>
          <h1>管理后台</h1>
          <p>集中管理账号权限、全站用量和企业审查流程。</p>
        </div>
        <div className="saveGroup">
          <button className="btn" onClick={() => loadAdmin(range)}>{loading ? "刷新中" : "刷新"}</button>
        </div>
      </section>

      <section className="panel adminPanel">
        <div className="adminBar">
          <div className="usageRange">
            <button className={section === "users" ? "active" : ""} onClick={() => setSection("users")}><Users size={15} />账号管理</button>
            <button className={section === "usage" ? "active" : ""} onClick={() => setSection("usage")}><BarChart3 size={15} />用量查看</button>
            <button className={section === "reviewRules" ? "active" : ""} onClick={() => setSection("reviewRules")}><FileText size={15} />审查规则</button>
            <button className={section === "reviewConfig" ? "active" : ""} onClick={() => setSection("reviewConfig")}><ShieldCheck size={15} />审查配置</button>
            <button className={section === "reviewManage" ? "active" : ""} onClick={() => setSection("reviewManage")}><AlertTriangle size={15} />审查管理</button>
          </div>
          <div className="usageRange">
            <button className={range === "today" ? "active" : ""} onClick={() => setRange("today")}>今日</button>
            <button className={range === "month" ? "active" : ""} onClick={() => setRange("month")}>本月</button>
          </div>
        </div>
        {error && <div className="inlineError">{error}</div>}
        {reviewMessage && <div className="adminOk">{reviewMessage}</div>}

        <AdminPanelContent
          section={section}
          users={users}
          resetUserId={resetUserId}
          setResetUserId={setResetUserId}
          resetPassword={resetPassword}
          setResetPassword={setResetPassword}
          resetMessage={resetMessage}
          onResetPassword={resetPasswordForUser}
          onToggleReviewEntitlement={toggleReviewEntitlement}
          summary={summary}
          records={records}
          reviewRuleName={reviewRuleName}
          setReviewRuleName={setReviewRuleName}
          reviewRuleVersion={reviewRuleVersion}
          setReviewRuleVersion={setReviewRuleVersion}
          reviewRuleDraft={reviewRuleDraft}
          setReviewRuleDraft={setReviewRuleDraft}
          reviewRulePacks={reviewRulePacks}
          onImportRulePack={importRulePack}
          onActivateRulePack={activateRulePack}
          reviewConfig={reviewConfig}
          setReviewConfig={setReviewConfig}
          onTestReviewModel={testReviewModel}
          onSaveReviewConfig={saveReviewConfig}
          reviewRuns={reviewRuns}
          overrideReasons={overrideReasons}
          setOverrideReasons={setOverrideReasons}
          onOverrideReview={overrideReview}
        />
      </section>
    </>
  );
}

function AuthScreen({ onAuthed }) {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/auth/${mode === "login" ? "login" : "register"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "操作失败");
      localStorage.setItem(AUTH_TOKEN_KEY, data.token);
      onAuthed(data.user);
    } catch (err) {
      setError(err.message || "操作失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="bg" />
      <main className="authShell">
        <section className="authCard panel">
          <span className="brandMark authMark"><Sparkles size={18} /></span>
          <h1>V2W 转写与 OKF 工作台</h1>
          <p>登录后处理直链或网盘媒体，生成 Word 文档、OKF 知识包和额外文件。</p>
          <div className="loginTabs authTabs">
            <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>登录</button>
            <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>注册</button>
          </div>
          <form onSubmit={submit} className="authForm">
            <label className="field">账号
              <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="至少 3 位，可用邮箱" autoComplete="username" />
            </label>
            <label className="field">密码
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 6 位" autoComplete={mode === "login" ? "current-password" : "new-password"} />
            </label>
            {error && <div className="submitNotice err slim">{error}</div>}
            <button className="primary authSubmit" disabled={loading || !username || !password}>
              {loading ? "处理中" : mode === "login" ? "登录" : "注册并登录"}
            </button>
          </form>
        </section>
      </main>
    </>
  );
}

function SetupScreen({ status, onAuthed, onRefresh }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const tools = [
    ["ffmpeg", status?.tools?.ffmpegOk],
    ["ffprobe", status?.tools?.ffprobeOk],
    ["yt-dlp", status?.tools?.ytDlpOk],
    ["BaiduPCS-Go", status?.tools?.pcsOk],
    ["Chrome/Chromium", status?.tools?.chromeOk]
  ];

  async function submit(event) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/setup/admin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "初始化失败");
      localStorage.setItem(AUTH_TOKEN_KEY, data.token);
      onAuthed(data.user);
    } catch (err) {
      setError(err.message || "初始化失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="bg" />
      <main className="setupShell">
        <section className="setupCard panel">
          <div className="setupIntro">
            <span className="brandMark authMark"><Sparkles size={18} /></span>
            <h1>初始化 V2W</h1>
            <p>创建第一个管理员账号后即可进入 V2W 工作台。系统工具可以稍后补齐，直链转写不依赖网盘工具。</p>
          </div>
          <div className="setupGrid">
            <div className="setupBlock">
              <div className="setupBlockHead">
                <h2>环境检查</h2>
                <button className="btn" onClick={onRefresh}><RefreshCw size={15} />刷新</button>
              </div>
              <div className="setupChecks">
                {tools.map(([label, ok]) => (
                  <div className={`setupCheck ${ok ? "ok" : "warn"}`} key={label}>
                    <span>{ok ? "已找到" : "未找到"}</span>
                    <strong>{label}</strong>
                  </div>
                ))}
              </div>
            </div>
            <form className="setupBlock" onSubmit={submit}>
              <div className="setupBlockHead">
                <h2>管理员账号</h2>
              </div>
              <label className="field">账号
                <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" autoComplete="username" />
              </label>
              <label className="field">密码
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 6 位" autoComplete="new-password" />
              </label>
              {error && <div className="submitNotice err slim">{error}</div>}
              <button className="primary authSubmit" disabled={loading || !username || password.length < 6}>
                <KeyRound size={17} />{loading ? "初始化中" : "创建管理员"}
              </button>
            </form>
          </div>
        </section>
      </main>
    </>
  );
}

function App({ user, onLogout }) {
  const [tab, setTab] = useState("direct");
  const [jobs, setJobs] = useState([]);
  const [queueState, setQueueState] = useState({ paused: false, reason: "", queued: 0, running: 0 });
  const providerState = useProviderConfig();
  const ossState = useOssConfig();
  const currentJobs = useMemo(() => jobs, [jobs]);
  const deletedJobsRef = useRef(new Set());

  const hasActiveJobs = useMemo(
    () => jobs.some((job) => job.status === "queued" || job.status === "running"),
    [jobs]
  );

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/config")
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "读取配置失败");
        if (cancelled || !data.config) return;
        providerState.replace(data.config.provider || {});
        ossState.replace(data.config.oss || {});
      })
      .catch(() => {
        // Keep the editable draft visible; submitting tasks still requires server-side config.
      });
    return () => { cancelled = true; };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [jobsRes, queueRes] = await Promise.all([
        apiFetch("/api/jobs"),
        apiFetch("/api/queue")
      ]);
      const jobsData = await jobsRes.json().catch(() => ({}));
      const queueData = await queueRes.json().catch(() => ({}));
      if (Array.isArray(jobsData.jobs)) {
        const deleted = deletedJobsRef.current;
        setJobs(jobsData.jobs.filter((job) => !deleted.has(job.id)));
      }
      if (queueData && typeof queueData === "object") setQueueState(queueData);
    } catch {
      // Ignore transient polling errors; the next tick will retry.
    }
  }, []);

  // Poll only while jobs are still active. Once everything is done/failed the
  // interval stops, and resumes automatically when a new job is submitted.
  useEffect(() => {
    refresh();
    if (!hasActiveJobs) return undefined;
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [hasActiveJobs, refresh]);

  useEffect(() => {
    rememberDurationSamples(jobs);
  }, [jobs]);

  useEffect(() => {
    const tabTitle = "V2W";
    document.title = tabTitle;
    return () => { document.title = tabTitle; };
  }, []);

  async function deleteJob(id) {
    deletedJobsRef.current.add(id);
    setJobs((old) => old.filter((job) => job.id !== id));
    try {
      const res = await apiFetch(`/api/jobs/${id}`, { method: "DELETE" });
      if (!res.ok) {
        deletedJobsRef.current.delete(id);
        refresh();
      }
    } catch {
      deletedJobsRef.current.delete(id);
      refresh();
    }
  }

  async function resumeQueue() {
    const res = await apiFetch("/api/queue/resume", { method: "POST" });
    if (!res.ok) return;
    setQueueState((old) => ({ ...old, paused: false, reason: "" }));
    refresh();
  }

  async function retryExtra(id) {
    const res = await apiFetch(`/api/jobs/${id}/retry-extra`, {
      method: "POST"
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return;
    if (data.job) setJobs((old) => old.map((job) => job.id === id ? data.job : job));
    refresh();
  }

  async function retryJob(id) {
    const res = await apiFetch(`/api/jobs/${id}/retry`, {
      method: "POST"
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return;
    if (data.job) setJobs((old) => old.map((job) => job.id === id ? data.job : job));
    refresh();
  }

  async function retryReview(id) {
    const res = await apiFetch(`/api/jobs/${id}/review/retry`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return;
    if (data.job) setJobs((old) => old.map((job) => job.id === id ? data.job : job));
    refresh();
  }

  return (
    <>
      <div className="bg" />
      <header className="topbar">
        <span className="brandMark"><Sparkles size={17} /></span>
        <b>V2W</b>
        <span className="sep">·</span>
        <span className="sub">转写 · Word · OKF 工作台</span>
        <div className="accountBar">
          <a className="githubLink" href="https://github.com/joyrayai/v2w" target="_blank" rel="noreferrer">
            <img src={githubMark} alt="" />
            GitHub
          </a>
          <span>{user?.username}</span>
          <button onClick={onLogout}>退出</button>
        </div>
      </header>
      <main className="shell">
        <div className="tabsWrap">
          <nav className="tabs">
            <button className={tab === "direct" ? "active" : ""} onClick={() => setTab("direct")}><LinkIcon size={16} />直链</button>
            <button className={tab === "cloud" ? "active" : ""} onClick={() => setTab("cloud")}><FileText size={16} />网盘</button>
            <button className={tab === "model" ? "active" : ""} onClick={() => setTab("model")}><SlidersHorizontalIcon />模型配置</button>
            <button className={tab === "profile" ? "active" : ""} onClick={() => setTab("profile")}><UserRound size={16} />个人中心</button>
            {user?.isAdmin && <button className={tab === "admin" ? "active" : ""} onClick={() => setTab("admin")}><Users size={16} />管理后台</button>}
          </nav>
        </div>
        {tab === "model" ? (
          <ConfigPage providerState={providerState} ossState={ossState} />
        ) : tab === "profile" ? (
          <UsagePage user={user} />
        ) : tab === "admin" && user?.isAdmin ? (
          <AdminPage />
        ) : (
          <WorkPage
            key={tab}
            mode={tab}
            providerState={providerState}
            oss={ossState.oss}
            jobs={currentJobs}
            setJobs={setJobs}
            queueState={queueState}
            onDelete={deleteJob}
            onRetry={retryJob}
            onRetryExtra={retryExtra}
            onRetryReview={retryReview}
            onResume={resumeQueue}
            onGoConfig={() => setTab("model")}
          />
        )}
      </main>
    </>
  );
}

function Root() {
  const [user, setUser] = useState(null);
  const [setupStatus, setSetupStatus] = useState(null);
  const [checking, setChecking] = useState(Boolean(localStorage.getItem(AUTH_TOKEN_KEY)));

  const refreshSetupStatus = useCallback(async () => {
    const res = await fetch(`${API}/api/setup/status`);
    const data = await res.json().catch(() => ({}));
    if (res.ok) setSetupStatus(data);
  }, []);

  useEffect(() => {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    refreshSetupStatus().catch(() => {});
    if (!token) {
      setChecking(false);
      return;
    }
    apiFetch("/api/auth/me")
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "登录已失效");
        setUser(data.user);
      })
      .catch(() => {
        localStorage.removeItem(AUTH_TOKEN_KEY);
        setUser(null);
      })
      .finally(() => setChecking(false));
  }, [refreshSetupStatus]);

  function logout() {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    setUser(null);
  }

  if (checking) {
    return (
      <>
        <div className="bg" />
        <main className="authShell"><section className="authCard panel">正在检查登录状态...</section></main>
      </>
    );
  }

  if (!user && setupStatus?.needsAdmin) {
    return <SetupScreen status={setupStatus} onAuthed={setUser} onRefresh={refreshSetupStatus} />;
  }

  return user ? <App user={user} onLogout={logout} /> : <AuthScreen onAuthed={setUser} />;
}

function SlidersHorizontalIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 7h16M4 17h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="9" cy="7" r="2.5" fill="white" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="15" cy="17" r="2.5" fill="white" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

createRoot(document.getElementById("root")).render(<Root />);
