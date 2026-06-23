import crypto from "node:crypto";
import { APP_CONFIG } from "./config.js";

export function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

export function validateUsername(username) {
  return /^[a-zA-Z0-9_@\-.]{3,40}$/.test(username);
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, passwordHash) {
  const [salt, expected] = String(passwordHash || "").split(":");
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expectedBuffer = Buffer.from(expected, "hex");
  if (expectedBuffer.length !== actual.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, actual);
}

function authSecret() {
  const configured = String(process.env.SESSION_SECRET || "").trim();
  if (process.env.NODE_ENV === "production") {
    if (!configured || configured === "video-to-word-dev-secret-change-me" || configured.startsWith("change-me")) {
      throw new Error("生产环境必须设置安全的 SESSION_SECRET。");
    }
  }
  return configured || "video-to-word-dev-secret-change-me";
}

function base64Url(input) {
  return Buffer.from(JSON.stringify(input)).toString("base64url");
}

export function signToken(user) {
  const now = Date.now();
  const payload = {
    sub: user.id,
    username: user.username,
    sv: Number(user.sessionVersion || 0),
    iat: now,
    exp: now + APP_CONFIG.sessionTtlMs
  };
  const body = base64Url(payload);
  const sig = crypto.createHmac("sha256", authSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function readToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

export function verifyToken(token, users) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", authSecret()).update(body).digest("base64url");
  if (Buffer.byteLength(sig) !== Buffer.byteLength(expected)) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!payload.exp || payload.exp < Date.now()) return null;
  const user = users.find((item) => item.id === payload.sub) || null;
  if (!user) return null;
  if (Number(payload.sv || 0) !== Number(user.sessionVersion || 0)) return null;
  return user;
}

export function createLoginRateLimiter({
  maxAttempts = APP_CONFIG.loginRateLimitMax,
  windowMs = APP_CONFIG.loginRateLimitWindowMs
} = {}) {
  const failures = new Map();

  function prune(now = Date.now()) {
    for (const [key, item] of failures.entries()) {
      if (now - item.firstAt > windowMs) failures.delete(key);
    }
  }

  function keyFor(req, username) {
    return `${req.ip || req.socket?.remoteAddress || "unknown"}:${normalizeUsername(username) || "unknown"}`;
  }

  function assertAllowed(req, username) {
    prune();
    const item = failures.get(keyFor(req, username));
    if (item && item.count >= maxAttempts) {
      const waitMs = Math.max(0, windowMs - (Date.now() - item.firstAt));
      const error = new Error(`登录尝试过于频繁，请 ${Math.ceil(waitMs / 60000)} 分钟后再试。`);
      error.status = 429;
      throw error;
    }
  }

  function recordFailure(req, username) {
    const key = keyFor(req, username);
    const now = Date.now();
    const item = failures.get(key);
    if (!item || now - item.firstAt > windowMs) failures.set(key, { count: 1, firstAt: now });
    else failures.set(key, { count: item.count + 1, firstAt: item.firstAt });
  }

  function recordSuccess(req, username) {
    failures.delete(keyFor(req, username));
  }

  return { assertAllowed, recordFailure, recordSuccess };
}

export function createRequireAuth(getUsers) {
  return function requireAuth(req, res, next) {
    try {
      const user = verifyToken(readToken(req), getUsers());
      if (!user) return res.status(401).json({ error: "请先登录。" });
      req.user = user;
      next();
    } catch {
      res.status(401).json({ error: "登录状态无效，请重新登录。" });
    }
  };
}
