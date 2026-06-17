import { nanoid } from "nanoid";
import { normalizeUsername, signToken, verifyPassword, verifyToken } from "../auth.js";
import { publicUserSettings, normalizeUserSettings } from "../services/settings.js";
import { DEFAULT_EXTRA_DOC_TEMPLATES } from "../defaults/templates.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";

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

function qrPayload(session, baiduQrLogin, userId) {
  const image = session?.id ? baiduQrLogin.image(session.id, userId) : null;
  return {
    ...session,
    qrImageUrl: session?.id ? `/api/netdisk/baidu/qr/${encodeURIComponent(session.id)}/image` : "",
    qrImageDataUrl: image ? `data:image/png;base64,${image.toString("base64")}` : ""
  };
}

export function registerMcpRoutes(app, ctx) {
  const { baiduQrLogin, getNetdiskAccount, runtimeStats, store, users } = ctx;

  const tools = [
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
      name: "v2w.netdisk.status",
      description: "Read Baidu or Quark netdisk authorization status for the current V2W account.",
      inputSchema: schema({
        authToken: { type: "string" },
        provider: { type: "string", enum: ["baidu", "quark"] }
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
      name: "v2w.templates.list",
      description: "List extra document templates for the current V2W account, including default templates.",
      inputSchema: schema({
        authToken: { type: "string" }
      })
    }
  ];

  async function callTool(req, name, args = {}) {
    if (name === "v2w.service_info") {
      return {
        name: "V2W",
        version: process.env.npm_package_version || "0.1.3",
        mcp: {
          endpoint: "/mcp",
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

    if (name === "v2w.baidu_qr.start") {
      const session = await baiduQrLogin.start(user.id);
      return qrPayload(session, baiduQrLogin, user.id);
    }

    if (name === "v2w.baidu_qr.status") {
      const session = baiduQrLogin.status(args.sessionId, user.id);
      if (!session) throw new Error("扫码会话不存在或已过期。");
      return qrPayload(session, baiduQrLogin, user.id);
    }

    if (name === "v2w.templates.list") {
      return { templates: templateListWithDefaults(store, user.id).map(publicTemplate) };
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
          serverInfo: { name: "v2w", version: process.env.npm_package_version || "0.1.3" }
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
