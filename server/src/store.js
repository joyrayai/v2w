import fs from "node:fs";
import Database from "better-sqlite3";

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
  `);

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
    const rows = db.prepare("SELECT id, username, password_hash, provider, created_at FROM users ORDER BY created_at").all();
    return rows.map((row) => ({
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      provider: row.provider,
      createdAt: row.created_at
    }));
  }

  function saveUser(user) {
    db.prepare(`
      INSERT INTO users (id, username, password_hash, provider, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        username = excluded.username,
        password_hash = excluded.password_hash,
        provider = excluded.provider
    `).run(user.id, user.username, user.passwordHash, user.provider || "password", user.createdAt);
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
      JSON.stringify(job)
    );
  }

  function deleteJob(jobId) {
    db.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
  }

  function loadJobs() {
    const rows = db.prepare("SELECT payload FROM jobs ORDER BY order_index, created_at").all();
    const jobs = [];
    for (const row of rows) {
      try {
        const job = JSON.parse(row.payload);
        if (!job?.id || !job?.userId) continue;
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
    `).run(userId, provider, JSON.stringify(payload), new Date().toISOString());
  }

  function getNetdiskAccount(userId, provider) {
    const row = db.prepare("SELECT payload FROM netdisk_accounts WHERE user_id = ? AND provider = ?").get(userId, provider);
    if (!row?.payload) return null;
    try {
      return JSON.parse(row.payload);
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
    `).run(userId, JSON.stringify(payload), new Date().toISOString());
  }

  function getUserSettings(userId) {
    const row = db.prepare("SELECT payload, updated_at FROM user_settings WHERE user_id = ?").get(userId);
    if (!row?.payload) return null;
    try {
      return { ...JSON.parse(row.payload), updatedAt: row.updated_at };
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
    close: () => db.close(),
    deleteJob,
    getNetdiskAccount,
    getUserSettings,
    deleteTemplate,
    listTemplates,
    loadJobs,
    loadUsers,
    saveNetdiskAccount,
    saveJob,
    saveTemplate,
    saveUsageRecord,
    saveUserSettings,
    saveUser,
    usageRecords,
    usageSummary
  };
}
