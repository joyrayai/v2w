export function normalizeProviderConfig(raw = {}) {
  const providers = raw.providers && typeof raw.providers === "object" ? raw.providers : {};
  const cfg = raw.cfg && typeof raw.cfg === "object" ? raw.cfg : providers;
  const active = ["aliyun", "silicon", "deepseek", "custom"].includes(raw.active) ? raw.active : "aliyun";
  const normalized = {};
  for (const id of ["aliyun", "silicon", "deepseek", "custom"]) {
    const item = cfg[id] && typeof cfg[id] === "object" ? cfg[id] : {};
    normalized[id] = {
      apiKey: String(item.apiKey || ""),
      baseUrl: String(item.baseUrl || ""),
      asr: String(item.asr || ""),
      llm: String(item.llm || ""),
      asrProvider: String(item.asrProvider || "aliyun")
    };
  }
  return { active, cfg: normalized };
}

export function normalizeOssConfig(raw = {}) {
  const oss = raw.oss && typeof raw.oss === "object" ? raw.oss : raw;
  return {
    region: String(oss.region || ""),
    bucket: String(oss.bucket || ""),
    accessKeyId: String(oss.accessKeyId || ""),
    accessKeySecret: String(oss.accessKeySecret || ""),
    prefix: String(oss.prefix || "video-to-word")
  };
}

export function normalizeUserSettings(payload = {}) {
  const provider = normalizeProviderConfig(payload.provider || payload.providerState || payload);
  return {
    provider,
    oss: normalizeOssConfig(payload.oss || payload.ossState || {}),
    reviewEnabled: Boolean(payload.reviewEnabled),
    updatedAt: payload.updatedAt || null
  };
}

export function settingsFromUserConfig(savedConfig, requestSettings = {}, req = null) {
  const normalized = normalizeUserSettings(savedConfig || {});
  const { active, cfg } = normalized.provider;
  const current = cfg[active] || {};
  const aliyun = cfg.aliyun || {};
  const asrSource = active === "aliyun" ? current : aliyun;
  const runtime = requestSettings && typeof requestSettings === "object" ? requestSettings : {};
  return {
    dashscopeApiKey: asrSource.apiKey || "",
    asrApiKey: asrSource.apiKey || "",
    asrModel: (active === "aliyun" ? current.asr : current.asr || aliyun.asr) || "paraformer-v2",
    qwenModel: String(current.llm || "").trim(),
    llmApiKey: current.apiKey || "",
    llmBaseUrl: current.baseUrl || "",
    llmProvider: active || "aliyun",
    directUrlMode: runtime.directUrlMode,
    publicBaseUrl: runtime.publicBaseUrl || (req ? `${req.protocol}://${req.get("host")}` : ""),
    ffmpegPath: "ffmpeg",
    baiduDownloaderTemplate: "",
    netdiskTempDir: "/视频转Word临时文件",
    oss: normalizeOssConfig(normalized.oss)
  };
}

export function publicUserSettings(config = null) {
  if (!config) return null;
  const normalized = normalizeUserSettings(config);
  const clone = JSON.parse(JSON.stringify(normalized));
  for (const item of Object.values(clone.provider.cfg || {})) {
    if (item.apiKey) item.apiKey = "configured";
  }
  if (clone.oss?.accessKeySecret) clone.oss.accessKeySecret = "configured";
  return clone;
}
