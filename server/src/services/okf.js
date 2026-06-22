import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { chatCompletion } from "./ai.js";
import { safeName } from "../utils.js";

const require = createRequire(import.meta.url);
const archiverModule = require("archiver");
const OKF_TYPES = new Set(["rules", "metrics", "sop"]);

function createZipArchive(options) {
  if (typeof archiverModule === "function") return archiverModule("zip", options);
  if (typeof archiverModule.default === "function") return archiverModule.default("zip", options);
  if (typeof archiverModule.ZipArchive === "function") return new archiverModule.ZipArchive(options);
  throw new Error("当前 archiver 版本不支持 zip 打包");
}

function parseJsonResponse(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const sliced = raw.includes("{") ? raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1) : "";
  const candidates = [fenced, raw, sliced].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function normalizeTags(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 20);
  return String(value || "").split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean).slice(0, 20);
}

function normalizeOkfOptions(options = {}) {
  return {
    owner: String(options.owner || "").trim().slice(0, 80),
    version: String(options.version || "1.0").trim().slice(0, 40) || "1.0",
    tags: normalizeTags(options.tags)
  };
}

function normalizeType(type) {
  const value = String(type || "").trim().toLowerCase();
  if (["rule", "business_rule", "policy", "policies", "rules"].includes(value)) return "rules";
  if (["metric", "kpi", "indicator", "indicators", "metrics"].includes(value)) return "metrics";
  if (["process", "procedure", "workflow", "sops", "sop"].includes(value)) return "sop";
  return "sop";
}

function uniquePath(basePath, used) {
  let candidate = basePath;
  const ext = path.extname(candidate) || ".md";
  const stem = candidate.slice(0, -ext.length);
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${stem}_${index}${ext}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function pathFromAsset(asset, type, title, used) {
  const rawPath = String(asset?.path || "").trim().replaceAll("\\", "/");
  if (rawPath) {
    const normalized = path.posix.normalize(rawPath).replace(/^\/+/, "");
    const allowedPrefix = `knowledge/${type}/`;
    if (
      normalized.startsWith(allowedPrefix)
      && normalized.endsWith(".md")
      && !normalized.includes("../")
      && path.posix.basename(normalized) !== ".md"
    ) {
      return uniquePath(normalized, used);
    }
  }
  return uniquePath(`knowledge/${type}/${safeName(title || type)}.md`, used);
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function yamlList(values) {
  const items = normalizeTags(values);
  if (!items.length) return "[]";
  return `[${items.map(yamlString).join(", ")}]`;
}

function renderFrontmatter(meta) {
  return [
    "---",
    `type: ${yamlString(meta.type)}`,
    `title: ${yamlString(meta.title)}`,
    `source_title: ${yamlString(meta.sourceTitle)}`,
    `source_url: ${yamlString(meta.sourceUrl)}`,
    `version: ${yamlString(meta.version)}`,
    `last_update: ${yamlString(meta.lastUpdate)}`,
    `owner: ${yamlString(meta.owner)}`,
    `tags: ${yamlList(meta.tags)}`,
    "---"
  ].join("\n");
}

function ensureMarkdownTitle(body, title) {
  const markdown = String(body || "").trim();
  if (/^#\s+/m.test(markdown)) return markdown;
  return [`# ${title || "OKF 知识资产"}`, "", markdown || "该视频转写未提取出明确结构化知识，以下内容由原始转写整理生成。"].join("\n");
}

function fallbackAsset({ job, rawText, options, used }) {
  const title = job.title || "OKF 知识资产";
  const assetPath = uniquePath(`knowledge/sop/${safeName(title)}.md`, used);
  const excerpt = String(rawText || "").trim().slice(0, 12000);
  return {
    type: "sop",
    title,
    path: assetPath,
    owner: options.owner,
    version: options.version,
    tags: options.tags,
    body: [
      `# ${title}`,
      "",
      "## 来源摘要",
      "",
      excerpt || "原始转写为空，无法生成 OKF 内容。"
    ].join("\n")
  };
}

function normalizeAssets(parsed, { job, rawText, options }) {
  const used = new Set();
  const sourceTitle = job.title || "";
  const sourceUrl = job.link || "";
  const lastUpdate = new Date().toISOString().slice(0, 10);
  const inputAssets = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.assets)
      ? parsed.assets
      : Array.isArray(parsed?.okf?.assets)
        ? parsed.okf.assets
        : [];
  const assets = inputAssets.map((asset) => {
    const type = normalizeType(asset?.type);
    const title = String(asset?.title || asset?.name || sourceTitle || "OKF 知识资产").trim().slice(0, 120);
    const tags = normalizeTags(asset?.tags?.length ? asset.tags : options.tags);
    const assetPath = pathFromAsset(asset, type, title, used);
    return {
      type,
      title,
      path: assetPath,
      owner: String(asset?.owner || options.owner || "").trim().slice(0, 80),
      version: String(asset?.version || options.version || "1.0").trim().slice(0, 40) || "1.0",
      lastUpdate: String(asset?.last_update || asset?.lastUpdate || lastUpdate).trim().slice(0, 40) || lastUpdate,
      tags,
      sourceTitle,
      sourceUrl,
      body: ensureMarkdownTitle(asset?.body || asset?.markdown || asset?.content || "", title)
    };
  }).filter((asset) => OKF_TYPES.has(asset.type) && asset.body.trim());

  if (!assets.length) {
    const fallback = fallbackAsset({ job, rawText, options, used });
    return [{
      ...fallback,
      sourceTitle,
      sourceUrl,
      lastUpdate
    }];
  }
  return assets;
}

function manifestFor(job, assets, options) {
  return {
    okfVersion: "1.0",
    generatedAt: new Date().toISOString(),
    source: {
      title: job.title || "",
      url: job.link || "",
      jobId: job.id || ""
    },
    defaults: {
      owner: options.owner,
      version: options.version,
      tags: options.tags
    },
    assetCount: assets.length,
    assets: assets.map((asset) => ({
      type: asset.type,
      title: asset.title,
      path: asset.path,
      owner: asset.owner,
      version: asset.version,
      last_update: asset.lastUpdate,
      tags: asset.tags
    }))
  };
}

async function writeZip(filePath, files) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(filePath);
    const archive = createZipArchive({ zlib: { level: 9 } });
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    for (const file of files) {
      archive.append(file.content, { name: file.path });
    }
    archive.finalize();
  });
}

