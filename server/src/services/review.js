import { nanoid } from "nanoid";
import { APP_CONFIG } from "../config.js";
import { chatCompletion, testLlmConnection } from "./ai.js";

const RISK_ORDER = { none: 0, low: 1, medium: 2, high: 3 };
const ACTION_BY_RISK = { none: "pass", low: "pass", medium: "review", high: "block" };

export function normalizeReviewConfig(config = {}) {
  return {
    enabled: Boolean(config.enabled),
    apiKey: String(config.apiKey || "").trim(),
    baseUrl: String(config.baseUrl || "https://dashscope.aliyuncs.com/compatible-mode/v1").trim(),
    model: String(config.model || "qwen-long").trim(),
    contextLimitTokens: Number(config.contextLimitTokens || APP_CONFIG.reviewContextLimitTokens),
    updatedAt: config.updatedAt || ""
  };
}

export function publicReviewConfig(config = {}) {
  const normalized = normalizeReviewConfig(config);
  return {
    ...normalized,
    apiKey: normalized.apiKey ? "••••••••••••" : "",
    hasApiKey: Boolean(normalized.apiKey)
  };
}

export function reviewSettingsForLlm(config = {}) {
  const normalized = normalizeReviewConfig(config);
  return {
    llmApiKey: normalized.apiKey,
    llmBaseUrl: normalized.baseUrl,
    qwenModel: normalized.model,
    llmProvider: "review"
  };
}

export async function testReviewConfig(config = {}) {
  return testLlmConnection(reviewSettingsForLlm(config));
}

export function parseRulePackMarkdown(markdown = "") {
  const text = String(markdown || "").trim();
  const firstHeading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const version = text.match(/(?:版本|version)\s*[:：]\s*([^\n]+)/i)?.[1]?.trim();
  const ruleLines = [...text.matchAll(/^(?:[-*]|\d+\.)\s*(?:\*\*)?([^：:\n]+)(?:\*\*)?\s*[：:]\s*(.+)$/gm)];
  return {
    name: firstHeading || "企业审查规则包",
    version: version || new Date().toISOString().slice(0, 10),
    rules: ruleLines.slice(0, 80).map((match) => ({
      title: match[1].trim().slice(0, 80),
      description: match[2].trim().slice(0, 300)
    }))
  };
}

export function publicRulePack(rulePack, includeMarkdown = false) {
  if (!rulePack) return null;
  return {
    id: rulePack.id,
    name: rulePack.name,
    version: rulePack.version,
    summary: rulePack.summary || null,
    active: Boolean(rulePack.active),
    createdAt: rulePack.createdAt,
    updatedAt: rulePack.updatedAt,
    ...(includeMarkdown ? { markdown: rulePack.markdown } : {})
  };
}

export function estimateTokens(text = "") {
  const value = String(text || "");
  const cjk = (value.match(/[\u3400-\u9fff]/g) || []).length;
  const rest = Math.max(0, value.length - cjk);
  return Math.ceil(cjk * 0.9 + rest / 4);
}

function normalizeRiskLevel(value) {
  const risk = String(value || "").toLowerCase().trim();
  return RISK_ORDER[risk] == null ? "none" : risk;
}

function maxRisk(items = []) {
  return items.reduce((max, item) => {
    const risk = normalizeRiskLevel(item?.riskLevel || item?.severity);
    return RISK_ORDER[risk] > RISK_ORDER[max] ? risk : max;
  }, "none");
}

function parseJsonObject(text = "") {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidates = [
    fenced,
    raw,
    raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try next candidate.
    }
  }
  throw new Error("审查模型没有返回可解析的 JSON。");
}

function normalizeFinding(finding = {}) {
  const severity = normalizeRiskLevel(finding.severity || finding.riskLevel);
  return {
    ruleTitle: String(finding.ruleTitle || finding.rule || finding.title || "未命名规则").slice(0, 120),
    severity,
    quote: String(finding.quote || finding.location?.quote || "").slice(0, 1200),
    reason: String(finding.reason || finding.rationale || "").slice(0, 2000),
    suggestion: String(finding.suggestion || "").slice(0, 2000)
  };
}

