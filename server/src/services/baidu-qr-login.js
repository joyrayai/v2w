import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { nanoid } from "nanoid";
import { runCommand } from "../utils.js";

const SESSION_TTL_MS = 180 * 1000;
const POLL_INTERVAL_MS = 1500;
const CLOSED_SESSION_KEEP_MS = 30 * 1000;
const BAIDU_HOME = "https://pan.baidu.com/disk/main?from=homeFlow";
const LOGIN_URL = "https://passport.baidu.com/v2/?login&tpl=netdisk&u=https%3A%2F%2Fpan.baidu.com%2Fdisk%2Fmain%3Ffrom%3DhomeFlow";
const REQUIRED_COOKIE_NAMES = new Set(["BDUSS", "BDUSS_BFESS", "STOKEN", "BAIDUID", "BAIDUID_BFESS", "PANPSC", "csrfToken"]);
const PHASES = {
  starting: { step: 1, label: "生成二维码", progress: 12 },
  qr_ready: { step: 2, label: "等待扫码", progress: 30 },
  waiting_scan: { step: 2, label: "等待扫码", progress: 36 },
  waiting_confirm: { step: 3, label: "手机确认", progress: 58 },
  binding: { step: 4, label: "绑定账号", progress: 78 },
  verifying: { step: 4, label: "校验账号", progress: 86 },
  verified: { step: 5, label: "完成", progress: 100 },
  failed: { step: 0, label: "失败", progress: 100 },
  expired: { step: 0, label: "已过期", progress: 100 },
  cancelled: { step: 0, label: "已取消", progress: 100 }
};

function findChromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.CHROMIUM_PATH,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function cookieHeaderFromCookies(cookies = []) {
  return cookies
    .filter((cookie) => REQUIRED_COOKIE_NAMES.has(cookie.name))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function accountFromCookies(cookies = []) {
  const bduss = cookies.find((cookie) => cookie.name === "BDUSS")?.value || "";
  return bduss ? "百度网盘账号" : "";
}

export function createBaiduQrLoginManager({
  checkBaiduApiAccess,
  getNetdiskAccount,
  loginBaiduCookies
}) {
  const sessions = new Map();
  const activeByUser = new Map();

  function publicSession(session) {
    const phase = PHASES[session.status] || PHASES.starting;
    return {
      id: session.id,
      status: session.status,
      phase: phase.label,
      step: phase.step,
      totalSteps: 5,
      progress: phase.progress,
      message: session.message,
      expiresAt: session.expiresAt,
      account: session.account || "",
      lastError: session.lastError || "",
      verified: session.status === "verified"
    };
  }

  async function closeSession(session, status = session.status, message = session.message) {
    session.status = status;
    session.message = message || session.message;
    if (session.pollTimer) clearInterval(session.pollTimer);
    if (session.expireTimer) clearTimeout(session.expireTimer);
    session.pollTimer = null;
    session.expireTimer = null;
    try {
      await session.context?.close();
    } catch {
      // Ignore browser shutdown errors.
    }
    try {
      await session.browser?.close();
    } catch {
      // Ignore browser shutdown errors.
    }
    if (activeByUser.get(session.userId) === session.id) {
      activeByUser.delete(session.userId);
    }
    setTimeout(() => {
      if (!["starting", "qr_ready", "waiting_scan", "waiting_confirm", "binding", "verifying"].includes(session.status)) {
        sessions.delete(session.id);
      }
    }, CLOSED_SESSION_KEEP_MS).unref?.();
  }

  function assertActiveSession(session) {
    if (activeByUser.get(session.userId) !== session.id) {
      const error = new Error("扫码会话已失效，请重新生成二维码。");
      error.code = "STALE_QR_SESSION";
      throw error;
    }
  }

  async function detectQrAndScreenshot(session) {
    const page = session.page;
    const qrTabs = [
      "text=扫码登录",
      "text=二维码登录",
      ".tang-pass-footerBarQrcode",
      ".pass-login-tab-qrcode",
      "[data-type='qrcode']"
    ];
    for (const selector of qrTabs) {
      const target = page.locator(selector).first();
      if (await target.count().catch(() => 0)) {
        await target.click({ timeout: 1200 }).catch(() => {});
        await page.waitForTimeout(800);
        break;
      }
    }
    const selectors = [
      "img[src*='passport'][src*='qrcode']",
      "img[src*='passport'][src*='qr']",
      "img[src*='qrcode']",
      "img[src*='qrlogin']",
      ".tang-pass-qrcode-content canvas",
      ".tang-pass-qrcode-content img",
      ".tang-pass-qrcode-img",
      ".pass-qrcode-img",
      ".Qrcode-img",
      ".qrcode img",
      ".qrcode canvas"
    ];
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      for (const selector of selectors) {
        const locator = page.locator(selector).first();
        if (await locator.count().catch(() => 0)) {
          const box = await locator.boundingBox().catch(() => null);
          if (box && box.width >= 120 && box.height >= 120) {
            session.qrImage = await locator.screenshot({ type: "png" });
            session.status = "qr_ready";
            session.message = "请使用百度网盘 App 扫码登录。";
            return true;
          }
        }
      }
      await page.waitForTimeout(800);
    }
    const text = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
    throw new Error(text.includes("安全验证") ? "百度要求安全验证，暂时无法生成扫码二维码。" : "没有识别到百度登录二维码，请稍后重试。");
  }

  async function verifyCookies(session) {
    assertActiveSession(session);
    const cookies = await session.context.cookies(["https://pan.baidu.com", "https://baidu.com"]);
    const cookieHeader = cookieHeaderFromCookies(cookies);
    if (!/BDUSS=/.test(cookieHeader)) return false;
    session.status = "binding";
    session.message = "扫码已确认，正在绑定到当前账号。";
    let loginResult = "";
    try {
      loginResult = await loginBaiduCookies(session.userId, cookieHeader);
    } catch (err) {
      session.status = "failed";
      session.message = "扫码成功，但服务端绑定百度网盘失败。";
      session.lastError = err.message || "BaiduPCS-Go 登录失败";
      throw err;
    }
    assertActiveSession(session);
    session.status = "verifying";
    session.message = "正在校验百度网盘登录态。";
    const account = await getNetdiskAccount(session.userId, "baidu");
    if (!account?.loggedIn) {
      const apiStatus = await checkBaiduApiAccess(session.userId);
      session.status = "failed";
      session.message = apiStatus.message || "扫码成功，但百度网盘登录态校验失败。";
      session.lastError = loginResult || session.message;
      throw new Error(session.message);
    }
    session.cookieHeader = cookieHeader;
    session.account = account.account || accountFromCookies(cookies);
    session.status = "verified";
    session.message = session.account ? `已登录：${session.account}` : "百度网盘登录成功。";
    await closeSession(session, "verified", session.message);
    return true;
  }

  async function pollLogin(session) {
    if (!["qr_ready", "waiting_scan", "waiting_confirm"].includes(session.status)) return;
    try {
      const url = session.page.url();
      if (/pan\.baidu\.com\/disk\/main|pan\.baidu\.com\/disk\/home/.test(url)) {
        await verifyCookies(session);
        return;
      }
      const cookies = await session.context.cookies(["https://pan.baidu.com", "https://baidu.com"]);
      if (cookies.some((cookie) => cookie.name === "BDUSS")) {
        await session.page.goto(BAIDU_HOME, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await verifyCookies(session);
        return;
      }
      const text = await session.page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
      if (/确认|扫描成功|请在手机|扫码成功/.test(text)) {
        session.status = "waiting_confirm";
        session.message = "扫码成功，请在手机上确认登录。";
      } else {
        session.status = "waiting_scan";
        session.message = "等待扫码。";
      }
    } catch (err) {
      session.lastError = err.message || "扫码状态检查失败";
    }
  }

  async function start(userId) {
    const executablePath = findChromeExecutable();
    if (!executablePath) {
      const error = new Error("服务器未找到 Chrome/Chromium，暂不能使用扫码登录。");
      error.status = 503;
      throw error;
    }

    const existingId = activeByUser.get(userId);
    const existing = existingId ? sessions.get(existingId) : null;
    if (existing && ["binding", "verifying"].includes(existing.status)) {
      const error = new Error("已有扫码登录正在绑定账号，请稍后再试。");
      error.status = 409;
      throw error;
    }
    if (existing) {
      await closeSession(existing, "cancelled", "已生成新的二维码，旧会话已取消。");
    }

    const id = nanoid(14);
    const userDataDir = path.join(os.tmpdir(), `vtw-baidu-qr-${id}`);
    const session = {
      id,
      userId,
      status: "starting",
      message: "正在生成二维码。",
      expiresAt: Date.now() + SESSION_TTL_MS,
      userDataDir,
      qrImage: null,
      browser: null,
      context: null,
      page: null,
      pollTimer: null,
      expireTimer: null
    };
    sessions.set(id, session);
    activeByUser.set(userId, id);

    try {
      session.browser = await chromium.launch({
        executablePath,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
      });
      session.context = await session.browser.newContext({
        viewport: { width: 390, height: 620 },
        deviceScaleFactor: 3,
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
      });
      session.page = await session.context.newPage();
      await session.page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      await session.page.waitForTimeout(2500);
      await detectQrAndScreenshot(session);
      session.pollTimer = setInterval(() => pollLogin(session).catch(() => {}), POLL_INTERVAL_MS);
      session.expireTimer = setTimeout(() => closeSession(session, "expired", "二维码已过期，请重新扫码。"), SESSION_TTL_MS);
      return publicSession(session);
    } catch (err) {
      await closeSession(session, "failed", err.message || "二维码生成失败。");
      throw err;
    }
  }

  function get(sessionId, userId) {
    const session = sessions.get(sessionId);
    if (!session || session.userId !== userId) return null;
    return session;
  }

  return {
    start,
    status(sessionId, userId) {
      const session = get(sessionId, userId);
      return session ? publicSession(session) : null;
    },
    image(sessionId, userId) {
      const session = get(sessionId, userId);
      return session?.qrImage || null;
    },
    async cancel(sessionId, userId) {
      const session = get(sessionId, userId);
      if (!session) return false;
      await closeSession(session, "cancelled", "已取消扫码登录。");
      return true;
    },
    async closeAll() {
      await Promise.all([...sessions.values()].map((session) => closeSession(session).catch(() => {})));
    },
    executablePath: findChromeExecutable,
    runCommand
  };
}
