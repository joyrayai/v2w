import crypto from "node:crypto";

const ENC_PREFIX = "enc:v1:";
const DEFAULT_SESSION_SECRET = "video-to-word-dev-secret-change-me";

function isProduction() {
  return process.env.NODE_ENV === "production";
}

function configuredEncryptionKey() {
  const raw = String(process.env.APP_ENCRYPTION_KEY || "").trim();
  if (!raw) return null;
  return crypto.createHash("sha256").update(raw).digest();
}

export function assertSecurityConfig() {
  if (!isProduction()) return;
  const sessionSecret = String(process.env.SESSION_SECRET || "").trim();
  if (!sessionSecret || sessionSecret === DEFAULT_SESSION_SECRET || sessionSecret.startsWith("change-me")) {
    throw new Error("生产环境必须设置安全的 SESSION_SECRET。");
  }
  const encryptionKey = String(process.env.APP_ENCRYPTION_KEY || "").trim();
  if (!encryptionKey || encryptionKey.startsWith("change-me")) {
    throw new Error("生产环境必须设置 APP_ENCRYPTION_KEY，用于加密敏感配置。");
  }
}

export function isEncryptedSecret(value) {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}

export function encryptSecret(value) {
  const text = String(value ?? "");
  if (!text || isEncryptedSecret(text)) return text;
  const key = configuredEncryptionKey();
  if (!key) return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptSecret(value) {
  const text = String(value ?? "");
  if (!isEncryptedSecret(text)) return text;
  const key = configuredEncryptionKey();
  if (!key) throw new Error("数据已加密，但当前环境缺少 APP_ENCRYPTION_KEY。");
  const encoded = text.slice(ENC_PREFIX.length);
  const [ivText, tagText, encryptedText] = encoded.split(".");
  if (!ivText || !tagText || !encryptedText) throw new Error("敏感配置密文格式无效。");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

const SECRET_KEY_RE = /^(apiKey|accessKeySecret|authSecret|cookies|bduss|stoken|ptoken|password)$/i;

export function encryptSensitiveObject(value, { encryptAllStringValues = false } = {}) {
  if (Array.isArray(value)) return value.map((item) => encryptSensitiveObject(item, { encryptAllStringValues }));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (entry && typeof entry === "object") {
      return [key, encryptSensitiveObject(entry, { encryptAllStringValues })];
    }
    if (typeof entry === "string" && (encryptAllStringValues || SECRET_KEY_RE.test(key))) {
      return [key, encryptSecret(entry)];
    }
    return [key, entry];
  }));
}

export function decryptSensitiveObject(value, { decryptAllStringValues = false } = {}) {
  if (Array.isArray(value)) return value.map((item) => decryptSensitiveObject(item, { decryptAllStringValues }));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (entry && typeof entry === "object") {
      return [key, decryptSensitiveObject(entry, { decryptAllStringValues })];
    }
    if (typeof entry === "string" && (decryptAllStringValues || SECRET_KEY_RE.test(key) || isEncryptedSecret(entry))) {
      return [key, decryptSecret(entry)];
    }
    return [key, entry];
  }));
}

export function redactSensitiveText(text, secrets = []) {
  let output = String(text || "");
  for (const secret of secrets.filter(Boolean)) {
    const value = String(secret);
    if (value) output = output.replaceAll(value, "******");
  }
  output = output.replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1******");
  output = output.replace(/(api[-_ ]?key["']?\s*[:=]\s*["']?)[^"',;\s]+/gi, "$1******");
  output = output.replace(/(BDUSS=)[^;\s]+/gi, "$1******");
  output = output.replace(/(STOKEN=)[^;\s]+/gi, "$1******");
  output = output.replace(/(PTOKEN=)[^;\s]+/gi, "$1******");
  output = output.replace(/(--?password[=\s]+)[^\s]+/gi, "$1******");
  return output.trim();
}
