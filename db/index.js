// Data layer: @libsql/client. Uses Turso when TURSO_DATABASE_URL is set, otherwise a local file.
const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');

const DB_URL = process.env.TURSO_DATABASE_URL || process.env.DB_URL || 'file:' + path.join(__dirname, 'loans.db');
const IS_REMOTE = !DB_URL.startsWith('file:');

// Convert libsql rows to plain objects (and BigInt -> Number).
const plain = rs => rs.rows.map(r => { const o = {}; rs.columns.forEach((c, i) => { const v = r[i]; o[c] = typeof v === 'bigint' ? Number(v) : v; }); return o; });

function open() {
  const client = createClient({ url: DB_URL, authToken: process.env.TURSO_AUTH_TOKEN || undefined });
  const exec = (sql, args = []) => client.execute({ sql, args });
  return {
    client, url: DB_URL, remote: IS_REMOTE,
    all: async (sql, ...args) => plain(await exec(sql, args)),
    get: async (sql, ...args) => plain(await exec(sql, args))[0],
    run: async (sql, ...args) => { const r = await exec(sql, args); return { changes: r.rowsAffected, lastInsertRowid: r.lastInsertRowid == null ? null : Number(r.lastInsertRowid) }; },
    batch: stmts => client.batch(stmts.map(([sql, args = []]) => ({ sql, args })), 'write'),
    execMulti: sql => client.executeMultiple(sql),
    close: () => client.close(),
  };
}

async function migrate(db) {
  if (!db.remote) await db.run('PRAGMA foreign_keys = ON');
  await db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const dir = path.join(__dirname, 'migrations');
  const done = new Set((await db.all('SELECT name FROM schema_migrations')).map(r => r.name));
  const applied = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    // Split on ';' at line end; migrations contain no triggers/procedures.
    const stmts = fs.readFileSync(path.join(dir, f), 'utf8').split(/;\s*(?:--[^\n]*)?\n/).map(s => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
    await db.batch([...stmts.map(s => [s]), ['INSERT INTO schema_migrations(name) VALUES (?)', [f]]]);
    applied.push(f);
  }
  return applied;
}
module.exports = { open, migrate, DB_URL, IS_REMOTE };
