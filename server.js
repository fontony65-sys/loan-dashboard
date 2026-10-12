// Load .env for local use if present (Node >= 20.12). Real env vars (e.g. on Render) take precedence.
try { if (require('fs').existsSync(__dirname + '/.env')) process.loadEnvFile(__dirname + '/.env'); } catch (e) { console.warn('Could not load .env:', e.message); }
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { open, migrate, DB_URL, IS_REMOTE } = require('./db');
const { seed } = require('./db/seed');
const { enrich, schedule } = require('./lib');

const PROD = process.env.NODE_ENV === 'production';
const PORT = +process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
if (PROD && !process.env.ADMIN_PASSWORD) {
  console.error('FATAL: ADMIN_PASSWORD must be set when NODE_ENV=production. Refusing to start.');
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DEFAULT_CURRENCY = process.env.CURRENCY || 'XAF';
const SEED = process.env.SEED_EXAMPLE_DATA ? process.env.SEED_EXAMPLE_DATA === 'true' : !PROD;

const db = open();
const app = express();
app.set('trust proxy', 1);
app.use(express.json());

// ---------- auth (single admin, sessions stored in DB) ----------
const TTL = 12 * 3600 * 1000;
function tokenFrom(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)session=([a-f0-9]+)/);
  return m && m[1];
}
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
const hashTok = t => crypto.createHash('sha256').update(String(t)).digest('hex'); // only hashes are stored
const cookieFlags = `HttpOnly; SameSite=Lax; Path=/${PROD ? '; Secure' : ''}`;

// Basic login rate limit: 10 failed attempts per IP per 15 minutes.
const LIMIT = +process.env.LOGIN_MAX_ATTEMPTS || 10, WINDOW = 15 * 60 * 1000, attempts = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k); }, 60000).unref();

app.post('/api/login', async (req, res, next) => {
  try {
    const ip = req.ip, now = Date.now();
    let a = attempts.get(ip); if (!a || a.reset < now) { a = { n: 0, reset: now + WINDOW }; attempts.set(ip, a); }
    if (a.n >= LIMIT) { res.setHeader('Retry-After', Math.ceil((a.reset - now) / 1000)); return res.status(429).json({ error: 'Too many login attempts. Try again later.' }); }
    const { username, password } = req.body || {};
    if (!safeEq(username, ADMIN_USER) || !safeEq(password, ADMIN_PASSWORD)) { a.n++; return res.status(401).json({ error: 'Invalid credentials' }); }
    attempts.delete(ip);
    const token = crypto.randomBytes(24).toString('hex');
    await db.run('INSERT INTO sessions(token,username,expires_at) VALUES(?,?,?)', hashTok(token), ADMIN_USER, now + TTL);
    await db.run('DELETE FROM sessions WHERE expires_at < ?', now);
    res.setHeader('Set-Cookie', `session=${token}; ${cookieFlags}; Max-Age=${TTL / 1000}`);
    res.json({ token, username: ADMIN_USER });
  } catch (e) { next(e); }
});
app.post('/api/logout', async (req, res, next) => {
  try { const t = tokenFrom(req); if (t) await db.run('DELETE FROM sessions WHERE token=?', hashTok(t));
    res.setHeader('Set-Cookie', `session=; ${cookieFlags}; Max-Age=0`); res.json({ ok: true }); } catch (e) { next(e); }
});
app.get('/api/health', (req, res) => res.json({ ok: true, db: IS_REMOTE ? 'turso' : 'local-file' }));
app.use('/api', async (req, res, next) => {
  try {
    const t = tokenFrom(req);
    const s = t && await db.get('SELECT expires_at FROM sessions WHERE token=?', hashTok(t));
    if (!s || s.expires_at < Date.now()) return res.status(401).json({ error: 'Unauthorized' });
    next();
  } catch (e) { next(e); }
});
app.get('/api/me', (req, res) => res.json({ username: ADMIN_USER }));