function normalizeFileResult(result = {}) {
  const findings = Array.isArray(result.findings) ? result.findings.map(normalizeFinding) : [];
  const riskLevel = normalizeRiskLevel(result.riskLevel || maxRisk(findings));
  return {
    fileId: String(result.fileId || result.id || "").slice(0, 120),
    fileLabel: String(result.fileLabel || result.label || "文件").slice(0, 120),
    parentId: result.parentId ? String(result.parentId).slice(0, 120) : "",
    parentLabel: result.parentLabel ? String(result.parentLabel).slice(0, 120) : "",
    riskLevel,
    action: String(result.action || ACTION_BY_RISK[riskLevel] || "pass"),
    summary: String(result.summary || "").slice(0, 2000),
    findings
  };
}

function normalizeReviewJson(parsed = {}, fallbackOutputs = []) {
  const sourceResults = Array.isArray(parsed.files)
    ? parsed.files
    : Array.isArray(parsed.results)
      ? parsed.results
      : Array.isArray(parsed.fileResults)
        ? parsed.fileResults
        : [];

  const expectedOutputs = fallbackOutputs
    .map((output) => ({
      id: String(output.id || "").trim(),
      label: String(output.label || "").trim()
    }))
    .filter((output) => output.id || output.label);
  const labelCounts = new Map();
  for (const output of expectedOutputs) {
    if (!output.label) continue;
    labelCounts.set(output.label, (labelCounts.get(output.label) || 0) + 1);
  }
  const uniqueLabelToId = new Map(expectedOutputs
    .filter((output) => output.label && labelCounts.get(output.label) === 1)
    .map((output) => [output.label, output.id || output.label]));
  let files = [];
  if (expectedOutputs.length) {
    if (!sourceResults.length) throw new Error("审查模型未返回任何文件结果。");
    const expected = new Map(expectedOutputs.map((output) => [output.id || output.label, output]));
    const seen = new Set();
    const byId = new Map();
    for (const item of sourceResults) {
      const returnedLabel = String(item.fileLabel || item.label || "").trim();
      const id = String(item.fileId || item.id || uniqueLabelToId.get(returnedLabel) || "").trim();
      if (!id) throw new Error("审查模型返回的文件结果缺少 fileId。");
      if (seen.has(id)) throw new Error(`审查模型重复返回文件：${expected.get(id)?.label || id}`);
      if (!expected.has(id)) throw new Error(`审查模型返回了未知文件：${returnedLabel || id}`);
      const expectedOutput = expected.get(id);
      const label = String(item.fileLabel || item.label || "").trim();
      seen.add(id);
      byId.set(id, normalizeFileResult({
        ...item,
        fileId: id,
        fileLabel: label || expectedOutput.label || id
      }));
    }
    const missing = expectedOutputs.filter((output) => !seen.has(output.id || output.label)).map((output) => output.label || output.id);
    if (missing.length) throw new Error(`审查模型漏返回文件：${missing.join("、")}`);
    files = expectedOutputs.map((output) => byId.get(output.id || output.label));
  } else {
    files = sourceResults.map(normalizeFileResult);
  }
  const riskLevel = normalizeRiskLevel(parsed.riskLevel || maxRisk(files));
  return {
    riskLevel,
    action: String(parsed.action || ACTION_BY_RISK[riskLevel] || "pass"),
    summary: String(parsed.summary || "").slice(0, 3000),
    files
  };
}

