import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { APP_CONFIG, GIB, OUTPUT_DIR, SHELL, USAGE_PRICING, defaultPrompt } from "./config.js";
import { hashPassword, normalizeUsername, signToken, validateUsername, verifyPassword } from "./auth.js";
import { safeName } from "./utils.js";
import { detectNetdiskProvider, unsupportedNetdiskMessage } from "./services/netdisk.js";
import { publicUsageRecord, usageDateRange } from "./services/usage.js";
import { testLlmConnection } from "./services/ai.js";
import { normalizeUserSettings, settingsFromUserConfig } from "./services/settings.js";
import { DEFAULT_EXTRA_DOC_TEMPLATES } from "./defaults/templates.js";

export function registerRoutes(app, ctx) {
  const {
    baiduQrLogin,
    createZipArchive,
    getNetdiskAccount,
    hasEnoughDiskForNextJob,
    jobs,
    loginQuark,
    publicJob,
    publicUser,
    pumpQueue,
    queue,
    redactSecret,
    removeJobFiles,
    requireAuth,
    retryJobExtras,
    retryJob,
    runCommand,
    runPcsCommand,
    runtimeStats,
    setMaxConcurrency,
    store,
    userQueuedCount,
    userRunningCount,
    users
  } = ctx;

  function isAdmin(user) {
    return normalizeUsername(user?.username) === "admin";
  }

  function requireAdmin(req, res, next) {
    requireAuth(req, res, () => {
      if (!isAdmin(req.user)) return res.status(403).json({ error: "需要管理员权限。" });
      next();
    });
  }

  function jobCountsForUser(userId) {
    const userJobs = [...jobs.values()].filter((job) => job.userId === userId);
    return {
      total: userJobs.length,
      queued: userJobs.filter((job) => job.status === "queued").length,
      running: userJobs.filter((job) => job.status === "running").length,
      done: userJobs.filter((job) => job.status === "done").length,
      error: userJobs.filter((job) => job.status === "error").length
    };
  }

  function publicAdminUsageRecord(record) {
    return {
      ...publicUsageRecord(record),
      userId: record.userId,
      username: record.username || ""
    };
  }

  async function commandExists(command) {
    return runCommand(SHELL, ["-lc", `command -v ${command}`]).then(() => true).catch(() => false);
  }

  app.get("/api/setup/status", async (_req, res) => {
    const [ffmpegOk, ffprobeOk, pcsOk, ytDlpOk, chromeOk] = await Promise.all([
      commandExists("ffmpeg"),
      commandExists("ffprobe"),
      commandExists("BaiduPCS-Go"),
      commandExists("yt-dlp"),
      Promise.resolve(Boolean(process.env.CHROME_PATH || process.env.CHROMIUM_PATH))
        .then((configured) => configured || commandExists("google-chrome").catch(() => false))
        .then((ok) => ok || commandExists("chromium").catch(() => false))
        .then((ok) => ok || commandExists("chromium-browser").catch(() => false))
        .then((ok) => ok || commandExists("open").catch(() => false))
    ]);
    const adminReady = users.some((user) => isAdmin(user));
    res.json({
      ok: true,
      needsAdmin: !users.length,
      adminReady,
      users: users.length,
      tools: { ffmpegOk, ffprobeOk, pcsOk, ytDlpOk, chromeOk }
    });
  });

  app.post("/api/setup/admin", (req, res) => {
    if (users.length) return res.status(409).json({ error: "系统已存在账号，不能再次初始化管理员。" });
    const username = normalizeUsername(req.body?.username || "admin");
    const password = String(req.body?.password || "");
    if (!validateUsername(username)) {
      return res.status(400).json({ error: "账号需为 3-40 位，可包含字母、数字、下划线、邮箱符号、点或横线。" });
    }
    if (password.length < 6) return res.status(400).json({ error: "密码至少 6 位。" });
    const user = {
      id: nanoid(12),
      username,
      passwordHash: hashPassword(password),
      provider: "password",
      createdAt: new Date().toISOString()
    };
    users.push(user);
    store.saveUser(user);
    res.json({ token: signToken(user), user: publicUser(user) });
  });

  app.post("/api/auth/register", (req, res) => {
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password || "");
    if (!validateUsername(username)) {
      return res.status(400).json({ error: "账号需为 3-40 位，可包含字母、数字、下划线、邮箱符号、点或横线。" });
    }
    if (password.length < 6) return res.status(400).json({ error: "密码至少 6 位。" });
    if (users.some((user) => user.username === username)) return res.status(409).json({ error: "账号已存在。" });

    const user = {
      id: nanoid(12),
      username,
      passwordHash: hashPassword(password),
      provider: "password",
      createdAt: new Date().toISOString()
    };
    users.push(user);
    store.saveUser(user);
    res.json({ token: signToken(user), user: publicUser(user) });
  });

  app.post("/api/auth/login", (req, res) => {
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password || "");
    const user = users.find((item) => item.username === username && item.provider === "password");
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: "账号或密码不正确。" });
    }
    res.json({ token: signToken(user), user: publicUser(user) });
  });

  app.get("/api/auth/me", requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  app.get("/api/auth/wechat/start", (_req, res) => {
    res.status(501).json({ error: "微信扫码登录暂未开放，请先使用账号密码登录。" });
  });

  app.get("/api/auth/wechat/callback", (_req, res) => {
    res.status(501).json({ error: "微信扫码登录暂未开放，请先使用账号密码登录。" });
  });

  app.get("/api/health", async (_req, res) => {
    const ffmpegOk = await runCommand(SHELL, ["-lc", "command -v ffmpeg"]).then(() => true).catch(() => false);
    const pcsOk = await runCommand(SHELL, ["-lc", "command -v BaiduPCS-Go"]).then(() => true).catch(() => false);
    const ytDlpOk = await runCommand(SHELL, ["-lc", "command -v yt-dlp"]).then(() => true).catch(() => false);
    res.json({ ok: true, ffmpegOk, pcsOk, ytDlpOk, defaultPrompt, runtime: runtimeStats() });
  });

  app.post("/api/config/test", requireAuth, async (req, res) => {
    try {
      const result = await testLlmConnection(req.body?.settings || {});
      res.json({ ok: true, model: result.model });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message || "连接测试失败。" });
    }
  });

  app.get("/api/config", requireAuth, (req, res) => {
    res.json({ config: store.getUserSettings(req.user.id) });
  });

  app.put("/api/config", requireAuth, (req, res) => {
    const config = normalizeUserSettings(req.body?.config || req.body || {});
    config.updatedAt = new Date().toISOString();
    store.saveUserSettings(req.user.id, config);
    res.json({ ok: true, config });
  });

  app.get("/api/usage/summary", requireAuth, (req, res) => {
    const range = String(req.query.range || "month");
    const dateRange = usageDateRange(range === "today" ? "today" : "month");
    const summary = store.usageSummary(req.user.id, dateRange);
    res.json({ range: dateRange.range, start: dateRange.start, end: dateRange.end, summary });
  });

  app.get("/api/usage/records", requireAuth, (req, res) => {
    const range = String(req.query.range || "month");
    const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
    const pageSize = Math.max(1, Math.min(100, Number.parseInt(String(req.query.pageSize || "50"), 10) || 50));
    const dateRange = usageDateRange(range === "today" ? "today" : "month");
    const records = store.usageRecords(req.user.id, {
      ...dateRange,
      limit: pageSize,
      offset: (page - 1) * pageSize
    });
    res.json({ range: dateRange.range, page, pageSize, records: records.map(publicUsageRecord) });
  });

  app.get("/api/usage/pricing", requireAuth, (_req, res) => {
    res.json({ pricing: USAGE_PRICING });
  });

  function publicTemplate(template) {
    return {
      id: template.id,
      title: template.title,
      prompt: template.prompt,
      createdAt: template.createdAt,
      updatedAt: template.updatedAt
    };
  }

  function listTemplatesWithDefaults(userId) {
    const templates = store.listTemplates(userId);
    const existingTitles = new Set(templates.map((item) => String(item.title || "").trim()));
    const now = new Date().toISOString();
    let changed = false;
    for (const item of DEFAULT_EXTRA_DOC_TEMPLATES) {
      if (existingTitles.has(item.title)) continue;
      const template = {
        id: `default-${nanoid(12)}`,
        userId,
        title: item.title,
        prompt: item.prompt,
        createdAt: now,
        updatedAt: now
      };
      store.saveTemplate(template);
      templates.unshift(template);
      changed = true;
    }
    return changed ? store.listTemplates(userId) : templates;
  }

  app.get("/api/templates", requireAuth, (req, res) => {
    res.json({ templates: listTemplatesWithDefaults(req.user.id).map(publicTemplate) });
  });

  app.post("/api/templates", requireAuth, (req, res) => {
    const title = String(req.body?.title || "").trim();
    const prompt = String(req.body?.prompt || "").trim();
    if (!title) return res.status(400).json({ error: "请填写模板名称。" });
    if (!prompt) return res.status(400).json({ error: "请填写模板提示词。" });
    const template = {
      id: nanoid(16),
      userId: req.user.id,
      title: title.slice(0, 80),
      prompt: prompt.slice(0, 12000),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    store.saveTemplate(template);
    res.json({ template: publicTemplate(template) });
  });

  app.put("/api/templates/:id", requireAuth, (req, res) => {
    const existing = store.listTemplates(req.user.id).find((item) => item.id === req.params.id);
    if (!existing) return res.status(404).json({ error: "模板不存在。" });
    const title = String(req.body?.title || "").trim();
    const prompt = String(req.body?.prompt || "").trim();
    if (!title) return res.status(400).json({ error: "请填写模板名称。" });
    if (!prompt) return res.status(400).json({ error: "请填写模板提示词。" });
    const template = {
      ...existing,
      title: title.slice(0, 80),
      prompt: prompt.slice(0, 12000),
      updatedAt: new Date().toISOString()
    };
    store.saveTemplate(template);
    res.json({ template: publicTemplate(template) });
  });

  app.delete("/api/templates/:id", requireAuth, (req, res) => {
    const deleted = store.deleteTemplate(req.user.id, req.params.id);
    if (!deleted) return res.status(404).json({ error: "模板不存在。" });
    res.json({ ok: true });
  });

  app.get("/api/admin/users", requireAdmin, (req, res) => {
    const range = String(req.query.range || "month");
    const dateRange = usageDateRange(range === "today" ? "today" : "month");
    const usageByUser = new Map((store.adminUsageSummary(dateRange).byUser || []).map((item) => [item.id, item]));
    res.json({
      range: dateRange.range,
      users: users.map((user) => ({
        id: user.id,
        username: user.username,
        provider: user.provider || "password",
        isAdmin: isAdmin(user),
        createdAt: user.createdAt,
        jobs: jobCountsForUser(user.id),
        usage: usageByUser.get(user.id) || {
          records: 0,
          asrSeconds: 0,
          llmTokens: 0,
          estimatedCost: 0
        }
      })).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    });
  });

  app.patch("/api/admin/users/:id/password", requireAdmin, (req, res) => {
    const password = String(req.body?.password || "");
    if (password.length < 6) return res.status(400).json({ error: "密码至少 6 位。" });
    const user = users.find((item) => item.id === req.params.id);
    if (!user || user.provider !== "password") return res.status(404).json({ error: "账号不存在或不支持重置密码。" });
    user.passwordHash = hashPassword(password);
    store.saveUser(user);
    res.json({ ok: true, user: publicUser(user) });
  });

  app.get("/api/admin/usage/summary", requireAdmin, (req, res) => {
    const range = String(req.query.range || "month");
    const dateRange = usageDateRange(range === "today" ? "today" : "month");
    const summary = store.adminUsageSummary(dateRange);
    res.json({ range: dateRange.range, start: dateRange.start, end: dateRange.end, summary });
  });

  app.get("/api/admin/usage/records", requireAdmin, (req, res) => {
    const range = String(req.query.range || "month");
    const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
    const pageSize = Math.max(1, Math.min(200, Number.parseInt(String(req.query.pageSize || "100"), 10) || 100));
    const dateRange = usageDateRange(range === "today" ? "today" : "month");
    const records = store.adminUsageRecords({
      ...dateRange,
      limit: pageSize,
      offset: (page - 1) * pageSize
    });
    res.json({ range: dateRange.range, page, pageSize, records: records.map(publicAdminUsageRecord) });
  });

  app.post("/api/jobs", requireAuth, (req, res) => {
    const { links = [], prompt = defaultPrompt, extraPrompts = [], settings = {}, concurrency = 5 } = req.body || {};
    const savedConfig = store.getUserSettings(req.user.id);
    if (!savedConfig) return res.status(400).json({ error: "请先到“模型配置”保存当前账号的模型配置。" });
    const effectiveSettings = savedConfig
      ? settingsFromUserConfig(savedConfig, settings, req)
      : settings;
    const validLinks = Array.isArray(links) ? links.filter((item) => item?.link?.trim()) : [];
    if (!validLinks.length) return res.status(400).json({ error: "请至少填写一个视频链接。" });
    const unsupported = validLinks
      .map((item) => detectNetdiskProvider(item.link))
      .find((provider) => provider && !provider.supported);
    if (unsupported) return res.status(400).json({ error: unsupportedNetdiskMessage(unsupported) });
    if (!hasEnoughDiskForNextJob()) {
      return res.status(507).json({ error: `服务器磁盘剩余空间不足 ${Math.round(APP_CONFIG.minFreeDiskBytes / GIB)}GB，暂时不能提交新任务。` });
    }
    const pendingForUser = userQueuedCount(req.user.id) + userRunningCount(req.user.id);
    if (pendingForUser + validLinks.length > APP_CONFIG.maxUserQueued) {
      return res.status(429).json({ error: `当前账号最多保留 ${APP_CONFIG.maxUserQueued} 个待处理任务，请先处理或删除旧任务。` });
    }
    setMaxConcurrency(Math.max(1, Math.min(APP_CONFIG.maxConcurrency, Number(concurrency) || APP_CONFIG.maxConcurrency)));
    const userJobs = [...jobs.values()].filter((job) => job.userId === req.user.id);
    const nextOrder = userJobs.reduce((max, job) => Math.max(max, Number(job.order) || 0), -1) + 1;
    const created = validLinks.map((item, index) => {
      const job = {
        id: nanoid(10),
        title: item.title || `视频 ${index + 1}`,
        link: item.link.trim(),
        order: nextOrder + index,
        prompt,
        extraPrompts,
        settings: effectiveSettings,
        userId: req.user.id,
        status: "queued",
        step: "排队中",
        progress: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      jobs.set(job.id, job);
      store.saveJob(job);
      queue.push(job);
      return job;
    });
    pumpQueue();
    res.json({ jobs: created.map(publicJob) });
  });

  app.get("/api/queue", requireAuth, (req, res) => {
    const userJobs = [...jobs.values()].filter((job) => job.userId === req.user.id);
    res.json({
      paused: runtimeStats().queue.paused,
      reason: runtimeStats().queue.reason,
      queued: userJobs.filter((job) => job.status === "queued").length,
      running: userJobs.filter((job) => job.status === "running").length,
      runtime: runtimeStats()
    });
  });

  app.post("/api/queue/resume", requireAuth, (_req, res) => {
    if (!hasEnoughDiskForNextJob()) {
      return res.status(507).json({ error: `服务器磁盘剩余空间不足 ${Math.round(APP_CONFIG.minFreeDiskBytes / GIB)}GB，清理后才能继续。` });
    }
    ctx.resumeQueue();
    res.json({ ok: true, paused: false });
  });

  app.get("/api/netdisk/status", requireAuth, async (req, res) => {
    const provider = String(req.query.provider || "baidu");
    if (!["baidu", "quark"].includes(provider)) return res.status(400).json({ error: "不支持的网盘类型。" });
    res.json(await getNetdiskAccount(req.user.id, provider));
  });

  app.post("/api/netdisk/baidu/qr/start", requireAuth, async (req, res) => {
    try {
      const session = await baiduQrLogin.start(req.user.id);
      res.json({ session });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || "百度网盘扫码登录启动失败。" });
    }
  });

  app.get("/api/netdisk/baidu/qr/:id/status", requireAuth, (req, res) => {
    const session = baiduQrLogin.status(req.params.id, req.user.id);
    if (!session) return res.status(404).json({ error: "扫码登录会话不存在或已过期。" });
    res.json({ session });
  });

  app.get("/api/netdisk/baidu/qr/:id/image", requireAuth, (req, res) => {
    const image = baiduQrLogin.image(req.params.id, req.user.id);
    if (!image) return res.status(404).json({ error: "二维码暂未生成，请稍后刷新。" });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.end(image);
  });

  app.post("/api/netdisk/baidu/qr/:id/cancel", requireAuth, async (req, res) => {
    const ok = await baiduQrLogin.cancel(req.params.id, req.user.id);
    if (!ok) return res.status(404).json({ error: "扫码登录会话不存在或已结束。" });
    res.json({ ok: true });
  });

  app.post("/api/netdisk/login", requireAuth, async (req, res) => {
    const { provider = "baidu", mode = "cookies", cookies = "", bduss = "", stoken = "", ptoken = "", username = "", password = "" } = req.body || {};
    if (provider === "quark") {
      try {
        const account = await loginQuark(req.user.id, cookies);
        return res.json({ ok: account.loggedIn, account, output: account.raw || "" });
      } catch (err) {
        return res.status(500).json({ error: redactSecret(err.message, [cookies]) || "夸克网盘登录失败" });
      }
    }
    if (provider !== "baidu") return res.status(400).json({ error: "不支持的网盘类型。" });

    const args = ["login"];
    const secrets = [cookies, bduss, stoken, ptoken, password];

    if (mode === "cookies") {
      if (!String(cookies).trim()) return res.status(400).json({ error: "请填写百度网盘 Cookies。" });
      args.push(`-cookies=${String(cookies).trim()}`);
    } else if (mode === "bduss") {
      if (!String(bduss).trim()) return res.status(400).json({ error: "请填写 BDUSS。" });
      args.push(`-bduss=${String(bduss).trim()}`);
      if (String(stoken).trim()) args.push(`-stoken=${String(stoken).trim()}`);
      if (String(ptoken).trim()) args.push(`-ptoken=${String(ptoken).trim()}`);
    } else if (mode === "password") {
      if (!String(username).trim() || !String(password).trim()) {
        return res.status(400).json({ error: "请填写百度账号和密码。" });
      }
      args.push(`-username=${String(username).trim()}`, `-password=${String(password)}`);
    } else {
      return res.status(400).json({ error: "不支持的登录方式。" });
    }

    try {
      const result = await runPcsCommand(args, req.user.id);
      const account = await getNetdiskAccount(req.user.id, "baidu");
      const output = [
        `${result.stdout || ""}${result.stderr || ""}`.trim(),
        account.raw || ""
      ].filter(Boolean).join("\n");
      res.json({
        ok: account.loggedIn,
        account,
        output: redactSecret(output, secrets)
      });
    } catch (err) {
      res.status(500).json({ error: redactSecret(err.message, secrets) || "百度网盘登录失败" });
    }
  });

  app.get("/api/jobs", requireAuth, (req, res) => {
    res.json({
      jobs: [...jobs.values()]
        .filter((job) => job.userId === req.user.id)
        .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
        .map(publicJob)
    });
  });

  app.get("/api/jobs/:id", requireAuth, (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.userId !== req.user.id) return res.status(404).json({ error: "not found" });
    res.json({ job: publicJob(job) });
  });

  app.post("/api/jobs/:id/retry-extra", requireAuth, (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.userId !== req.user.id) return res.status(404).json({ error: "not found" });
    if (!job.retryableExtraFailure || !Array.isArray(job.failedExtraIndexes) || !job.failedExtraIndexes.length) {
      return res.status(400).json({ error: "该任务没有可重试的失败额外文件。" });
    }
    try {
      const savedConfig = store.getUserSettings(req.user.id);
      if (!savedConfig) return res.status(400).json({ error: "请先到“模型配置”保存当前账号的模型配置。" });
      retryJobExtras(job, settingsFromUserConfig(savedConfig, {}, req));
      res.json({ ok: true, job: publicJob(job) });
    } catch (err) {
      res.status(409).json({ error: err.message || "重试失败。" });
    }
  });

  app.post("/api/jobs/:id/retry", requireAuth, (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.userId !== req.user.id) return res.status(404).json({ error: "not found" });
    if (job.status === "running" || job.status === "queued") {
      return res.status(409).json({ error: "任务正在处理，不能重复重试。" });
    }
    try {
      const savedConfig = store.getUserSettings(req.user.id);
      if (!savedConfig) return res.status(400).json({ error: "请先到“模型配置”保存当前账号的模型配置。" });
      const effectiveSettings = settingsFromUserConfig(savedConfig, {
        directUrlMode: job.settings?.directUrlMode
      }, req);
      if (job.retryableExtraFailure && job.rawText && Array.isArray(job.failedExtraIndexes) && job.failedExtraIndexes.length) {
        retryJobExtras(job, effectiveSettings);
      } else {
        retryJob(job, effectiveSettings);
      }
      res.json({ ok: true, job: publicJob(job) });
    } catch (err) {
      res.status(409).json({ error: err.message || "重试失败。" });
    }
  });

  app.delete("/api/jobs/:id", requireAuth, (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.userId !== req.user.id) return res.status(404).json({ error: "not found" });
    if (job.status === "running") return res.status(409).json({ error: "任务正在运行，暂不能删除" });

    const queuedIndex = queue.findIndex((item) => item.id === job.id);
    if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
    removeJobFiles(job);
    jobs.delete(job.id);
    store.deleteJob(job.id);
    res.json({ ok: true });
  });

  app.get("/api/downloads/all.zip", requireAuth, (req, res) => {
    const ids = String(req.query.ids || "").split(",").map((id) => id.trim()).filter(Boolean);
    const selectedJobs = (ids.length ? ids.map((id) => jobs.get(id)).filter(Boolean) : [...jobs.values()])
      .filter((job) => job.userId === req.user.id);
    const files = [];
    for (const job of selectedJobs) {
      for (const output of job.outputFiles || []) {
        const urlPath = decodeURIComponent(output.url || "").replace(/^\/outputs\//, "");
        const filePath = path.join(OUTPUT_DIR, path.basename(urlPath));
        if (fs.existsSync(filePath)) {
          files.push({
            filePath,
            name: `${String(job.order + 1).padStart(2, "0")}_${safeName(job.outputBaseTitle || job.title)}_${safeName(output.label)}.docx`
          });
        }
      }
    }
    if (!files.length) return res.status(404).json({ error: "暂无可下载的 Word 文件" });

    res.attachment(`video-to-word-${Date.now()}.zip`);
    const archive = createZipArchive({ zlib: { level: 9 } });
    archive.on("error", (err) => res.status(500).end(err.message));
    archive.pipe(res);
    for (const file of files) archive.file(file.filePath, { name: file.name });
    archive.finalize();
  });
}
