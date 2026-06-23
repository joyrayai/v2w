import fs from "node:fs";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import {
  decryptSecret,
  decryptSensitiveObject,
  encryptSecret,
  encryptSensitiveObject,
  redactSensitiveText
} from "./services/secrets.js";

export function createStore({ sqliteFile, usersFile }) {
  const db = new Database(sqliteFile);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'password',
      session_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      order_index INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_user_order ON jobs(user_id, order_index, created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE TABLE IF NOT EXISTS netdisk_accounts (
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, provider)
    );
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      job_id TEXT,
      job_title TEXT,
      type TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      metric_unit TEXT,
      metric_value REAL NOT NULL DEFAULT 0,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      estimated_cost REAL,
      currency TEXT NOT NULL DEFAULT 'CNY',
      meta_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_user_created ON usage_records(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_job ON usage_records(job_id);
    CREATE TABLE IF NOT EXISTS extra_doc_templates (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_extra_doc_templates_user_updated ON extra_doc_templates(user_id, updated_at);
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS review_rule_packs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      markdown TEXT NOT NULL,
      summary_json TEXT,
      active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_rule_packs_active ON review_rule_packs(active, updated_at);
    CREATE TABLE IF NOT EXISTS review_runs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      risk_level TEXT NOT NULL DEFAULT 'none',
      action TEXT NOT NULL DEFAULT 'pass',
      model TEXT,
      rule_pack_id TEXT,
      rule_pack_version TEXT,
      result_json TEXT,
      error TEXT,
      locked INTEGER NOT NULL DEFAULT 0,
      overridden INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_runs_job ON review_runs(job_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_review_runs_status ON review_runs(status, risk_level, locked);
    CREATE TABLE IF NOT EXISTS review_outputs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      label TEXT NOT NULL,
      url TEXT,
      text TEXT NOT NULL,
      order_index INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_outputs_job ON review_outputs(job_id, updated_at);
    CREATE TABLE IF NOT EXISTS review_overrides (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      review_run_id TEXT,
      admin_user_id TEXT NOT NULL,
      admin_username TEXT NOT NULL,
      reason TEXT NOT NULL,
      snapshot_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_overrides_job ON review_overrides(job_id, created_at);
    CREATE TABLE IF NOT EXISTS delivery_targets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      method TEXT NOT NULL DEFAULT 'POST',
      url TEXT NOT NULL,
      headers_json TEXT,
      auth_type TEXT NOT NULL DEFAULT 'none',
      auth_header_name TEXT,
      auth_secret TEXT,
      payload_preset TEXT NOT NULL DEFAULT 'standard',
      payload_template TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_delivery_targets_user ON delivery_targets(user_id, updated_at);
    CREATE TABLE IF NOT EXISTS delivery_runs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      status TEXT NOT NULL,
      http_status INTEGER,
      response_excerpt TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_delivery_runs_job ON delivery_runs(job_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_delivery_runs_user ON delivery_runs(user_id, updated_at);
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id, created_at);
    CREATE TABLE IF NOT EXISTS job_events (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      error_code TEXT,
      error TEXT,
      started_at TEXT,
      ended_at TEXT,
      duration_ms INTEGER,
      meta_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_job_events_stage_status ON job_events(stage, status, created_at);
  `);

  function migrateUserSessionVersion() {
    const columns = db.prepare("PRAGMA table_info(users)").all();
    const columnNames = new Set(columns.map((column) => column.name));
    if (!columnNames.has("session_version")) {
      db.exec("ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;");
    }
  }

  migrateUserSessionVersion();

  function migrateUsersJson() {
    try {
      if (!fs.existsSync(usersFile)) return;
      const parsed = JSON.parse(fs.readFileSync(usersFile, "utf8"));
      const legacyUsers = Array.isArray(parsed.users) ? parsed.users : [];
      if (!legacyUsers.length) return;
      const insert = db.prepare(`
        INSERT OR IGNORE INTO users (id, username, password_hash, provider, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const user of legacyUsers) {
        if (!user?.id || !user?.username || !user?.passwordHash) continue;
        insert.run(
          user.id,
          user.username,
          user.passwordHash,
          user.provider || "password",
          user.createdAt || new Date().toISOString()
        );
      }
    } catch {
      // Legacy migration is best-effort; SQLite remains the source of truth.
    }
  }

  function loadUsers() {
    migrateUsersJson();
    const rows = db.prepare("SELECT id, username, password_hash, provider, session_version, created_at FROM users ORDER BY created_at").all();
    return rows.map((row) => ({
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      provider: row.provider,
      sessionVersion: Number(row.session_version || 0),
      createdAt: row.created_at
    }));
  }

  function saveUser(user) {
    db.prepare(`
      INSERT INTO users (id, username, password_hash, provider, session_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        username = excluded.username,
        password_hash = excluded.password_hash,
        provider = excluded.provider,
        session_version = excluded.session_version
    `).run(
      user.id,
      user.username,
      user.passwordHash,
      user.provider || "password",
      Number(user.sessionVersion || 0),
      user.createdAt
    );
  }

  function bumpUserSessionVersion(userId) {
    db.prepare("UPDATE users SET session_version = session_version + 1 WHERE id = ?").run(userId);
    const row = db.prepare("SELECT session_version FROM users WHERE id = ?").get(userId);
    return Number(row?.session_version || 0);
  }

  function migrateReviewOutputsSchema() {
    const columns = db.prepare("PRAGMA table_info(review_outputs)").all();
    const columnNames = new Set(columns.map((column) => column.name));
    if (!columnNames.has("id")) {
      const tx = db.transaction(() => {
        db.exec(`
          ALTER TABLE review_outputs RENAME TO review_outputs_legacy;
          DROP INDEX IF EXISTS idx_review_outputs_job;
          DROP INDEX IF EXISTS idx_review_outputs_job_order;
          CREATE TABLE review_outputs (
            id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            label TEXT NOT NULL,
            url TEXT,
            text TEXT NOT NULL,
            order_index INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO review_outputs (id, job_id, user_id, label, url, text, order_index, created_at, updated_at)
          SELECT job_id || ':' || rowid, job_id, user_id, label, url, text, rowid - 1, created_at, updated_at
          FROM review_outputs_legacy;
          DROP TABLE review_outputs_legacy;
          CREATE INDEX IF NOT EXISTS idx_review_outputs_job ON review_outputs(job_id, updated_at);
          CREATE INDEX IF NOT EXISTS idx_review_outputs_job_order ON review_outputs(job_id, order_index, created_at);
        `);
      });
      tx();
      return;
    }
    if (!columnNames.has("order_index")) {
      db.exec(`
        ALTER TABLE review_outputs ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0;
      `);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_review_outputs_job ON review_outputs(job_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_review_outputs_job_order ON review_outputs(job_id, order_index, created_at);
    `);
  }

  migrateReviewOutputsSchema();

  function saveReviewOutput(output) {
    const now = new Date().toISOString();
    const jobId = String(output.jobId || "");
    const label = String(output.label || "文件");
    const orderIndex = Number.isFinite(Number(output.orderIndex)) ? Number(output.orderIndex) : 0;
    const id = String(output.id || `${jobId}:${label}:${orderIndex}`);
    db.prepare(`
      INSERT INTO review_outputs (id, job_id, user_id, label, url, text, order_index, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        job_id = excluded.job_id,
        user_id = excluded.user_id,
        label = excluded.label,
        url = excluded.url,
        text = excluded.text,
        order_index = excluded.order_index,
        updated_at = excluded.updated_at
    `).run(
      id,
      jobId,
      output.userId,
      label,
      output.url || null,
      String(output.text || ""),
      orderIndex,
      output.createdAt || now,
      output.updatedAt || now
    );
  }

  function listReviewOutputs(jobId) {
    const rows = db.prepare(`
      SELECT id, job_id, user_id, label, url, text, order_index, created_at, updated_at
      FROM review_outputs
      WHERE job_id = ?
      ORDER BY order_index, created_at, rowid
    `).all(jobId);
    return rows.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      userId: row.user_id,
      label: row.label,
      url: row.url || "",
      text: row.text || "",
      orderIndex: row.order_index,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  function updateReviewOutputUrl(jobId, id, url) {
    db.prepare(`
      UPDATE review_outputs
      SET url = ?, updated_at = ?
      WHERE job_id = ? AND id = ?
    `).run(url || null, new Date().toISOString(), jobId, id);
  }

  function deleteReviewOutputs(jobId) {
    db.prepare("DELETE FROM review_outputs WHERE job_id = ?").run(jobId);
  }

  function parseJsonSafe(value, fallback) {
    if (!value) return fallback;
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  function parseSensitiveJson(value, fallback, options = {}) {
    return decryptSensitiveObject(parseJsonSafe(value, fallback), options);
  }

  function stringifySensitiveJson(value, options = {}) {
    return JSON.stringify(encryptSensitiveObject(value || {}, options));
  }

  function rowToDeliveryTarget(row) {
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      enabled: Boolean(row.enabled),
      method: row.method,
      url: row.url,
      headers: parseSensitiveJson(row.headers_json, {}, { decryptAllStringValues: true }),
      authType: row.auth_type,
      authHeaderName: row.auth_header_name || "",
      authSecret: row.auth_secret ? decryptSecret(row.auth_secret) : "",
      payloadPreset: row.payload_preset,
      payloadTemplate: row.payload_template || "",
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function rowToDeliveryRun(row) {
    if (!row) return null;
    return {
      id: row.id,
      jobId: row.job_id,
      userId: row.user_id,
      targetId: row.target_id,
      status: row.status,
      httpStatus: row.http_status,
      responseExcerpt: row.response_excerpt || "",
      error: row.error || "",
      attempts: row.attempts || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function listDeliveryTargets(userId) {
    return db.prepare("SELECT * FROM delivery_targets WHERE user_id = ? ORDER BY updated_at DESC").all(userId).map(rowToDeliveryTarget);
  }

  function getDeliveryTarget(userId, id) {
    return rowToDeliveryTarget(db.prepare("SELECT * FROM delivery_targets WHERE user_id = ? AND id = ?").get(userId, id));
  }

  function saveDeliveryTarget(target) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO delivery_targets (
        id, user_id, name, enabled, method, url, headers_json, auth_type, auth_header_name,
        auth_secret, payload_preset, payload_template, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        user_id = excluded.user_id,
        name = excluded.name,
        enabled = excluded.enabled,
        method = excluded.method,
        url = excluded.url,
        headers_json = excluded.headers_json,
        auth_type = excluded.auth_type,
        auth_header_name = excluded.auth_header_name,
        auth_secret = excluded.auth_secret,
        payload_preset = excluded.payload_preset,
        payload_template = excluded.payload_template,
        updated_at = excluded.updated_at
    `).run(
      target.id,
      target.userId,
      target.name,
      target.enabled ? 1 : 0,
      target.method || "POST",
      target.url || "",
      stringifySensitiveJson(target.headers || {}, { encryptAllStringValues: true }),
      target.authType || "none",
      target.authHeaderName || null,
      target.authSecret ? encryptSecret(target.authSecret) : null,
      target.payloadPreset || "standard",
      target.payloadTemplate || null,
      target.createdAt || now,
      target.updatedAt || now
    );
    return getDeliveryTarget(target.userId, target.id);
  }

  function deleteDeliveryTarget(userId, id) {
    db.prepare("DELETE FROM delivery_targets WHERE user_id = ? AND id = ?").run(userId, id);
  }

  function saveDeliveryRun(run) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO delivery_runs (
        id, job_id, user_id, target_id, status, http_status, response_excerpt,
        error, attempts, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        http_status = excluded.http_status,
        response_excerpt = excluded.response_excerpt,
        error = excluded.error,
        attempts = excluded.attempts,
        updated_at = excluded.updated_at
    `).run(
      run.id,
      run.jobId,
      run.userId,
      run.targetId,
      run.status,
      run.httpStatus || null,
      run.responseExcerpt || null,
      run.error || null,
      Number(run.attempts) || 0,
      run.createdAt || now,
      run.updatedAt || now
    );
    return getDeliveryRun(run.id);
  }

  function getDeliveryRun(id) {
    return rowToDeliveryRun(db.prepare("SELECT * FROM delivery_runs WHERE id = ?").get(id));
  }

  function listDeliveryRunsForJob(jobId) {
    return db.prepare("SELECT * FROM delivery_runs WHERE job_id = ? ORDER BY updated_at DESC").all(jobId).map(rowToDeliveryRun);
  }

  function getLatestDeliveryRunForJob(jobId) {
    return rowToDeliveryRun(db.prepare("SELECT * FROM delivery_runs WHERE job_id = ? ORDER BY updated_at DESC LIMIT 1").get(jobId));
  }

  function jobPayloadForStorage(job) {
    const { reviewOutputs, ...payload } = job || {};
    return payload;
  }

  function saveJob(job) {
    db.prepare(`
      INSERT INTO jobs (id, user_id, status, order_index, created_at, updated_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        user_id = excluded.user_id,
        status = excluded.status,
        order_index = excluded.order_index,
        updated_at = excluded.updated_at,
        payload = excluded.payload
    `).run(
      job.id,
      job.userId,
      job.status,
      Number(job.order) || 0,
      job.createdAt || new Date().toISOString(),
      job.updatedAt || new Date().toISOString(),
      JSON.stringify(jobPayloadForStorage(job))
    );
  }

  function deleteJob(jobId) {
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM delivery_runs WHERE job_id = ?").run(jobId);
      db.prepare("DELETE FROM review_outputs WHERE job_id = ?").run(jobId);
      db.prepare("DELETE FROM job_events WHERE job_id = ?").run(jobId);
      db.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
    });
    tx();
  }

  function loadJobs() {
    const rows = db.prepare("SELECT payload FROM jobs ORDER BY order_index, created_at").all();
    const jobs = [];
    for (const row of rows) {
      try {
        const job = JSON.parse(row.payload);
        if (!job?.id || !job?.userId) continue;
        if (Array.isArray(job.reviewOutputs) && job.reviewOutputs.length) {
          for (const [index, output] of job.reviewOutputs.entries()) {
            saveReviewOutput({
              id: output.id || output.reviewOutputId || `${job.id}:legacy:${index}`,
              jobId: job.id,
              userId: job.userId,
              label: output.label,
              url: output.url,
              text: output.text,
              orderIndex: index,
              createdAt: job.createdAt,
              updatedAt: job.updatedAt
            });
          }
          delete job.reviewOutputs;
          saveJob(job);
        }
        if (job.status === "running") {
          job.status = "error";
          job.step = "服务重启后暂停";
          job.error = job.error || "服务重启时任务仍在运行，请删除后重新提交。";
          job.progress = job.progress || 0;
          job.updatedAt = new Date().toISOString();
          saveJob(job);
        }
        jobs.push(job);
      } catch {
        // Ignore corrupted historical rows; they can be cleaned manually if needed.
      }
    }
    return jobs;
  }

  function saveNetdiskAccount(userId, provider, payload) {
    db.prepare(`
      INSERT INTO netdisk_accounts (user_id, provider, payload, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, provider) DO UPDATE SET
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `).run(userId, provider, stringifySensitiveJson(payload), new Date().toISOString());
  }

  function getNetdiskAccount(userId, provider) {
    const row = db.prepare("SELECT payload FROM netdisk_accounts WHERE user_id = ? AND provider = ?").get(userId, provider);
    if (!row?.payload) return null;
    try {
      return parseSensitiveJson(row.payload, null);
    } catch {
      return null;
    }
  }

  function saveUserSettings(userId, payload) {
    db.prepare(`
      INSERT INTO user_settings (user_id, payload, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `).run(userId, stringifySensitiveJson(payload), new Date().toISOString());
  }

  function getUserSettings(userId) {
    const row = db.prepare("SELECT payload, updated_at FROM user_settings WHERE user_id = ?").get(userId);
    if (!row?.payload) return null;
    try {
      return { ...parseSensitiveJson(row.payload, {}), updatedAt: row.updated_at };
    } catch {
      return null;
    }
  }

  function saveAppSetting(key, payload) {
    db.prepare(`
      INSERT INTO app_settings (key, payload, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `).run(key, stringifySensitiveJson(payload || {}), new Date().toISOString());
  }

  function getAppSetting(key) {
    const row = db.prepare("SELECT payload, updated_at FROM app_settings WHERE key = ?").get(key);
    if (!row?.payload) return null;
    try {
      return { ...parseSensitiveJson(row.payload, {}), updatedAt: row.updated_at };
    } catch {
      return null;
    }
  }

  function saveUsageRecord(record) {
    db.prepare(`
      INSERT INTO usage_records (
        id, user_id, job_id, job_title, type, provider, model, metric_unit, metric_value,
        input_tokens, output_tokens, total_tokens, estimated_cost, currency, meta_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.userId,
      record.jobId || null,
      record.jobTitle || null,
      record.type,
      record.provider || null,
      record.model || null,
      record.metricUnit || null,
      Number(record.metricValue || 0),
      record.inputTokens ?? null,
      record.outputTokens ?? null,
      record.totalTokens ?? null,
      record.estimatedCost ?? null,
      record.currency || "CNY",
      record.meta ? JSON.stringify(record.meta) : null,
      record.createdAt || new Date().toISOString()
    );
  }

  function saveAuthSession(session) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO auth_sessions (id, user_id, session_version, expires_at, revoked_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        revoked_at = excluded.revoked_at
    `).run(
      session.id || crypto.randomUUID(),
      session.userId,
      Number(session.sessionVersion || 0),
      session.expiresAt,
      session.revokedAt || null,
      session.createdAt || now
    );
  }

  function saveJobEvent(event) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO job_events (
        id, job_id, user_id, stage, status, message, error_code, error,
        started_at, ended_at, duration_ms, meta_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id || crypto.randomUUID(),
      event.jobId,
      event.userId,
      event.stage,
      event.status,
      event.message || null,
      event.errorCode || null,
      event.error ? redactSensitiveText(event.error) : null,
      event.startedAt || null,
      event.endedAt || null,
      Number.isFinite(Number(event.durationMs)) ? Number(event.durationMs) : null,
      event.meta ? JSON.stringify(encryptSensitiveObject(event.meta)) : null,
      event.createdAt || now
    );
  }

  function listJobEvents(jobId) {
    const rows = db.prepare(`
      SELECT *
      FROM job_events
      WHERE job_id = ?
      ORDER BY created_at ASC
    `).all(jobId);
    return rows.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      userId: row.user_id,
      stage: row.stage,
      status: row.status,
      message: row.message || "",
      errorCode: row.error_code || "",
      error: row.error || "",
      startedAt: row.started_at || "",
      endedAt: row.ended_at || "",
      durationMs: row.duration_ms,
      meta: row.meta_json ? decryptSensitiveObject(JSON.parse(row.meta_json)) : null,
      createdAt: row.created_at
    }));
  }

  function adminDiagnosticsSummary({ start, end } = {}) {
    const rows = db.prepare(`
      SELECT stage, status, COUNT(*) AS records, AVG(duration_ms) AS avg_duration_ms
      FROM job_events
      WHERE created_at >= ?
        AND created_at < ?
      GROUP BY stage, status
      ORDER BY records DESC
    `).all(start, end);
    const recentFailures = db.prepare(`
      SELECT e.*, j.payload
      FROM job_events e
      LEFT JOIN jobs j ON j.id = e.job_id
      WHERE e.created_at >= ?
        AND e.created_at < ?
        AND e.status = 'error'
      ORDER BY e.created_at DESC
      LIMIT 30
    `).all(start, end);
    return {
      byStage: rows.map((row) => ({
        stage: row.stage,
        status: row.status,
        records: Number(row.records || 0),
        avgDurationMs: Number(row.avg_duration_ms || 0)
      })),
      recentFailures: recentFailures.map((row) => {
        const job = parseJsonSafe(row.payload, {});
        return {
          jobId: row.job_id,
          jobTitle: job.title || "",
          userId: row.user_id,
          stage: row.stage,
          message: row.message || "",
          error: row.error || "",
          createdAt: row.created_at
        };
      })
    };
  }

  function listTemplates(userId) {
    const rows = db.prepare(`
      SELECT id, user_id, title, prompt, created_at, updated_at
      FROM extra_doc_templates
      WHERE user_id = ?
      ORDER BY updated_at DESC, created_at DESC
    `).all(userId);
    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      title: row.title,
      prompt: row.prompt,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  function saveTemplate(template) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO extra_doc_templates (id, user_id, title, prompt, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        prompt = excluded.prompt,
        updated_at = excluded.updated_at
    `).run(
      template.id,
      template.userId,
      template.title,
      template.prompt,
      template.createdAt || now,
      template.updatedAt || now
    );
  }

  function deleteTemplate(userId, templateId) {
    return db.prepare("DELETE FROM extra_doc_templates WHERE user_id = ? AND id = ?").run(userId, templateId).changes;
  }

  function rowToRulePack(row) {
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      markdown: row.markdown,
      summary: row.summary_json ? JSON.parse(row.summary_json) : null,
      active: Boolean(row.active),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function listReviewRulePacks() {
    return db.prepare(`
      SELECT * FROM review_rule_packs
      ORDER BY active DESC, updated_at DESC, created_at DESC
    `).all().map(rowToRulePack);
  }

  function getActiveReviewRulePack() {
    const row = db.prepare(`
      SELECT * FROM review_rule_packs
      WHERE active = 1
      ORDER BY updated_at DESC
      LIMIT 1
    `).get();
    return row ? rowToRulePack(row) : null;
  }

  function saveReviewRulePack(rulePack) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO review_rule_packs (id, name, version, markdown, summary_json, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        version = excluded.version,
        markdown = excluded.markdown,
        summary_json = excluded.summary_json,
        updated_at = excluded.updated_at
    `).run(
      rulePack.id,
      rulePack.name,
      rulePack.version,
      rulePack.markdown,
      rulePack.summary ? JSON.stringify(rulePack.summary) : null,
      rulePack.active ? 1 : 0,
      rulePack.createdAt || now,
      rulePack.updatedAt || now
    );
  }

  function activateReviewRulePack(rulePackId) {
    const tx = db.transaction(() => {
      db.prepare("UPDATE review_rule_packs SET active = 0, updated_at = ?").run(new Date().toISOString());
      return db.prepare("UPDATE review_rule_packs SET active = 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), rulePackId).changes;
    });
    return tx();
  }

  function rowToReviewRun(row) {
    return {
      id: row.id,
      jobId: row.job_id,
      userId: row.user_id,
      status: row.status,
      riskLevel: row.risk_level,
      action: row.action,
      model: row.model,
      rulePackId: row.rule_pack_id,
      rulePackVersion: row.rule_pack_version,
      result: row.result_json ? JSON.parse(row.result_json) : null,
      error: row.error || "",
      locked: Boolean(row.locked),
      overridden: Boolean(row.overridden),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function saveReviewRun(run) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO review_runs (
        id, job_id, user_id, status, risk_level, action, model, rule_pack_id,
        rule_pack_version, result_json, error, locked, overridden, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        risk_level = excluded.risk_level,
        action = excluded.action,
        model = excluded.model,
        rule_pack_id = excluded.rule_pack_id,
        rule_pack_version = excluded.rule_pack_version,
        result_json = excluded.result_json,
        error = excluded.error,
        locked = excluded.locked,
        overridden = excluded.overridden,
        updated_at = excluded.updated_at
    `).run(
      run.id,
      run.jobId,
      run.userId,
      run.status,
      run.riskLevel || "none",
      run.action || "pass",
      run.model || null,
      run.rulePackId || null,
      run.rulePackVersion || null,
      run.result ? JSON.stringify(run.result) : null,
      run.error || null,
      run.locked ? 1 : 0,
      run.overridden ? 1 : 0,
      run.createdAt || now,
      run.updatedAt || now
    );
  }

  function getLatestReviewRunForJob(jobId) {
    const row = db.prepare(`
      SELECT * FROM review_runs
      WHERE job_id = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `).get(jobId);
    return row ? rowToReviewRun(row) : null;
  }

  function listReviewRuns({ status = "", locked = null, limit = 100, offset = 0 } = {}) {
    const clauses = [];
    const params = [];
    if (status) {
      clauses.push("r.status = ?");
      params.push(status);
    }
    if (locked != null) {
      clauses.push("r.locked = ?");
      params.push(locked ? 1 : 0);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT r.*, u.username
      FROM review_runs r
      LEFT JOIN users u ON u.id = r.user_id
      ${where}
      ORDER BY r.updated_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    return rows.map((row) => ({ ...rowToReviewRun(row), username: row.username || "" }));
  }

  function saveReviewOverride(override) {
    db.prepare(`
      INSERT INTO review_overrides (
        id, job_id, review_run_id, admin_user_id, admin_username, reason, snapshot_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      override.id,
      override.jobId,
      override.reviewRunId || null,
      override.adminUserId,
      override.adminUsername,
      override.reason,
      override.snapshot ? JSON.stringify(override.snapshot) : null,
      override.createdAt || new Date().toISOString()
    );
  }

  function usageRecords(userId, { start, end, limit = 100, offset = 0 } = {}) {
    const rows = db.prepare(`
      SELECT * FROM usage_records
      WHERE user_id = ?
        AND created_at >= ?
        AND created_at < ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(userId, start, end, limit, offset);
    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      jobId: row.job_id,
      jobTitle: row.job_title,
      type: row.type,
      provider: row.provider,
      model: row.model,
      metricUnit: row.metric_unit,
      metricValue: row.metric_value,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.total_tokens,
      estimatedCost: row.estimated_cost,
      currency: row.currency,
      meta: row.meta_json ? JSON.parse(row.meta_json) : null,
      createdAt: row.created_at
    }));
  }

  function usageSummary(userId, { start, end } = {}) {
    const totals = db.prepare(`
      SELECT
        COUNT(*) AS records,
        SUM(CASE WHEN type = 'asr' THEN metric_value ELSE 0 END) AS asr_seconds,
        SUM(CASE WHEN type = 'llm' THEN COALESCE(total_tokens, 0) ELSE 0 END) AS llm_tokens,
        SUM(CASE WHEN type = 'llm' THEN COALESCE(input_tokens, 0) ELSE 0 END) AS input_tokens,
        SUM(CASE WHEN type = 'llm' THEN COALESCE(output_tokens, 0) ELSE 0 END) AS output_tokens,
        SUM(CASE WHEN type = 'asr' AND estimated_cost IS NOT NULL THEN estimated_cost ELSE 0 END) AS asr_cost,
        SUM(CASE WHEN type = 'llm' AND estimated_cost IS NOT NULL THEN estimated_cost ELSE 0 END) AS llm_cost,
        SUM(CASE WHEN estimated_cost IS NOT NULL THEN estimated_cost ELSE 0 END) AS estimated_cost
      FROM usage_records
      WHERE user_id = ?
        AND created_at >= ?
        AND created_at < ?
    `).get(userId, start, end);

    const byModel = db.prepare(`
      SELECT type, provider, model, metric_unit, COUNT(*) AS records,
        SUM(metric_value) AS metric_value,
        SUM(COALESCE(total_tokens, 0)) AS total_tokens,
        SUM(CASE WHEN estimated_cost IS NOT NULL THEN estimated_cost ELSE 0 END) AS estimated_cost
      FROM usage_records
      WHERE user_id = ?
        AND created_at >= ?
        AND created_at < ?
      GROUP BY type, provider, model, metric_unit
      ORDER BY type, metric_value DESC, total_tokens DESC
    `).all(userId, start, end);

    return {
      records: Number(totals?.records || 0),
      asrSeconds: Number(totals?.asr_seconds || 0),
      llmTokens: Number(totals?.llm_tokens || 0),
      inputTokens: Number(totals?.input_tokens || 0),
      outputTokens: Number(totals?.output_tokens || 0),
      asrCost: Number(totals?.asr_cost || 0),
      llmCost: Number(totals?.llm_cost || 0),
      estimatedCost: Number(totals?.estimated_cost || 0),
      byModel: byModel.map((row) => ({
        type: row.type,
        provider: row.provider,
        model: row.model,
        metricUnit: row.metric_unit,
        records: Number(row.records || 0),
        metricValue: Number(row.metric_value || 0),
        totalTokens: Number(row.total_tokens || 0),
        estimatedCost: Number(row.estimated_cost || 0)
      }))
    };
  }

  function adminUsageSummary({ start, end } = {}) {
    const totals = db.prepare(`
      SELECT
        COUNT(*) AS records,
        SUM(CASE WHEN type = 'asr' THEN metric_value ELSE 0 END) AS asr_seconds,
        SUM(CASE WHEN type = 'llm' THEN COALESCE(total_tokens, 0) ELSE 0 END) AS llm_tokens,
        SUM(CASE WHEN type = 'llm' THEN COALESCE(input_tokens, 0) ELSE 0 END) AS input_tokens,
        SUM(CASE WHEN type = 'llm' THEN COALESCE(output_tokens, 0) ELSE 0 END) AS output_tokens,
        SUM(CASE WHEN type = 'asr' AND estimated_cost IS NOT NULL THEN estimated_cost ELSE 0 END) AS asr_cost,
        SUM(CASE WHEN type = 'llm' AND estimated_cost IS NOT NULL THEN estimated_cost ELSE 0 END) AS llm_cost,
        SUM(CASE WHEN estimated_cost IS NOT NULL THEN estimated_cost ELSE 0 END) AS estimated_cost
      FROM usage_records
      WHERE created_at >= ?
        AND created_at < ?
    `).get(start, end);

    const byModel = db.prepare(`
      SELECT type, provider, model, metric_unit, COUNT(*) AS records,
        SUM(metric_value) AS metric_value,
        SUM(COALESCE(total_tokens, 0)) AS total_tokens,
        SUM(CASE WHEN estimated_cost IS NOT NULL THEN estimated_cost ELSE 0 END) AS estimated_cost
      FROM usage_records
      WHERE created_at >= ?
        AND created_at < ?
      GROUP BY type, provider, model, metric_unit
      ORDER BY type, metric_value DESC, total_tokens DESC
    `).all(start, end);

    const byUser = db.prepare(`
      SELECT u.id, u.username, u.provider, u.created_at,
        COUNT(r.id) AS records,
        SUM(CASE WHEN r.type = 'asr' THEN r.metric_value ELSE 0 END) AS asr_seconds,
        SUM(CASE WHEN r.type = 'llm' THEN COALESCE(r.total_tokens, 0) ELSE 0 END) AS llm_tokens,
        SUM(CASE WHEN r.type = 'asr' AND r.estimated_cost IS NOT NULL THEN r.estimated_cost ELSE 0 END) AS asr_cost,
        SUM(CASE WHEN r.type = 'llm' AND r.estimated_cost IS NOT NULL THEN r.estimated_cost ELSE 0 END) AS llm_cost,
        SUM(CASE WHEN r.estimated_cost IS NOT NULL THEN r.estimated_cost ELSE 0 END) AS estimated_cost
      FROM users u
      LEFT JOIN usage_records r ON r.user_id = u.id
        AND r.created_at >= ?
        AND r.created_at < ?
      GROUP BY u.id
      ORDER BY estimated_cost DESC, records DESC, u.created_at DESC
    `).all(start, end);

    return {
      records: Number(totals?.records || 0),
      asrSeconds: Number(totals?.asr_seconds || 0),
      llmTokens: Number(totals?.llm_tokens || 0),
      inputTokens: Number(totals?.input_tokens || 0),
      outputTokens: Number(totals?.output_tokens || 0),
      asrCost: Number(totals?.asr_cost || 0),
      llmCost: Number(totals?.llm_cost || 0),
      estimatedCost: Number(totals?.estimated_cost || 0),
      byModel: byModel.map((row) => ({
        type: row.type,
        provider: row.provider,
        model: row.model,
        metricUnit: row.metric_unit,
        records: Number(row.records || 0),
        metricValue: Number(row.metric_value || 0),
        totalTokens: Number(row.total_tokens || 0),
        estimatedCost: Number(row.estimated_cost || 0)
      })),
      byUser: byUser.map((row) => ({
        id: row.id,
        username: row.username,
        provider: row.provider,
        createdAt: row.created_at,
        records: Number(row.records || 0),
        asrSeconds: Number(row.asr_seconds || 0),
        llmTokens: Number(row.llm_tokens || 0),
        asrCost: Number(row.asr_cost || 0),
        llmCost: Number(row.llm_cost || 0),
        estimatedCost: Number(row.estimated_cost || 0)
      }))
    };
  }

  function adminUsageRecords({ start, end, limit = 100, offset = 0 } = {}) {
    const rows = db.prepare(`
      SELECT r.*, u.username
      FROM usage_records r
      LEFT JOIN users u ON u.id = r.user_id
      WHERE r.created_at >= ?
        AND r.created_at < ?
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `).all(start, end, limit, offset);
    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      username: row.username || "",
      jobId: row.job_id,
      jobTitle: row.job_title,
      type: row.type,
      provider: row.provider,
      model: row.model,
      metricUnit: row.metric_unit,
      metricValue: row.metric_value,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.total_tokens,
      estimatedCost: row.estimated_cost,
      currency: row.currency,
      meta: row.meta_json ? JSON.parse(row.meta_json) : null,
      createdAt: row.created_at
    }));
  }

  return {
    adminUsageRecords,
    adminUsageSummary,
    adminDiagnosticsSummary,
    activateReviewRulePack,
    bumpUserSessionVersion,
    close: () => db.close(),
    deleteDeliveryTarget,
    deleteJob,
    deleteReviewOutputs,
    getDeliveryTarget,
    getLatestDeliveryRunForJob,
    getNetdiskAccount,
    getActiveReviewRulePack,
    getAppSetting,
    getLatestReviewRunForJob,
    getUserSettings,
    deleteTemplate,
    listJobEvents,
    listDeliveryRunsForJob,
    listDeliveryTargets,
    listTemplates,
    listReviewOutputs,
    listReviewRulePacks,
    listReviewRuns,
    loadJobs,
    loadUsers,
    saveAppSetting,
    saveAuthSession,
    saveDeliveryRun,
    saveDeliveryTarget,
    saveNetdiskAccount,
    saveJob,
    saveJobEvent,
    saveReviewOutput,
    saveReviewOverride,
    saveReviewRulePack,
    saveReviewRun,
    saveTemplate,
    saveUsageRecord,
    saveUserSettings,
    saveUser,
    usageRecords,
    usageSummary,
    updateReviewOutputUrl
  };
}
