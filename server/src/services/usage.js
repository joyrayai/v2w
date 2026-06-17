import { nanoid } from "nanoid";
import { USAGE_PRICING } from "../config.js";

export function estimateCost(record, pricing = USAGE_PRICING) {
  if (record.type === "asr") {
    const modelPrice = pricing.asr?.[record.model] || pricing.asr?.["paraformer-v2"];
    if (!modelPrice || modelPrice.pricePerUnit == null) return null;
    return Number(record.metricValue || 0) * Number(modelPrice.pricePerUnit || 0);
  }

  if (record.type === "llm") {
    const modelPrice = pricing.llm?.[record.model];
    if (!modelPrice) return null;
    const inputTokens = Number(record.inputTokens || 0);
    const tier = Array.isArray(modelPrice.tiers)
      ? modelPrice.tiers.find((item) => inputTokens <= Number(item.maxInputTokens || Infinity))
      : modelPrice;
    if (!tier) return null;
    const input = inputTokens / 1000 * Number(tier.inputPer1K || 0);
    const output = Number(record.outputTokens || 0) / 1000 * Number(tier.outputPer1K || 0);
    return input + output;
  }

  return null;
}

export function usageDateRange(range = "month") {
  const now = new Date();
  const end = new Date(now);
  let start;
  if (range === "today") {
    start = new Date(now);
    start.setHours(0, 0, 0, 0);
  } else {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  return { start: start.toISOString(), end: end.toISOString(), range };
}

export function normalizeUsageRecord(job, record) {
  const normalized = {
    id: nanoid(12),
    userId: job.userId,
    jobId: job.id,
    jobTitle: job.title,
    type: record.type,
    provider: record.provider || "",
    model: record.model || "",
    metricUnit: record.metricUnit || "",
    metricValue: Number(record.metricValue || 0),
    inputTokens: record.inputTokens == null ? null : Number(record.inputTokens || 0),
    outputTokens: record.outputTokens == null ? null : Number(record.outputTokens || 0),
    totalTokens: record.totalTokens == null ? null : Number(record.totalTokens || 0),
    currency: USAGE_PRICING.currency || "CNY",
    meta: record.meta || null,
    createdAt: new Date().toISOString()
  };
  normalized.estimatedCost = estimateCost(normalized);
  return normalized;
}

export function summarizeJobUsage(records = []) {
  const asrSeconds = records
    .filter((record) => record.type === "asr")
    .reduce((sum, record) => sum + Number(record.metricValue || 0), 0);
  const llmTokens = records
    .filter((record) => record.type === "llm")
    .reduce((sum, record) => sum + Number(record.totalTokens || 0), 0);
  const estimatedCost = records
    .filter((record) => record.estimatedCost != null)
    .reduce((sum, record) => sum + Number(record.estimatedCost || 0), 0);
  const asrCost = records
    .filter((record) => record.type === "asr" && record.estimatedCost != null)
    .reduce((sum, record) => sum + Number(record.estimatedCost || 0), 0);
  const llmCost = records
    .filter((record) => record.type === "llm" && record.estimatedCost != null)
    .reduce((sum, record) => sum + Number(record.estimatedCost || 0), 0);

  return {
    asrSeconds,
    llmTokens,
    asrCost,
    llmCost,
    estimatedCost,
    records: records.length
  };
}

export function publicUsageRecord(record) {
  return {
    id: record.id,
    jobId: record.jobId,
    jobTitle: record.jobTitle,
    type: record.type,
    provider: record.provider,
    model: record.model,
    metricUnit: record.metricUnit,
    metricValue: record.metricValue,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    totalTokens: record.totalTokens,
    estimatedCost: record.estimatedCost,
    currency: record.currency,
    createdAt: record.createdAt
  };
}
