import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { registerMcpRoutes } from "../src/mcp/http.js";

function createStore() {
  const users = [];
  const settings = new Map();
  const templates = new Map();
  return {
    users,
    saveUser(user) {
      users.push(user);
    },
    getUserSettings(userId) {
      return settings.get(userId) || null;
    },
    saveUserSettings(userId, config) {
      settings.set(userId, config);
    },
    usageSummary() {
      return { records: 0, asrSeconds: 0, llmTokens: 0, asrCost: 0, llmCost: 0, estimatedCost: 0 };
    },
    usageRecords() {
      return [];
    },
    adminUsageSummary() {
      return { total: this.usageSummary(), byUser: [] };
    },
    adminUsageRecords() {
      return [];
    },
    listTemplates(userId) {
      return templates.get(userId) || [];
    },
    saveTemplate(template) {
      templates.set(template.userId, [...(templates.get(template.userId) || []), template]);
    },
    deleteTemplate(userId, templateId) {
      const current = templates.get(userId) || [];
      const next = current.filter((item) => item.id !== templateId);
      templates.set(userId, next);
      return next.length !== current.length;
    },
    saveJob() {},
    deleteJob() {}
  };
}

function publicJob(job) {
  return {
    id: job.id,
    title: job.title,
    status: job.status,
    outputFiles: job.outputFiles || [],
    outputUrl: job.outputUrl || ""
  };
}

async function createMcpHarness({ legacyTools = false } = {}) {
  const previousLegacy = process.env.MCP_LEGACY_TOOLS;
  process.env.MCP_LEGACY_TOOLS = legacyTools ? "true" : "false";

  const app = express();
  app.use(express.json());
  const store = createStore();
  const jobs = new Map([
    ["job_done", {
      id: "job_done",
      userId: "",
      title: "视频 1",
      status: "done",
      order: 0,
      createdAt: "2026-06-23T00:00:00.000Z",
      outputFiles: [{ label: "原文", url: "/outputs/raw.docx" }]
    }]
  ]);

  registerMcpRoutes(app, {
    baiduQrLogin: {
      start: async () => ({ id: "qr_1", status: "waiting" }),
      status: () => ({ id: "qr_1", status: "waiting" }),
      cancel: async () => true,
      image: () => Buffer.from("")
    },
    getNetdiskAccount: async () => null,
    hasEnoughDiskForNextJob: () => true,
    jobs,
    publicJob,
    pumpQueue() {},
    queue: [],
    loginQuark: async () => ({ loggedIn: true, account: "quark-user", updatedAt: "now" }),
    removeJobFiles() {},
    redactSecret: (value) => value,
    retryJob() {},
    retryJobExtras() {},
    runCommand: async () => ({ stdout: "/usr/bin/tool\n", stderr: "" }),
    runPcsCommand: async () => ({ stdout: "ok", stderr: "" }),
    runtimeStats: () => ({ queue: { queued: 0, running: 0, totalJobs: jobs.size } }),
    setMaxConcurrency() {},
    store,
    userQueuedCount: () => 0,
    userRunningCount: () => 0,
    users: store.users
  });

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function rpc(method, params = {}) {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    return res.json();
  }

  async function tool(name, args = {}) {
    const payload = await rpc("tools/call", { name, arguments: args });
    const result = payload.result;
    assert.equal(payload.error, undefined);
    assert.ok(result?.content?.[0]?.text);
    return {
      isError: Boolean(result.isError),
      value: JSON.parse(result.content[0].text)
    };
  }

  return {
    rpc,
    tool,
    jobs,
    close: async () => {
      await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      if (previousLegacy === undefined) delete process.env.MCP_LEGACY_TOOLS;
      else process.env.MCP_LEGACY_TOOLS = previousLegacy;
    }
  };
}

test("tools/list exposes compact tools by default and hides legacy tools", async () => {
  const harness = await createMcpHarness();
  try {
    const payload = await harness.rpc("tools/list");
    const names = payload.result.tools.map((tool) => tool.name);
    assert.deepEqual(names, [
      "v2w.auth",
      "v2w.status",
      "v2w.config",
      "v2w.netdisk",
      "v2w.templates",
      "v2w.jobs",
      "v2w.usage",
      "v2w.admin"
    ]);
    assert.equal(names.includes("v2w.jobs.submit"), false);
  } finally {
    await harness.close();
  }
});

