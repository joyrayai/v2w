import crypto from "node:crypto";

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
  return process.env.SESSION_SECRET || "video-to-word-dev-secret-change-me";
}

function base64Url(input) {
  return Buffer.from(JSON.stringify(input)).toString("base64url");
}

export function signToken(user) {
  const payload = {
    sub: user.id,
    username: user.username,
    iat: Date.now(),
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000
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
  return users.find((item) => item.id === payload.sub) || null;
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
