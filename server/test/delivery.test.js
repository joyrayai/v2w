import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDeliveryContext,
  buildDeliveryPayload,
  completedDeliveryJobSnapshot,
  deliverToTarget,
  renderDeliveryTemplate,
  shouldAutoDeliver
} from "../src/services/delivery.js";

const context = {
  job: {
    id: "job_demo",
    title: "团队培训第一期",
    link: "https://media.example.com/training-01.mp4"
  },
  rawText: "这是转写原文。",
  documents: [
    { label: "原文", text: "这是转写原文。", downloadUrl: "/api/jobs/job_demo/download/0" },
    { label: "提炼版", text: "整理后的内容。", downloadUrl: "/api/jobs/job_demo/download/1" }
  ],
  okf: {
    manifest: { assetCount: 1 },
    assets: [{ type: "sop", title: "培训流程", path: "knowledge/sop/training.md" }]
  },
  metadata: {
    durationSeconds: 120,
    asrModel: "paraformer-v2",
    aiModel: "qwen-plus"
  }
};

test("renders string and json placeholders into valid JSON", () => {
  const template = JSON.stringify({
    title: "{{job.title}}",
    sourceUrl: "{{job.link}}",
    content: "{{rawText}}",
    missing: "{{not.exists}}",
    docs: "{{json documents}}",
    okf: "{{json okf}}"
  }, null, 2)
    .replace("\"{{json documents}}\"", "{{json documents}}")
    .replace("\"{{json okf}}\"", "{{json okf}}");

  const rendered = renderDeliveryTemplate(template, context);
  const payload = JSON.parse(rendered);

  assert.equal(payload.title, "团队培训第一期");
  assert.equal(payload.sourceUrl, "https://media.example.com/training-01.mp4");
  assert.equal(payload.content, "这是转写原文。");
  assert.equal(payload.missing, "");
  assert.equal(payload.docs.length, 2);
  assert.equal(payload.okf.assets[0].path, "knowledge/sop/training.md");
});

test("builds default okf payload when no custom template is configured", () => {
  const payload = buildDeliveryPayload({
    target: { payloadPreset: "okf" },
    context
  });

  assert.equal(payload.source.title, "团队培训第一期");
  assert.equal(payload.okf.manifest.assetCount, 1);
  assert.equal(payload.okf.assets[0].type, "sop");
});

test("builds delivery context from stored review outputs and public base url", () => {
  const built = buildDeliveryContext({
    job: {
      id: "job_demo",
      title: "团队培训第一期",
      link: "https://media.example.com/training-01.mp4",
      rawText: "这是转写原文。",
      outputFiles: [
        { label: "原文", url: "/outputs/raw.docx", reviewOutputId: "raw" },
        { label: "OKF", type: "okf", url: "/outputs/okf.zip", extension: ".zip" }
      ],
      okfSummary: { assetCount: 1, manifest: { title: "OKF" } },
      audioDurationSec: 88,
      settings: { asrModel: "paraformer-v2", qwenModel: "qwen-plus" }
    },
    reviewOutputs: [
      { id: "extra-0", label: "提炼版", text: "整理后的内容。", url: "/outputs/extra.docx", orderIndex: 1 },
      { id: "raw", label: "原文", text: "这是转写原文。", url: "/outputs/raw.docx", orderIndex: 0 }
    ],
    publicBaseUrl: "https://v2w.example.com"
  });

  assert.equal(built.rawText, "这是转写原文。");
  assert.equal(built.documents[0].downloadUrl, "https://v2w.example.com/api/jobs/job_demo/download/0");
  assert.equal(built.documents[1].sourceUrl, "https://v2w.example.com/outputs/extra.docx");
  assert.equal(built.okf.downloadUrl, "https://v2w.example.com/api/jobs/job_demo/download/1");
  assert.equal(built.metadata.durationSeconds, 88);
});

test("rejects invalid custom JSON templates before delivery", () => {
  assert.throws(() => buildDeliveryPayload({
    target: { payloadPreset: "custom", payloadTemplate: "{\"title\":" },
    context
  }), /JSON/);
});