// ---------- helpers ----------
const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(/constraint|CHECK|UNIQUE|FOREIGN/i.test(e.message) ? 400 : 500).json({ error: e.message }); } };
function pick(body, fields) { const o = {}; for (const f of fields) if (body[f] !== undefined) o[f] = body[f] === '' ? null : body[f]; return o; }
function require_(o, fields) { const miss = fields.filter(f => o[f] === undefined || o[f] === null || o[f] === ''); if (miss.length) { const e = new Error('Missing required field(s): ' + miss.join(', ')); e.status = 400; throw e; } }
function crud(name, table, fields, required, getOne, beforeDelete) {
  app.post(`/api/${name}`, wrap(async (req, res) => {
    const o = pick(req.body || {}, fields);
    try { require_(o, required); } catch (e) { return res.status(400).json({ error: e.message }); }
    const k = Object.keys(o);
    const r = await db.run(`INSERT INTO ${table} (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`, ...k.map(x => o[x]));
    await afterWrite(); res.status(201).json(await getOne(r.lastInsertRowid));
  }));
  const update = wrap(async (req, res) => {
    if (!(await getOne(req.params.id))) return res.status(404).json({ error: 'Not found' });
    const o = pick(req.body || {}, fields); const k = Object.keys(o);
    if (k.length) await db.run(`UPDATE ${table} SET ${k.map(x => x + '=?').join(',')} WHERE id=?`, ...k.map(x => o[x]), req.params.id);
    await afterWrite(); res.json(await getOne(req.params.id));
  });
  app.put(`/api/${name}/:id`, update); app.patch(`/api/${name}/:id`, update);
  app.get(`/api/${name}/:id`, wrap(async (req, res) => { const r = await getOne(req.params.id); r ? res.json(r) : res.status(404).json({ error: 'Not found' }); }));
  app.delete(`/api/${name}/:id`, wrap(async (req, res) => {
    if (beforeDelete) { const why = await beforeDelete(req.params.id); if (why) return res.status(400).json({ error: why }); }
    const r = await db.run(`DELETE FROM ${table} WHERE id=?`, req.params.id);
    await afterWrite(); r.changes ? res.json({ deleted: +req.params.id }) : res.status(404).json({ error: 'Not found' });
  }));
}
const LOAN_SQL = `SELECT l.*, b.name AS borrower_name, b.phone AS borrower_phone,
  COALESCE((SELECT SUM(amount) FROM repayments r WHERE r.loan_id=l.id),0) AS total_paid,
  (SELECT COUNT(*) FROM repayments r WHERE r.loan_id=l.id) AS repayment_count
  FROM loans l JOIN borrowers b ON b.id=l.borrower_id`;
const allLoans = async () => (await db.all(LOAN_SQL + ' ORDER BY l.start_date DESC, l.id DESC')).map(l => enrich(l));
// Persist computed status (active/overdue/paid) unless loan was manually marked defaulted.
async function afterWrite() {
  const ch = (await allLoans()).filter(l => l.status !== 'defaulted' && l.status !== l.effective_status);
  if (ch.length) await db.batch(ch.map(l => ['UPDATE loans SET status=? WHERE id=?', [l.effective_status, l.id]]));
}
const getBorrower = id => db.get(`SELECT b.*, (SELECT COUNT(*) FROM loans WHERE borrower_id=b.id) AS loan_count FROM borrowers b WHERE id=?`, id);
const getLoan = async id => { const l = await db.get(LOAN_SQL + ' WHERE l.id=?', id); return l && enrich(l); };
const getRepayment = id => db.get(`SELECT r.*, b.name AS borrower_name, b.id AS borrower_id FROM repayments r JOIN loans l ON l.id=r.loan_id JOIN borrowers b ON b.id=l.borrower_id WHERE r.id=?`, id);

// ---------- borrowers ----------
app.get('/api/borrowers', wrap(async (req, res) => {
  const q = `%${req.query.q || ''}%`;
  const rows = await db.all(`SELECT b.*, COUNT(l.id) AS loan_count, COALESCE(SUM(l.principal),0) AS total_borrowed
    FROM borrowers b LEFT JOIN loans l ON l.borrower_id=b.id
    WHERE b.name LIKE ? OR IFNULL(b.phone,'') LIKE ? OR IFNULL(b.email,'') LIKE ? OR IFNULL(b.id_number,'') LIKE ?
    GROUP BY b.id ORDER BY b.name`, q, q, q, q);
  res.json(rows);
}));
crud('borrowers', 'borrowers', ['name', 'phone', 'email', 'address', 'id_number'], ['name'], getBorrower,
  async id => (await db.get('SELECT COUNT(*) c FROM loans WHERE borrower_id=?', id)).c ? 'Cannot delete a borrower who has loans (FOREIGN KEY constraint)' : null);