function chunkText(id, label, text, budgetTokens) {
  const source = String(text || "");
  const maxChars = Math.max(4000, Math.floor(budgetTokens * 1.2));
  const chunks = [];
  for (let start = 0; start < source.length; start += maxChars) {
    const chunkIndex = chunks.length + 1;
    chunks.push({
      id: `${id}:chunk:${chunkIndex}`,
      label: `${label}（片段 ${chunkIndex}）`,
      parentId: id,
      parentLabel: label,
      text: source.slice(start, start + maxChars)
    });
  }
  return chunks.length ? chunks : [{ id: `${id}:chunk:1`, label: `${label}（片段 1）`, parentId: id, parentLabel: label, text: "" }];
}

function packOutputs(outputs, tokenLimit) {
  const overhead = 12000;
  const budget = Math.max(2000, tokenLimit - overhead);
  const batches = [];
  let current = [];
  let currentTokens = 0;
  for (const output of outputs) {
    const tokens = estimateTokens(output.text) + estimateTokens(output.label) + 200;
    if (tokens > budget) {
      if (current.length) {
        batches.push(current);
        current = [];
        currentTokens = 0;
      }
      const sliceBudget = Math.max(2000, Math.floor(budget * 0.85));
      for (const chunk of chunkText(output.id || output.label, output.label, output.text, sliceBudget)) batches.push([chunk]);
      continue;
    }
    if (current.length && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(output);
    currentTokens += tokens;
  }
  if (current.length) batches.push(current);
  return batches;
}

function buildReviewPrompt(rulePack, outputs, batchIndex, batchTotal) {
  const filesText = outputs.map((output, index) => [
    `### FILE ${index + 1}`,
    `fileId: ${output.id || output.label}`,
    `label: ${output.label}`,
    output.parentId ? `parentId: ${output.parentId}` : "",
    output.parentLabel ? `parentLabel: ${output.parentLabel}` : "",
    "content:",
    String(output.text || "")
  ].filter(Boolean).join("\n")).join("\n\n");
  return [
    "你是医药企业内容合规审查助手。请根据规则包审查多个 Word 文档文本。",
    "只返回 JSON，不要 Markdown，不要解释。",
    "必须按输入文件逐个返回审查结果。",
    "每个文件结果必须原样返回输入的 fileId，不要自己生成或省略。",
    "如果输入里有 parentId，请在对应文件结果里原样返回 parentId。",
    "如果没有发现风险，riskLevel 用 none，findings 为空数组。",
    "severity/riskLevel 只能是 none、low、medium、high。",
    "返回格式：",
    "{\"riskLevel\":\"none|low|medium|high\",\"action\":\"pass|review|block\",\"summary\":\"...\",\"files\":[{\"fileId\":\"输入 fileId\",\"fileLabel\":\"输入 label\",\"riskLevel\":\"none|low|medium|high\",\"action\":\"pass|review|block\",\"summary\":\"...\",\"findings\":[{\"ruleTitle\":\"规则名\",\"severity\":\"low|medium|high\",\"quote\":\"原文片段\",\"reason\":\"原因\",\"suggestion\":\"修改建议\"}]}]}",
    "",
    `本次是第 ${batchIndex + 1}/${batchTotal} 批。`,
    "",
    "规则包：",
    `名称：${rulePack.name}`,
    `版本：${rulePack.version}`,
    rulePack.markdown,
    "",
    "待审查文件：",
    filesText
  ].join("\n");
}

function mergeBatchResults(batchResults, originalOutputs) {
  const grouped = new Map();
  const chunkParentId = (fileId = "") => {
    const value = String(fileId || "");
    const marker = ":chunk:";
    return value.includes(marker) ? value.slice(0, value.lastIndexOf(marker)) : "";
  };
  for (const result of batchResults) {
    for (const file of result.files || []) {
      const parent = String(file.fileLabel || "").replace(/（片段 \d+）$/, "");
      const key = file.parentId || chunkParentId(file.fileId) || file.fileId || file.parentLabel || parent;
      const current = grouped.get(key) || {
        fileId: key,
        parentId: "",
        fileLabel: file.parentLabel || parent || key,
        riskLevel: "none",
        action: "pass",
        summary: "",
        findings: []
      };
      current.findings.push(...(file.findings || []));
      current.riskLevel = maxRisk([current, file]);
      current.action = ACTION_BY_RISK[current.riskLevel] || "pass";
      if (file.summary) current.summary = [current.summary, file.summary].filter(Boolean).join("；").slice(0, 3000);
      grouped.set(key, current);
    }
  }
  const files = originalOutputs.map((output) => grouped.get(output.id || output.label) || {
    fileId: output.id || output.label,
    fileLabel: output.label,
    riskLevel: "none",
    action: "pass",
    summary: "未发现明确风险。",
    findings: []
  });
  const riskLevel = maxRisk(files);
  return {
    riskLevel,
    action: ACTION_BY_RISK[riskLevel] || "pass",
    summary: files.some((file) => file.findings.length)
      ? `共发现 ${files.reduce((sum, file) => sum + file.findings.length, 0)} 条审查发现。`
      : "未发现明确风险。",
    files
  };
}

export function publicReviewRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    jobId: run.jobId,
    userId: run.userId,
    username: run.username || "",
    status: run.status,
    riskLevel: run.riskLevel,
    action: run.action,
    model: run.model,
    rulePackId: run.rulePackId,
    rulePackVersion: run.rulePackVersion,
    result: run.result,
    error: run.error,
    locked: Boolean(run.locked),
    overridden: Boolean(run.overridden),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt
  };
}

