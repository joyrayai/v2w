import { nanoid } from "nanoid";
import { hashPassword, normalizeUsername, signToken, validateUsername, verifyPassword, verifyToken } from "../auth.js";
import { APP_CONFIG, GIB, SHELL, defaultPrompt } from "../config.js";
import { testLlmConnection } from "../services/ai.js";
import { detectNetdiskProvider, unsupportedNetdiskMessage } from "../services/netdisk.js";
import { publicUserSettings, normalizeUserSettings, settingsFromUserConfig } from "../services/settings.js";
import { DEFAULT_EXTRA_DOC_TEMPLATES } from "../defaults/templates.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SERVICE_VERSION = "0.1.7";

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message, data = undefined) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function textContent(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return [{ type: "text", text }];
}

function toolResult(value, isError = false) {
  return { content: textContent(value), isError };
}

function schema(properties = {}, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    isAdmin: normalizeUsername(user.username) === "admin",
    provider: user.provider || "password",
    createdAt: user.createdAt
  };
}

function readBearer(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function authFromArgs(req, args, users) {
  const token = String(args?.authToken || args?.token || readBearer(req) || "");
  const user = verifyToken(token, users);
  if (!user) throw new Error("请先调用 v2w.login 获取 authToken，或在 Authorization Bearer 中传入 token。");
  return { token, user };
}

function templateListWithDefaults(store, userId) {
  const templates = store.listTemplates(userId);
  const existingTitles = new Set(templates.map((item) => String(item.title || "").trim()));
  const now = new Date().toISOString();
  let changed = false;
  for (const item of DEFAULT_EXTRA_DOC_TEMPLATES) {
    if (existingTitles.has(item.title)) continue;
    store.saveTemplate({
      id: `default-${nanoid(12)}`,
      userId,
      title: item.title,
      prompt: item.prompt,
      createdAt: now,
      updatedAt: now
    });
    changed = true;
  }
  return changed ? store.listTemplates(userId) : templates;
}

function publicTemplate(template) {
  return {
    id: template.id,
    title: template.title,
    prompt: template.prompt,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt
  };
}

function normalizeTemplateInput(args = {}) {
  const title = String(args.title || "").trim();
  const prompt = String(args.prompt || "").trim();
  if (!title) throw new Error("请填写模板名称。");
  if (!prompt) throw new Error("请填写模板提示词。");
  return {
    title: title.slice(0, 80),
    prompt: prompt.slice(0, 12000)
  };
}

function getUserTemplate(store, userId, templateId) {
  const template = store.listTemplates(userId).find((item) => item.id === String(templateId || ""));
  if (!template) throw new Error("模板不存在。");
  return template;
}

function qrPayload(session, baiduQrLogin, userId) {
  const image = session?.id ? baiduQrLogin.image(session.id, userId) : null;
  return {
    ...session,
    qrImageUrl: session?.id ? `/api/netdisk/baidu/qr/${encodeURIComponent(session.id)}/image` : "",
    qrImageDataUrl: image ? `data:image/png;base64,${image.toString("base64")}` : ""
  };
}

function reqBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`.replace(/\/+$/, "");
}

function absoluteUrl(req, url, publicBaseUrl = "") {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  const base = String(publicBaseUrl || "").trim().replace(/\/+$/, "") || reqBaseUrl(req);
  return `${base}${String(url).startsWith("/") ? "" : "/"}${url}`;
}

function parseLinks(links) {
  if (!Array.isArray(links)) return [];
  return links
    .map((item, index) => {
      if (typeof item === "string") return { title: `视频 ${index + 1}`, link: item.trim() };
      return {
        title: String(item?.title || `视频 ${index + 1}`).trim(),
        link: String(item?.link || "").trim()
      };
    })
    .filter((item) => item.link);
}

function parseExtraPrompts(extraPrompts) {
  if (!Array.isArray(extraPrompts)) return [];
  return extraPrompts
    .map((item, index) => {
      if (typeof item === "string") {
        return { title: `额外文件 ${index + 1}`, prompt: item.trim(), smartTitle: false };
      }
      return {
        title: String(item?.title || `额外文件 ${index + 1}`).trim(),
        prompt: String(item?.prompt || "").trim(),
        smartTitle: Boolean(item?.smartTitle)
      };
    })
    .filter((item) => item.prompt);
}

function getUserJob(jobs, user, jobId) {
  const job = jobs.get(String(jobId || ""));
  if (!job || job.userId !== user.id) throw new Error("任务不存在。");
  return job;
}

function publicJobWithDownloads(req, publicJob, job, publicBaseUrl = "") {
  const payload = publicJob(job);
  return {
    ...payload,
    outputFiles: (payload.outputFiles || []).map((file) => ({
      ...file,
      absoluteUrl: absoluteUrl(req, file.url, publicBaseUrl)
    })),
    outputUrl: absoluteUrl(req, payload.outputUrl, publicBaseUrl)
  };
}

function userFromCredentials(args, users) {
  const username = normalizeUsername(args.username);
  const password = String(args.password || "");
  if (!validateUsername(username)) {
    throw new Error("账号需为 3-40 位，可包含字母、数字、下划线、邮箱符号、点或横线。");
  }
  if (password.length < 6) throw new Error("密码至少 6 位。");
  if (users.some((user) => user.username === username)) throw new Error("账号已存在。");
  return {
    id: nanoid(12),
    username,
    passwordHash: hashPassword(password),
    provider: "password",
    createdAt: new Date().toISOString()
  };
}

export function registerMcpRoutes(app, ctx) {
  const {
    baiduQrLogin,
    getNetdiskAccount,
    hasEnoughDiskForNextJob,
    jobs,
    publicJob,
    pumpQueue,
    queue,
    loginQuark,
    removeJobFiles,
    redactSecret,
    retryJob,
    retryJobExtras,
    runCommand,
    runPcsCommand,
    runtimeStats,
    setMaxConcurrency,
    store,
    userQueuedCount,
    userRunningCount,
    users
  } = ctx;

  async function commandExists(command) {
    if (!runCommand) return false;
    return runCommand(SHELL, ["-lc", `command -v ${command}`]).then(() => true).catch(() => false);
  }

  async function setupStatus() {
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
    return {
      ok: true,
      needsAdmin: !users.length,
      adminReady: users.some((user) => normalizeUsername(user.username) === "admin"),
      users: users.length,
      tools: { ffmpegOk, ffprobeOk, pcsOk, ytDlpOk, chromeOk }
    };
  }

  const tools = [
    {
      name: "v2w.setup.status",
      description: "Check whether the service is initialized and whether local runtime tools are available.",
      inputSchema: schema()
    },
    {
      name: "v2w.setup.create_admin",
      description: "Create the first administrator account. Only works before any account exists.",
      inputSchema: schema({
        username: { type: "string", description: "Admin username. Defaults to admin if omitted." },
        password: { type: "string", description: "Admin password, at least 6 characters." }
      }, ["password"])
    },
    {
      name: "v2w.account.register",
      description: "Create a password account and return an authToken for that account.",
      inputSchema: schema({
        username: { type: "string" },
        password: { type: "string" }
      }, ["username", "password"])
    },
    {
      name: "v2w.service_info",
      description: "Read V2W service status, runtime limits, queue status and tool availability.",
      inputSchema: schema()
    },
    {
      name: "v2w.login",
      description: "Log in with a V2W account and return an authToken for subsequent MCP tool calls.",
      inputSchema: schema({
        username: { type: "string", description: "V2W account username." },
        password: { type: "string", description: "V2W account password." }
      }, ["username", "password"])
    },
    {
      name: "v2w.config.get",
      description: "Read the current account model configuration. Secrets are redacted.",
      inputSchema: schema({
        authToken: { type: "string", description: "Token returned by v2w.login." }
      })
    },
    {
      name: "v2w.config.save",
      description: "Save model and optional OSS configuration for the current V2W account.",
      inputSchema: schema({
        authToken: { type: "string" },
        config: { type: "object", description: "Same shape as the web app model configuration payload." }
      }, ["config"])
    },
    {
      name: "v2w.config.test",
      description: "Test the current account model configuration or a supplied configuration without saving secrets.",
      inputSchema: schema({
        authToken: { type: "string" },
        config: { type: "object", description: "Optional user configuration shape. If omitted, saved account config is tested." }
      })
    },
    {
      name: "v2w.netdisk.status",
      description: "Read Baidu or Quark netdisk authorization status for the current V2W account.",
      inputSchema: schema({
        authToken: { type: "string" },
        provider: { type: "string", enum: ["baidu", "quark"] }
      }, ["provider"])
    },
    {
      name: "v2w.netdisk.login",
      description: "Authorize Baidu or Quark Netdisk for the current account with copied browser cookies or Baidu BDUSS credentials.",
      inputSchema: schema({
        authToken: { type: "string" },
        provider: { type: "string", enum: ["baidu", "quark"] },
        mode: { type: "string", enum: ["cookies", "bduss"], description: "Baidu supports cookies or bduss. Quark supports cookies only." },
        cookies: { type: "string", description: "Browser Cookie header for Baidu or Quark." },
        bduss: { type: "string", description: "Baidu BDUSS value." },
        stoken: { type: "string", description: "Optional Baidu STOKEN value." },
        ptoken: { type: "string", description: "Optional Baidu PTOKEN value." }
      }, ["provider"])
    },
    {
      name: "v2w.baidu_qr.start",
      description: "Start Baidu Netdisk QR authorization for the current V2W account.",
      inputSchema: schema({
        authToken: { type: "string" }
      })
    },
    {
      name: "v2w.baidu_qr.status",
      description: "Read Baidu Netdisk QR authorization status. When qrImageUrl is present, open it for scanning.",
      inputSchema: schema({
        authToken: { type: "string" },
        sessionId: { type: "string" }
      }, ["sessionId"])
    },
    {
      name: "v2w.baidu_qr.cancel",
      description: "Cancel a Baidu Netdisk QR authorization session.",
      inputSchema: schema({
        authToken: { type: "string" },
        sessionId: { type: "string" }
      }, ["sessionId"])
    },
    {
      name: "v2w.templates.list",
      description: "List extra document templates for the current V2W account, including default templates.",
      inputSchema: schema({
        authToken: { type: "string" }
      })
    },
    {
      name: "v2w.templates.get",
      description: "Read one extra document template for the current account.",
      inputSchema: schema({
        authToken: { type: "string" },
        templateId: { type: "string" }
      }, ["templateId"])
    },
    {
      name: "v2w.templates.create",
      description: "Create an extra document template for the current account.",
      inputSchema: schema({
        authToken: { type: "string" },
        title: { type: "string" },
        prompt: { type: "string" }
      }, ["title", "prompt"])
    },
    {
      name: "v2w.templates.update",
      description: "Update an extra document template owned by the current account.",
      inputSchema: schema({
        authToken: { type: "string" },
        templateId: { type: "string" },
        title: { type: "string" },
        prompt: { type: "string" }
      }, ["templateId", "title", "prompt"])
    },
    {
      name: "v2w.templates.delete",
      description: "Delete an extra document template owned by the current account.",
      inputSchema: schema({
        authToken: { type: "string" },
        templateId: { type: "string" }
      }, ["templateId"])
    },
    {
      name: "v2w.jobs.submit",
      description: "Submit direct, page or supported netdisk video links as transcription jobs for the current account.",
      inputSchema: schema({
        authToken: { type: "string" },
        links: {
          type: "array",
          description: "Links to process. Items can be strings or objects with title and link.",
          items: {
            anyOf: [
              { type: "string" },
              schema({
                title: { type: "string" },
                link: { type: "string" }
              }, ["link"])
            ]
          }
        },
        prompt: { type: "string", description: "Optional transcript-cleanup prompt. Defaults to the service prompt." },
        extraPrompts: {
          type: "array",
          description: "Optional extra Word documents to generate from the transcript.",
          items: schema({
            title: { type: "string" },
            prompt: { type: "string" },
            smartTitle: { type: "boolean" }
          }, ["prompt"])
        },
        concurrency: { type: "number", description: "Requested queue concurrency, capped by server limits." },
        directUrlMode: { type: "boolean", description: "Runtime override for direct media URL handling." },
        publicBaseUrl: { type: "string", description: "Runtime public base URL used when exposing temporary media URLs." }
      }, ["links"])
    },
    {
      name: "v2w.jobs.list",
      description: "List jobs for the current account.",
      inputSchema: schema({
        authToken: { type: "string" },
        status: { type: "string", enum: ["all", "queued", "running", "done", "error"] },
        limit: { type: "number" }
      })
    },
    {
      name: "v2w.jobs.get",
      description: "Read one job for the current account.",
      inputSchema: schema({
        authToken: { type: "string" },
        jobId: { type: "string" }
      }, ["jobId"])
    },
    {
      name: "v2w.jobs.retry",
      description: "Retry a failed or completed-with-error job. If only extra documents failed, only those extra documents are retried.",
      inputSchema: schema({
        authToken: { type: "string" },
        jobId: { type: "string" }
      }, ["jobId"])
    },
    {
      name: "v2w.jobs.retry_extra",
      description: "Retry only failed extra documents for a job that already has a transcript cache.",
      inputSchema: schema({
        authToken: { type: "string" },
        jobId: { type: "string" }
      }, ["jobId"])
    },
    {
      name: "v2w.jobs.delete",
      description: "Delete a non-running job and its generated/runtime files.",
      inputSchema: schema({
        authToken: { type: "string" },
        jobId: { type: "string" }
      }, ["jobId"])
    },
    {
      name: "v2w.jobs.downloads",
      description: "Return generated document download URLs for one job or a batch zip URL for selected jobs.",
      inputSchema: schema({
        authToken: { type: "string" },
        jobId: { type: "string" },
        jobIds: { type: "array", items: { type: "string" } },
        publicBaseUrl: { type: "string" }
      })
    }
  ];

  async function callTool(req, name, args = {}) {
    if (name === "v2w.setup.status") {
      return setupStatus();
    }

    if (name === "v2w.setup.create_admin") {
      if (users.length) throw new Error("系统已存在账号，不能再次初始化管理员。");
      const user = userFromCredentials({ ...args, username: args.username || "admin" }, users);
      users.push(user);
      store.saveUser(user);
      return { authToken: signToken(user), user: publicUser(user), setup: await setupStatus() };
    }

    if (name === "v2w.account.register") {
      const user = userFromCredentials(args, users);
      users.push(user);
      store.saveUser(user);
      return { authToken: signToken(user), user: publicUser(user) };
    }

    if (name === "v2w.service_info") {
      return {
        name: "V2W",
        version: process.env.npm_package_version || SERVICE_VERSION,
        endpoints: {
          baseUrl: reqBaseUrl(req),
          rest: `${reqBaseUrl(req)}/api`,
          mcp: `${reqBaseUrl(req)}/mcp`
        },
        mcp: {
          endpoint: "/mcp",
          url: `${reqBaseUrl(req)}/mcp`,
          protocolVersion: MCP_PROTOCOL_VERSION,
          auth: "Call v2w.login first, then pass authToken in tool arguments or Authorization Bearer."
        },
        runtime: runtimeStats()
      };
    }

    if (name === "v2w.login") {
      const username = normalizeUsername(args.username);
      const password = String(args.password || "");
      const user = users.find((item) => item.username === username && item.provider === "password");
      if (!user || !verifyPassword(password, user.passwordHash)) throw new Error("账号或密码不正确。");
      return { authToken: signToken(user), user: publicUser(user) };
    }

    const { user } = authFromArgs(req, args, users);

    if (name === "v2w.config.get") {
      return { user: publicUser(user), config: publicUserSettings(store.getUserSettings(user.id)) };
    }

    if (name === "v2w.config.save") {
      const config = normalizeUserSettings(args.config || {});
      config.updatedAt = new Date().toISOString();
      store.saveUserSettings(user.id, config);
      return { ok: true, user: publicUser(user), config: publicUserSettings(config) };
    }

    if (name === "v2w.config.test") {
      const config = args.config ? normalizeUserSettings(args.config) : store.getUserSettings(user.id);
      if (!config) throw new Error("请先保存当前账号的模型配置。");
      const result = await testLlmConnection(settingsFromUserConfig(config, {}, req));
      return { ok: true, model: result.model, config: publicUserSettings(config) };
    }

    if (name === "v2w.netdisk.status") {
      const provider = String(args.provider || "baidu");
      if (!["baidu", "quark"].includes(provider)) throw new Error("当前只支持 baidu 或 quark。");
      const account = getNetdiskAccount(user.id, provider);
      return {
        provider,
        loggedIn: Boolean(account?.loggedIn),
        username: account?.username || "",
        updatedAt: account?.updatedAt || null
      };
    }

    if (name === "v2w.netdisk.login") {
      const provider = String(args.provider || "baidu");
      const cookies = String(args.cookies || "").trim();
      const secrets = [cookies, args.bduss, args.stoken, args.ptoken];

      if (provider === "quark") {
        if (!loginQuark) throw new Error("当前服务未启用夸克网盘登录能力。");
        try {
          const account = await loginQuark(user.id, cookies);
          return {
            ok: Boolean(account.loggedIn),
            provider: "quark",
            account: {
              provider: "quark",
              loggedIn: Boolean(account.loggedIn),
              username: account.account || "",
              updatedAt: account.updatedAt || null
            },
            output: redactSecret ? redactSecret(account.raw || "", secrets) : ""
          };
        } catch (err) {
          throw new Error((redactSecret ? redactSecret(err.message, secrets) : err.message) || "夸克网盘登录失败。");
        }
      }

      if (provider !== "baidu") throw new Error("当前只支持 baidu 或 quark。");
      if (!runPcsCommand) throw new Error("当前服务未启用 BaiduPCS-Go。");

      const mode = String(args.mode || "cookies");
      const pcsArgs = ["login"];
      if (mode === "cookies") {
        if (!cookies) throw new Error("请填写百度网盘 Cookies。");
        pcsArgs.push(`-cookies=${cookies}`);
      } else if (mode === "bduss") {
        const bduss = String(args.bduss || "").trim();
        if (!bduss) throw new Error("请填写 BDUSS。");
        pcsArgs.push(`-bduss=${bduss}`);
        if (String(args.stoken || "").trim()) pcsArgs.push(`-stoken=${String(args.stoken).trim()}`);
        if (String(args.ptoken || "").trim()) pcsArgs.push(`-ptoken=${String(args.ptoken).trim()}`);
      } else {
        throw new Error("百度网盘 MCP 登录只支持 cookies 或 bduss。");
      }

      try {
        const result = await runPcsCommand(pcsArgs, user.id);
        const account = await getNetdiskAccount(user.id, "baidu");
        const output = [
          `${result.stdout || ""}${result.stderr || ""}`.trim(),
          account.raw || ""
        ].filter(Boolean).join("\n");
        return {
          ok: Boolean(account?.loggedIn),
          provider: "baidu",
          account: {
            provider: "baidu",
            loggedIn: Boolean(account?.loggedIn),
            username: account?.username || account?.account || "",
            uid: account?.uid || "",
            updatedAt: account?.updatedAt || null
          },
          output: redactSecret ? redactSecret(output, secrets) : output
        };
      } catch (err) {
        throw new Error((redactSecret ? redactSecret(err.message, secrets) : err.message) || "百度网盘登录失败。");
      }
    }

    if (name === "v2w.baidu_qr.start") {
      const session = await baiduQrLogin.start(user.id);
      return qrPayload(session, baiduQrLogin, user.id);
    }

    if (name === "v2w.baidu_qr.status") {
      const session = baiduQrLogin.status(args.sessionId, user.id);
      if (!session) throw new Error("扫码会话不存在或已过期。");
      return qrPayload(session, baiduQrLogin, user.id);
    }

    if (name === "v2w.baidu_qr.cancel") {
      const ok = await baiduQrLogin.cancel(args.sessionId, user.id);
      if (!ok) throw new Error("扫码登录会话不存在或已结束。");
      return { ok: true, sessionId: args.sessionId };
    }

    if (name === "v2w.templates.list") {
      return { templates: templateListWithDefaults(store, user.id).map(publicTemplate) };
    }

    if (name === "v2w.templates.get") {
      return { template: publicTemplate(getUserTemplate(store, user.id, args.templateId)) };
    }

    if (name === "v2w.templates.create") {
      const input = normalizeTemplateInput(args);
      const template = {
        id: nanoid(16),
        userId: user.id,
        title: input.title,
        prompt: input.prompt,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      store.saveTemplate(template);
      return { template: publicTemplate(template) };
    }

    if (name === "v2w.templates.update") {
      const existing = getUserTemplate(store, user.id, args.templateId);
      const input = normalizeTemplateInput(args);
      const template = {
        ...existing,
        title: input.title,
        prompt: input.prompt,
        updatedAt: new Date().toISOString()
      };
      store.saveTemplate(template);
      return { template: publicTemplate(template) };
    }

    if (name === "v2w.templates.delete") {
      const deleted = store.deleteTemplate(user.id, args.templateId);
      if (!deleted) throw new Error("模板不存在。");
      return { ok: true, deletedTemplateId: args.templateId };
    }

    if (name === "v2w.jobs.submit") {
      const savedConfig = store.getUserSettings(user.id);
      if (!savedConfig) throw new Error("请先保存当前账号的模型配置。");

      const validLinks = parseLinks(args.links);
      if (!validLinks.length) throw new Error("请至少填写一个视频链接。");

      const unsupported = validLinks
        .map((item) => detectNetdiskProvider(item.link))
        .find((provider) => provider && !provider.supported);
      if (unsupported) throw new Error(unsupportedNetdiskMessage(unsupported));

      if (!hasEnoughDiskForNextJob()) {
        throw new Error(`服务器磁盘剩余空间不足 ${Math.round(APP_CONFIG.minFreeDiskBytes / GIB)}GB，暂时不能提交新任务。`);
      }

      const pendingForUser = userQueuedCount(user.id) + userRunningCount(user.id);
      if (pendingForUser + validLinks.length > APP_CONFIG.maxUserQueued) {
        throw new Error(`当前账号最多保留 ${APP_CONFIG.maxUserQueued} 个待处理任务，请先处理或删除旧任务。`);
      }

      const runtimeSettings = {
        directUrlMode: typeof args.directUrlMode === "boolean" ? args.directUrlMode : undefined,
        publicBaseUrl: String(args.publicBaseUrl || "").trim()
      };
      const effectiveSettings = settingsFromUserConfig(savedConfig, runtimeSettings, req);
      const requestedConcurrency = Number(args.concurrency) || APP_CONFIG.maxConcurrency;
      setMaxConcurrency(Math.max(1, Math.min(APP_CONFIG.maxConcurrency, requestedConcurrency)));

      const userJobs = [...jobs.values()].filter((job) => job.userId === user.id);
      const nextOrder = userJobs.reduce((max, job) => Math.max(max, Number(job.order) || 0), -1) + 1;
      const extraPrompts = parseExtraPrompts(args.extraPrompts);
      const created = validLinks.map((item, index) => {
        const job = {
          id: nanoid(10),
          title: item.title || `视频 ${index + 1}`,
          link: item.link,
          order: nextOrder + index,
          prompt: String(args.prompt || defaultPrompt),
          extraPrompts,
          settings: effectiveSettings,
          userId: user.id,
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
      return {
        submitted: created.length,
        jobs: created.map((job) => publicJobWithDownloads(req, publicJob, job, args.publicBaseUrl))
      };
    }

    if (name === "v2w.jobs.list") {
      const status = String(args.status || "all");
      const limit = Math.max(1, Math.min(200, Number.parseInt(String(args.limit || "100"), 10) || 100));
      const items = [...jobs.values()]
        .filter((job) => job.userId === user.id)
        .filter((job) => status === "all" || job.status === status)
        .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit)
        .map((job) => publicJobWithDownloads(req, publicJob, job, args.publicBaseUrl));
      return { jobs: items };
    }

    if (name === "v2w.jobs.get") {
      const job = getUserJob(jobs, user, args.jobId);
      return { job: publicJobWithDownloads(req, publicJob, job, args.publicBaseUrl) };
    }

    if (name === "v2w.jobs.retry_extra") {
      const job = getUserJob(jobs, user, args.jobId);
      if (!job.retryableExtraFailure || !Array.isArray(job.failedExtraIndexes) || !job.failedExtraIndexes.length) {
        throw new Error("该任务没有可重试的失败额外文件。");
      }
      const savedConfig = store.getUserSettings(user.id);
      if (!savedConfig) throw new Error("请先保存当前账号的模型配置。");
      retryJobExtras(job, settingsFromUserConfig(savedConfig, {}, req));
      return { ok: true, job: publicJobWithDownloads(req, publicJob, job, args.publicBaseUrl) };
    }

    if (name === "v2w.jobs.retry") {
      const job = getUserJob(jobs, user, args.jobId);
      if (job.status === "running" || job.status === "queued") throw new Error("任务正在处理，不能重复重试。");
      const savedConfig = store.getUserSettings(user.id);
      if (!savedConfig) throw new Error("请先保存当前账号的模型配置。");
      const effectiveSettings = settingsFromUserConfig(savedConfig, {
        directUrlMode: job.settings?.directUrlMode
      }, req);
      if (job.retryableExtraFailure && job.rawText && Array.isArray(job.failedExtraIndexes) && job.failedExtraIndexes.length) {
        retryJobExtras(job, effectiveSettings);
      } else {
        retryJob(job, effectiveSettings);
      }
      return { ok: true, job: publicJobWithDownloads(req, publicJob, job, args.publicBaseUrl) };
    }

    if (name === "v2w.jobs.delete") {
      const job = getUserJob(jobs, user, args.jobId);
      if (job.status === "running") throw new Error("任务正在运行，暂不能删除。");
      const queuedIndex = queue.findIndex((item) => item.id === job.id);
      if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
      removeJobFiles(job);
      jobs.delete(job.id);
      store.deleteJob(job.id);
      return { ok: true, deletedJobId: job.id };
    }

    if (name === "v2w.jobs.downloads") {
      const publicBaseUrl = String(args.publicBaseUrl || "").trim();
      const selectedIds = Array.isArray(args.jobIds) && args.jobIds.length
        ? args.jobIds.map((id) => String(id))
        : (args.jobId ? [String(args.jobId)] : []);
      const selectedJobs = selectedIds.length
        ? selectedIds.map((id) => getUserJob(jobs, user, id))
        : [...jobs.values()].filter((job) => job.userId === user.id);
      const files = selectedJobs.flatMap((job) => {
        const payload = publicJobWithDownloads(req, publicJob, job, publicBaseUrl);
        return (payload.outputFiles || []).map((file) => ({
          jobId: job.id,
          jobTitle: job.title,
          label: file.label,
          url: file.url,
          absoluteUrl: file.absoluteUrl
        }));
      });
      const zipIds = selectedJobs.map((job) => job.id).join(",");
      return {
        files,
        zipUrl: zipIds && files.length ? absoluteUrl(req, `/api/downloads/all.zip?ids=${encodeURIComponent(zipIds)}`, publicBaseUrl) : ""
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  app.get("/mcp", (_req, res) => {
    res.json({
      name: "V2W MCP",
      protocolVersion: MCP_PROTOCOL_VERSION,
      endpoint: "/mcp",
      methods: ["initialize", "tools/list", "tools/call"]
    });
  });

  app.post("/mcp", async (req, res) => {
    const body = req.body || {};
    const id = body.id ?? null;
    try {
      if (body.method === "initialize") {
        return res.json(jsonRpcResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "v2w", version: process.env.npm_package_version || SERVICE_VERSION }
        }));
      }

      if (body.method === "notifications/initialized") {
        return res.status(202).end();
      }

      if (body.method === "tools/list") {
        return res.json(jsonRpcResult(id, { tools }));
      }

      if (body.method === "tools/call") {
        const name = body.params?.name;
        const args = body.params?.arguments || {};
        const result = await callTool(req, name, args);
        return res.json(jsonRpcResult(id, toolResult(result)));
      }

      return res.json(jsonRpcError(id, -32601, `Method not found: ${body.method}`));
    } catch (err) {
      return res.json(jsonRpcResult(id, toolResult({ error: err.message || "MCP tool call failed" }, true)));
    }
  });
}