// ---------- loans ----------
app.get('/api/loans', wrap(async (req, res) => {
  await afterWrite();
  let rows = await allLoans();
  const { status, borrower_id, q } = req.query;
  if (status) rows = rows.filter(l => l.effective_status === status);
  if (borrower_id) rows = rows.filter(l => l.borrower_id == borrower_id);
  if (q) { const s = q.toLowerCase(); rows = rows.filter(l => l.borrower_name.toLowerCase().includes(s) || String(l.id) === q || (l.notes || '').toLowerCase().includes(s)); }
  res.json(rows);
}));
app.get('/api/loans/:id/schedule', wrap(async (req, res) => {
  const l = await getLoan(req.params.id); if (!l) return res.status(404).json({ error: 'Not found' });
  res.json({ loan_id: l.id, total_due: l.total_due, total_paid: l.total_paid, schedule: schedule(l, l.total_paid) });
}));
app.get('/api/loans/:id/repayments', wrap(async (req, res) => res.json(await db.all('SELECT * FROM repayments WHERE loan_id=? ORDER BY date DESC', req.params.id))));
crud('loans', 'loans', ['borrower_id', 'principal', 'interest_rate', 'term_months', 'start_date', 'repayment_frequency', 'status', 'notes'],
  ['borrower_id', 'principal', 'interest_rate', 'term_months', 'start_date'], getLoan);

// ---------- repayments ----------
app.get('/api/repayments', wrap(async (req, res) => {
  const { loan_id, method, from, to, q } = req.query;
  const w = [], p = [];
  if (loan_id) { w.push('r.loan_id=?'); p.push(loan_id); }
  if (method) { w.push('r.method=?'); p.push(method); }
  if (from) { w.push('r.date>=?'); p.push(from); }
  if (to) { w.push('r.date<=?'); p.push(to); }
  if (q) { w.push("(b.name LIKE ? OR IFNULL(r.reference,'') LIKE ?)"); p.push(`%${q}%`, `%${q}%`); }
  res.json(await db.all(`SELECT r.*, b.name AS borrower_name, b.id AS borrower_id FROM repayments r JOIN loans l ON l.id=r.loan_id JOIN borrowers b ON b.id=l.borrower_id
    ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY r.date DESC, r.id DESC`, ...p));
}));
crud('repayments', 'repayments', ['loan_id', 'amount', 'date', 'method', 'reference'], ['loan_id', 'amount', 'date'], getRepayment);

// ---------- settings ----------
const getSetting = async (k, d) => ((await db.get('SELECT value FROM settings WHERE key=?', k)) || {}).value || d;
app.get('/api/settings', wrap(async (req, res) => res.json({ currency: await getSetting('currency', DEFAULT_CURRENCY) })));
app.put('/api/settings', wrap(async (req, res) => {
  const c = String((req.body || {}).currency || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) return res.status(400).json({ error: 'currency must be a 3-letter ISO code' });
  await db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'currency', c);
  res.json({ currency: c });
}));

// ---------- summary ----------
app.get('/api/summary', wrap(async (req, res) => {
  await afterWrite();
  const loans = await allLoans();
  const sum = (a, f) => Math.round(a.reduce((s, x) => s + f(x), 0) * 100) / 100;
  const overdue = loans.filter(l => l.effective_status === 'overdue');
  const months = +req.query.months || 12;
  const keys = []; const d = new Date(); d.setUTCDate(1);
  for (let i = months - 1; i >= 0; i--) { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)); keys.push(x.toISOString().slice(0, 7)); }
  const disb = Object.fromEntries((await db.all(`SELECT substr(start_date,1,7) m, SUM(principal) s FROM loans GROUP BY m`)).map(r => [r.m, r.s]));
  const coll = Object.fromEntries((await db.all(`SELECT substr(date,1,7) m, SUM(amount) s FROM repayments GROUP BY m`)).map(r => [r.m, r.s]));
  const byStatus = {}; for (const s of ['active', 'paid', 'overdue', 'defaulted']) byStatus[s] = loans.filter(l => l.effective_status === s).length;
  res.json({
    currency: await getSetting('currency', DEFAULT_CURRENCY),
    total_lent: sum(loans, l => l.principal),
    total_collected: sum(loans, l => l.total_paid),
    total_outstanding: sum(loans.filter(l => l.effective_status !== 'defaulted'), l => l.outstanding),
    defaulted_outstanding: sum(loans.filter(l => l.effective_status === 'defaulted'), l => l.outstanding),
    expected_interest: sum(loans, l => l.expected_interest),
    overdue_count: overdue.length,
    overdue_amount: sum(overdue, l => l.arrears),
    borrower_count: (await db.get('SELECT COUNT(*) c FROM borrowers')).c,
    loan_count: loans.length,
    loans_by_status: byStatus,
    monthly_trends: keys.map(m => ({ month: m, disbursed: disb[m] || 0, collected: Math.round((coll[m] || 0) * 100) / 100 })),
  });
}));