export function renderOkfMarkdown(asset) {
  return [
    renderFrontmatter({
      type: asset.type,
      title: asset.title,
      sourceTitle: asset.sourceTitle,
      sourceUrl: asset.sourceUrl,
      version: asset.version,
      lastUpdate: asset.lastUpdate,
      owner: asset.owner,
      tags: asset.tags
    }),
    "",
    ensureMarkdownTitle(asset.body, asset.title),
    ""
  ].join("\n");
}

export function buildOkfPrompt(rawText, job, options = {}) {
  return [
    "你是企业知识资产整理助手。请把视频转写内容整理成 OKF 知识格式。",
    "OKF 在本系统中表示：文件夹 + Markdown + YAML 元数据，用于让企业 Agent、RAG 和知识资产中心复用。",
    "",
    "请只返回严格 JSON，不要 Markdown 代码块，不要解释。",
    "JSON 结构：",
    "{",
    "  \"assets\": [",
    "    {",
    "      \"type\": \"rules | metrics | sop\",",
    "      \"title\": \"知识资产标题\",",
    "      \"path\": \"knowledge/rules/example.md 或 knowledge/metrics/example.md 或 knowledge/sop/example.md\",",
    "      \"owner\": \"负责人，可为空\",",
    "      \"version\": \"版本号\",",
    "      \"last_update\": \"YYYY-MM-DD\",",
    "      \"tags\": [\"标签\"],",
    "      \"body\": \"Markdown 正文，包含清晰标题、适用范围、定义、规则、流程或指标说明\"",
    "    }",
    "  ]",
    "}",
    "",
    "分类规则：制度、政策、审批规则放入 rules；指标定义、计算逻辑、数据来源放入 metrics；操作流程、SOP、步骤指南放入 sop。",
    "不要编造原文没有的信息；不确定的负责人可留空。",
    `默认 owner: ${options.owner || ""}`,
    `默认 version: ${options.version || "1.0"}`,
    `默认 tags: ${normalizeTags(options.tags).join(", ")}`,
    "",
    "来源标题：",
    job.title || "",
    "",
    "来源链接：",
    job.link || "",
    "",
    "转写内容：",
    String(rawText || "").slice(0, 60000)
  ].join("\n");
}

export async function generateOkfBundle({ job, rawText, settings, outputDir, options = {} }) {
  const normalizedOptions = normalizeOkfOptions(options);
  const json = await chatCompletion([
    {
      role: "system",
      content: "你负责将企业视频转写内容整理成 OKF 知识资产。必须返回可解析 JSON。"
    },
    {
      role: "user",
      content: buildOkfPrompt(rawText, job, normalizedOptions)
    }
  ], settings, 0.1, { response_format: { type: "json_object" } }).catch(async (err) => {
    if (!/response_format/i.test(String(err.message || ""))) throw err;
    return chatCompletion([
      {
        role: "system",
        content: "你负责将企业视频转写内容整理成 OKF 知识资产。必须返回可解析 JSON。"
      },
      {
        role: "user",
        content: buildOkfPrompt(rawText, job, normalizedOptions)
      }
    ], settings, 0.1);
  });

  const content = json.choices?.[0]?.message?.content || "";
  const parsed = parseJsonResponse(content);
  const assets = normalizeAssets(parsed, { job, rawText, options: normalizedOptions });
  const manifest = manifestFor(job, assets, normalizedOptions);
  const files = [
    { path: "manifest.json", content: `${JSON.stringify(manifest, null, 2)}\n` },
    ...assets.map((asset) => ({ path: asset.path, content: renderOkfMarkdown(asset) }))
  ];

  const fileName = `${String((Number(job.order) || 0) + 1).padStart(2, "0")}_${safeName(job.outputBaseTitle || job.title)}_OKF.zip`;
  const filePath = path.join(outputDir, fileName);
  await writeZip(filePath, files);

  return {
    fileName,
    filePath,
    assets,
    manifest,
    text: files.filter((file) => file.path.endsWith(".md")).map((file) => file.content).join("\n\n"),
    usage: json.usage || null,
    model: json.model || String(settings.qwenModel || "").trim(),
    provider: settings.llmProvider || "llm"
  };
}