export async function runDocumentReview({ job, rulePack, config, store }) {
  const outputs = store.listReviewOutputs(job.id).filter((item) => item?.label && item?.text != null);
  if (!outputs.length) throw new Error("缺少可审查的文本缓存。请重新生成任务。");
  const normalizedConfig = normalizeReviewConfig(config);
  if (!normalizedConfig.enabled || !normalizedConfig.apiKey || !normalizedConfig.model) {
    throw new Error("管理员尚未配置审查模型。");
  }
  if (!rulePack?.markdown) throw new Error("审查规则未配置。");

  const run = {
    id: nanoid(16),
    jobId: job.id,
    userId: job.userId,
    status: "running",
    riskLevel: "none",
    action: "pass",
    model: normalizedConfig.model,
    rulePackId: rulePack.id,
    rulePackVersion: rulePack.version,
    locked: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  store.saveReviewRun(run);

  try {
    const tokenLimit = Math.max(10000, Number(normalizedConfig.contextLimitTokens || APP_CONFIG.reviewContextLimitTokens));
    const batches = packOutputs(outputs, tokenLimit);
    const settings = reviewSettingsForLlm(normalizedConfig);
    const batchResults = [];
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      const json = await chatCompletion([
        { role: "system", content: "你是严谨的医药合规审查 JSON 输出引擎。只返回合法 JSON。" },
        { role: "user", content: buildReviewPrompt(rulePack, batch, index, batches.length) }
      ], settings, 0.1, { response_format: { type: "json_object" } });
      const content = json.choices?.[0]?.message?.content || "";
      const parsed = parseJsonObject(content);
      batchResults.push(normalizeReviewJson(parsed, batch));
    }
    const hasChunkedOutputs = batches.some((batch) => batch.some((output) => output.parentId));
    const result = batches.length === 1 && !hasChunkedOutputs
      ? normalizeReviewJson(batchResults[0], outputs)
      : mergeBatchResults(batchResults, outputs);
    run.status = "done";
    run.riskLevel = result.riskLevel;
    run.action = result.action;
    run.result = result;
    run.locked = result.riskLevel === "high";
    run.updatedAt = new Date().toISOString();
    store.saveReviewRun(run);
    return run;
  } catch (err) {
    run.status = "error";
    run.error = err.message || "审查失败。";
    run.updatedAt = new Date().toISOString();
    store.saveReviewRun(run);
    throw err;
  }
}