test("posts rendered payload with configured headers and bearer auth", async () => {
  const calls = [];
  const result = await deliverToTarget({
    target: {
      name: "知识库",
      method: "POST",
      url: "https://kb.example.com/import",
      headers: { "X-Workspace": "demo" },
      authType: "bearer",
      authSecret: "secret-token",
      payloadPreset: "custom",
      payloadTemplate: "{\"title\":\"{{job.title}}\",\"documents\":{{json documents}}}"
    },
    context,
    resolveHost: async () => [{ address: "8.8.8.8", family: 4 }],
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 202,
        text: async () => "accepted"
      };
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://kb.example.com/import");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-token");
  assert.equal(calls[0].options.headers["X-Workspace"], "demo");
  assert.equal(JSON.parse(calls[0].options.body).documents.length, 2);
  assert.equal(result.httpStatus, 202);
  assert.equal(result.responseExcerpt, "accepted");
});

test("throws a compact error for non-2xx responses", async () => {
  await assert.rejects(() => deliverToTarget({
    target: {
      method: "POST",
      url: "https://kb.example.com/import",
      payloadPreset: "standard"
    },
    context,
    resolveHost: async () => [{ address: "8.8.8.8", family: 4 }],
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      text: async () => "internal error with details"
    })
  }), /HTTP 500/);
});

test("rejects private or localhost delivery targets before fetching", async () => {
  let called = false;
  await assert.rejects(() => deliverToTarget({
    target: {
      method: "POST",
      url: "http://127.0.0.1:8080/import",
      payloadPreset: "standard"
    },
    context,
    fetchImpl: async () => {
      called = true;
      return { ok: true, status: 200, text: async () => "ok" };
    }
  }), /不允许访问内网|私有地址|本机地址/);
  assert.equal(called, false);

  await assert.rejects(() => deliverToTarget({
    target: {
      method: "POST",
      url: "https://internal.example.com/import",
      payloadPreset: "standard"
    },
    context,
    resolveHost: async () => [{ address: "10.0.0.8", family: 4 }],
    fetchImpl: async () => {
      called = true;
      return { ok: true, status: 200, text: async () => "ok" };
    }
  }), /不允许访问内网|私有地址|本机地址/);
  assert.equal(called, false);
});

test("times out slow delivery targets", async () => {
  const pendingDelivery = deliverToTarget({
    target: {
      method: "POST",
      url: "https://kb.example.com/import",
      payloadPreset: "standard"
    },
    context,
    timeoutMs: 10,
    resolveHost: async () => [{ address: "8.8.8.8", family: 4 }],
    fetchImpl: async () => new Promise(() => {})
  });

  await assert.rejects(() => Promise.race([
    pendingDelivery,
    new Promise((_, reject) => setTimeout(() => reject(new Error("test timeout")), 150))
  ]), /超时/);
});

test("only auto delivers complete reviewed jobs", () => {
  assert.equal(shouldAutoDeliver({
    job: { deliveryEnabled: true },
    extraErrors: [],
    reviewRun: { locked: false },
    reviewError: ""
  }).ok, true);

  assert.equal(shouldAutoDeliver({
    job: { deliveryEnabled: true },
    extraErrors: ["额外文件失败"],
    reviewRun: { locked: false },
    reviewError: ""
  }).ok, false);

  assert.equal(shouldAutoDeliver({
    job: { deliveryEnabled: true },
    extraErrors: [],
    reviewRun: null,
    reviewError: "审查失败"
  }).ok, false);

  assert.equal(shouldAutoDeliver({
    job: { deliveryEnabled: true },
    extraErrors: [],
    reviewRun: { locked: true },
    reviewError: ""
  }).ok, false);
});

test("builds a completed job snapshot for delivery payloads", () => {
  const now = "2026-06-23T10:00:00.000Z";
  const snapshot = completedDeliveryJobSnapshot({
    id: "job_demo",
    status: "running",
    completedAt: "",
    title: "团队培训第一期"
  }, now);

  assert.equal(snapshot.status, "done");
  assert.equal(snapshot.completedAt, now);
  assert.equal(snapshot.title, "团队培训第一期");
});
