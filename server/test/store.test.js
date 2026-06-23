import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createStore } from "../src/store.js";

function withTempStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v2w-store-"));
  const sqliteFile = path.join(dir, "app.sqlite");
  const usersFile = path.join(dir, "users.json");
  const store = createStore({ sqliteFile, usersFile });
  return Promise.resolve()
    .then(() => fn({ store, sqliteFile }))
    .finally(() => {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

test("sensitive settings are encrypted at rest and decrypted on read", async () => {
  const previousKey = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = "test-encryption-key";
  try {
    await withTempStore(({ store, sqliteFile }) => {
      store.saveUserSettings("user_1", {
        provider: {
          active: "aliyun",
          cfg: {
            aliyun: { apiKey: "sk-secret", baseUrl: "", asr: "paraformer-v2", llm: "qwen-plus" }
          }
        },
        oss: { accessKeySecret: "oss-secret" }
      });
      store.saveNetdiskAccount("user_1", "quark", { cookies: "__pus=secret-cookie", account: "demo" });
      store.saveDeliveryTarget({
        id: "target_1",
        userId: "user_1",
        name: "知识库",
        enabled: true,
        method: "POST",
        url: "https://kb.example.com/import",
        headers: { Authorization: "Bearer delivery-token" },
        authType: "bearer",
        authSecret: "delivery-secret",
        payloadPreset: "standard"
      });

      const db = new Database(sqliteFile, { readonly: true });
      const settingsPayload = db.prepare("SELECT payload FROM user_settings WHERE user_id = ?").get("user_1").payload;
      const netdiskPayload = db.prepare("SELECT payload FROM netdisk_accounts WHERE user_id = ?").get("user_1").payload;
      const deliveryRow = db.prepare("SELECT headers_json, auth_secret FROM delivery_targets WHERE id = ?").get("target_1");
      db.close();

      assert.equal(settingsPayload.includes("sk-secret"), false);
      assert.equal(settingsPayload.includes("oss-secret"), false);
      assert.equal(netdiskPayload.includes("secret-cookie"), false);
      assert.equal(deliveryRow.headers_json.includes("delivery-token"), false);
      assert.equal(deliveryRow.auth_secret.includes("delivery-secret"), false);
      assert.equal(store.getUserSettings("user_1").provider.cfg.aliyun.apiKey, "sk-secret");
      assert.equal(store.getNetdiskAccount("user_1", "quark").cookies, "__pus=secret-cookie");
      assert.equal(store.getDeliveryTarget("user_1", "target_1").authSecret, "delivery-secret");
    });
  } finally {
    if (previousKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = previousKey;
  }
});

test("legacy plaintext settings remain readable after encryption is enabled", async () => {
  const previousKey = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = "test-encryption-key";
  try {
    await withTempStore(({ store, sqliteFile }) => {
      const db = new Database(sqliteFile);
      db.prepare(`
        INSERT INTO user_settings (user_id, payload, updated_at)
        VALUES (?, ?, ?)
      `).run("user_legacy", JSON.stringify({
        provider: {
          active: "aliyun",
          cfg: {
            aliyun: { apiKey: "legacy-sk", baseUrl: "", asr: "paraformer-v2", llm: "qwen-plus" }
          }
        }
      }), new Date().toISOString());
      db.close();
      assert.equal(store.getUserSettings("user_legacy").provider.cfg.aliyun.apiKey, "legacy-sk");
    });
  } finally {
    if (previousKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = previousKey;
  }
});

test("job events redact sensitive error text", async () => {
  await withTempStore(({ store }) => {
    store.saveJobEvent({
      jobId: "job_1",
      userId: "user_1",
      stage: "asr",
      status: "error",
      message: "提交转写失败",
      error: "Authorization: Bearer secret-token BDUSS=secret-bduss STOKEN=secret-stoken"
    });
    const [event] = store.listJobEvents("job_1");
    assert.match(event.error, /Bearer \*\*\*\*\*\*/);
    assert.match(event.error, /BDUSS=\*\*\*\*\*\*/);
    assert.match(event.error, /STOKEN=\*\*\*\*\*\*/);
    assert.equal(event.error.includes("secret-token"), false);
  });
});