test("tools/list can expose legacy tools when MCP_LEGACY_TOOLS is enabled", async () => {
  const harness = await createMcpHarness({ legacyTools: true });
  try {
    const payload = await harness.rpc("tools/list");
    const names = payload.result.tools.map((tool) => tool.name);
    assert.ok(names.includes("v2w.auth"));
    assert.ok(names.includes("v2w.jobs.submit"));
  } finally {
    await harness.close();
  }
});

test("v2w.auth setup_status matches legacy setup status core fields", async () => {
  const harness = await createMcpHarness();
  try {
    const compact = await harness.tool("v2w.auth", { action: "setup_status" });
    const legacy = await harness.tool("v2w.setup.status");
    assert.equal(compact.isError, false);
    assert.equal(legacy.isError, false);
    assert.deepEqual(compact.value.tools, legacy.value.tools);
    assert.equal(compact.value.needsAdmin, legacy.value.needsAdmin);
  } finally {
    await harness.close();
  }
});

test("v2w.status returns public service status without auth and rejects invalid authToken", async () => {
  const harness = await createMcpHarness();
  try {
    const publicStatus = await harness.tool("v2w.status");
    assert.equal(publicStatus.isError, false);
    assert.equal(publicStatus.value.name, "V2W");
    assert.equal(publicStatus.value.authenticated, false);
    assert.equal(publicStatus.value.mcp.publicToolCount, 8);

    const invalid = await harness.tool("v2w.status", { authToken: "bad-token" });
    assert.equal(invalid.isError, true);
    assert.match(invalid.value.error, /请先调用 v2w\.auth/);
  } finally {
    await harness.close();
  }
});

test("v2w.status returns account state with a valid authToken", async () => {
  const harness = await createMcpHarness();
  try {
    const registered = await harness.tool("v2w.auth", {
      action: "register",
      username: "worker@example.com",
      password: "secret123"
    });
    assert.equal(registered.isError, false);

    const userId = registered.value.user.id;
    const job = harness.jobs.get("job_done");
    job.userId = userId;
    harness.jobs.set(job.id, job);

    const status = await harness.tool("v2w.status", { authToken: registered.value.authToken });
    assert.equal(status.isError, false);
    assert.equal(status.value.authenticated, true);
    assert.equal(status.value.user.username, "worker@example.com");
    assert.equal(status.value.account.hasModelConfig, false);
    assert.equal(status.value.jobs.total, 1);
  } finally {
    await harness.close();
  }
});

test("v2w.jobs action list/get/downloads routes to legacy job behavior", async () => {
  const harness = await createMcpHarness();
  try {
    const registered = await harness.tool("v2w.auth", {
      action: "register",
      username: "jobs@example.com",
      password: "secret123"
    });
    const userId = registered.value.user.id;
    const job = harness.jobs.get("job_done");
    job.userId = userId;
    harness.jobs.set(job.id, job);

    const listed = await harness.tool("v2w.jobs", { authToken: registered.value.authToken, action: "list" });
    assert.equal(listed.isError, false);
    assert.equal(listed.value.jobs.length, 1);

    const one = await harness.tool("v2w.jobs", {
      authToken: registered.value.authToken,
      action: "get",
      jobId: "job_done"
    });
    assert.equal(one.value.job.id, "job_done");

    const downloads = await harness.tool("v2w.jobs", {
      authToken: registered.value.authToken,
      action: "downloads",
      jobId: "job_done"
    });
    assert.equal(downloads.value.files.length, 1);
    assert.match(downloads.value.files[0].absoluteUrl, /^http:\/\/127\.0\.0\.1:/);
  } finally {
    await harness.close();
  }
});

test("compact MCP tools reject unknown actions clearly", async () => {
  const harness = await createMcpHarness();
  try {
    const result = await harness.tool("v2w.jobs", { action: "explode" });
    assert.equal(result.isError, true);
    assert.match(result.value.error, /Unknown action/);
  } finally {
    await harness.close();
  }
});