// ---------- export (xlsx + per-table CSV; plain GET so cookie auth works for iOS Safari downloads) ----------
const ExcelJS = require('exceljs');
const EXPORT_COLS = {
  borrowers: ['id', 'name', 'phone', 'email', 'address', 'id_number', 'loan_count', 'total_borrowed', 'created_at'],
  loans: ['id', 'borrower_id', 'borrower_name', 'borrower_phone', 'principal', 'interest_rate', 'term_months', 'repayment_frequency', 'start_date',
    'total_due', 'total_paid', 'outstanding', 'arrears', 'effective_status', 'notes'],
  repayments: ['id', 'loan_id', 'borrower_id', 'borrower_name', 'amount', 'date', 'method', 'reference'],
};
const HEAD = { effective_status: 'status', outstanding: 'balance' };
async function exportData() {
  await afterWrite();
  const borrowers = await db.all(`SELECT b.*, COUNT(l.id) AS loan_count, COALESCE(SUM(l.principal),0) AS total_borrowed
    FROM borrowers b LEFT JOIN loans l ON l.borrower_id=b.id GROUP BY b.id ORDER BY b.id`);
  const loans = (await allLoans()).sort((a, b) => a.id - b.id);
  const repayments = await db.all(`SELECT r.*, b.name AS borrower_name, b.id AS borrower_id FROM repayments r JOIN loans l ON l.id=r.loan_id
    JOIN borrowers b ON b.id=l.borrower_id ORDER BY r.date, r.id`);
  const shape = (t, rows) => rows.map(r => EXPORT_COLS[t].map(c => r[c] ?? ''));
  return { borrowers: shape('borrowers', borrowers), loans: shape('loans', loans), repayments: shape('repayments', repayments) };
}
const heads = t => EXPORT_COLS[t].map(c => HEAD[c] || c);
const today = () => new Date().toISOString().slice(0, 10);
const attach = (res, type, name) => { res.setHeader('Content-Type', type); res.setHeader('Content-Disposition', `attachment; filename="${name}"`); res.setHeader('Cache-Control', 'no-store'); };
app.get('/api/export.xlsx', wrap(async (req, res) => {
  const data = await exportData(); const wb = new ExcelJS.Workbook(); wb.created = new Date();
  for (const t of Object.keys(EXPORT_COLS)) {
    const ws = wb.addWorksheet(t[0].toUpperCase() + t.slice(1));
    ws.addRow(heads(t)).font = { bold: true }; data[t].forEach(r => ws.addRow(r));
    ws.columns.forEach((c, i) => { c.width = Math.min(40, Math.max(10, heads(t)[i].length + 2, ...data[t].map(r => String(r[i]).length + 2))); });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }
  const buf = await wb.xlsx.writeBuffer();
  attach(res, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', `loan-data-${today()}.xlsx`); res.send(Buffer.from(buf));
}));
app.get('/api/export/:table.csv', wrap(async (req, res) => {
  const t = req.params.table; if (!EXPORT_COLS[t]) return res.status(404).json({ error: 'Unknown table' });
  const q = v => { const s = String(v); return /[",\r\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = [heads(t), ...(await exportData())[t]].map(r => r.map(q).join(','));
  attach(res, 'text/csv; charset=utf-8', `${t}-${today()}.csv`); res.send('\uFEFF' + rows.join('\r\n') + '\r\n');
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use('/vendor/chart.js', express.static(path.join(__dirname, 'node_modules/chart.js/dist')));
app.use(express.static(path.join(__dirname, 'public')));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error' }); });

(async () => {
  const applied = await migrate(db);
  console.log(`DB: ${IS_REMOTE ? 'Turso ' + DB_URL.replace(/\?.*/, '') : DB_URL} — migrations applied: ${applied.join(', ') || 'none (up to date)'}`);
  if (SEED) await seed(db); else console.log('Example data seeding skipped (set SEED_EXAMPLE_DATA=true to enable).');
  await afterWrite();
  app.listen(PORT, () => console.log(`Loan dashboard on port ${PORT} (user: ${ADMIN_USER}${PROD ? ', production' : ''})`));
})().catch(e => { console.error('Startup failed:', e); process.exit(1); });
