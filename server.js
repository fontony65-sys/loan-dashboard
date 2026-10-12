// Load .env for local use if present (Node >= 20.12). Real env vars (e.g. on Render) take precedence.
try { if (require('fs').existsSync(__dirname + '/.env')) process.loadEnvFile(__dirname + '/.env'); } catch (e) { console.warn('Could not load .env:', e.message); }
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { open, migrate, DB_URL, IS_REMOTE } = require('./db');
const { seed } = require('./db/seed');
const { enrich, schedule, calculate } = require('./lib');

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
app.get('/lib.js', (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'lib.js')));
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
function crud(name, table, fields, required, getOne, beforeDelete, normalize = async o => o) {
  app.post(`/api/${name}`, wrap(async (req, res) => {
    let o = pick(req.body || {}, fields);
    try { o = await normalize(o); require_(o, required); } catch (e) { return res.status(400).json({ error: e.message }); }
    const k = Object.keys(o);
    const r = await db.run(`INSERT INTO ${table} (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`, ...k.map(x => o[x]));
    await afterWrite(); res.status(201).json(await getOne(r.lastInsertRowid));
  }));
  const update = wrap(async (req, res) => {
    if (!(await getOne(req.params.id))) return res.status(404).json({ error: 'Not found' });
    let o = pick(req.body || {}, fields);
    try { o = await normalize(o, req.params.id); } catch (e) { return res.status(400).json({ error: e.message }); }
    const k = Object.keys(o);
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
  const loans = await allLoans();
  for (const b of rows) { const ls = loans.filter(l => l.borrower_id === b.id);
    b.last_loan_date = ls.reduce((m, l) => l.start_date > (m || '') ? l.start_date : m, null);
    b.next_due_date = ls.filter(l => l.next_due_date && l.outstanding > 0.01).reduce((m, l) => !m || l.next_due_date < m ? l.next_due_date : m, null); }
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
  res.json({ loan_id: l.id, start_date: l.start_date, end_date: l.end_date, next_due_date: l.next_due_date, total_due: l.total_due, total_paid: l.total_paid, schedule: schedule(l, l.total_paid) });
}));
app.get('/api/loans/:id/repayments', wrap(async (req, res) => res.json(await db.all('SELECT * FROM repayments WHERE loan_id=? ORDER BY date DESC', req.params.id))));
// Short-term loans (term_days set): keep interest_amount (XAF) and interest_rate (% of principal, whole loan) in sync;
// fill the legacy NOT NULL columns (term_months, repayment_frequency) with placeholders.
async function normalizeLoan(o, id) {
  const cur = id ? (await db.get('SELECT * FROM loans WHERE id=?', id)) || {} : {};
  const m = { ...cur, ...o };
  const short = m.term_days != null || (!id && o.term_months == null);
  if (!short) return o;
  if (!(+m.term_days >= 1)) throw new Error('term_days must be at least 1');
  if (!(+m.principal > 0)) throw new Error('principal must be > 0');
  const n = Math.round(+(m.installments || 1)); if (!(n >= 1) || n > +m.term_days) throw new Error('installments must be between 1 and term_days');
  let amt = o.interest_amount ?? null, pct = o.interest_rate ?? null;
  if (amt == null && pct == null) { amt = cur.interest_amount; pct = cur.interest_rate; if (o.principal != null && cur.interest_amount != null) amt = null; }
  if (amt == null && pct == null) throw new Error('Missing required field(s): interest_rate or interest_amount');
  if (amt != null) { amt = +amt; pct = Math.round(amt / +m.principal * 10000) / 100; } else { pct = +pct; amt = Math.round(+m.principal * pct) / 100; }
  if (!(amt >= 0)) throw new Error('interest must be >= 0');
  return { ...o, term_days: Math.round(+m.term_days), installments: n, interest_amount: amt, interest_rate: pct, term_months: Math.max(1, Math.ceil(+m.term_days / 30)), repayment_frequency: 'monthly' };
}
crud('loans', 'loans', ['borrower_id', 'principal', 'interest_rate', 'interest_amount', 'term_days', 'installments', 'term_months', 'start_date', 'repayment_frequency', 'status', 'notes'],
  ['borrower_id', 'principal', 'interest_rate', 'term_months', 'start_date'], getLoan, null, normalizeLoan);

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

app.get('/api/calculate', (req, res) => { try { res.json(calculate(req.query)); } catch (e) { res.status(400).json({ error: e.message }); } });

// ---------- settings ----------
const getSetting = async (k, d) => ((await db.get('SELECT value FROM settings WHERE key=?', k)) || {}).value || d;
const settingsOut = async () => ({ currency: await getSetting('currency', DEFAULT_CURRENCY), starting_capital: +(await getSetting('starting_capital', process.env.STARTING_CAPITAL || '200000')) || 0 });
app.get('/api/settings', wrap(async (req, res) => res.json(await settingsOut())));
app.put('/api/settings', wrap(async (req, res) => {
  const b = req.body || {}, set = (k, val) => db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, val);
  if (b.currency === undefined && b.starting_capital === undefined) return res.status(400).json({ error: 'Provide currency and/or starting_capital' });
  if (b.currency !== undefined) { const c = String(b.currency).toUpperCase(); if (!/^[A-Z]{3}$/.test(c)) return res.status(400).json({ error: 'currency must be a 3-letter ISO code' }); await set('currency', c); }
  if (b.starting_capital !== undefined) { const n = Number(b.starting_capital); if (b.starting_capital === '' || !isFinite(n) || n < 0) return res.status(400).json({ error: 'starting_capital must be a number >= 0' }); await set('starting_capital', String(n)); }
  res.json(await settingsOut());
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



// ---------- growth & leaderboard ----------
async function bookData() {
  await afterWrite();
  const loans = await allLoans();
  const reps = await db.all('SELECT loan_id, amount, date FROM repayments ORDER BY date, id');
  const borrowers = await db.all('SELECT id, name, phone, created_at FROM borrowers');
  return { loans, reps, borrowers, byId: new Map(loans.map(l => [l.id, l])) };
}
const r2s = x => Math.round(x * 100) / 100;
const iso = d => d.toISOString().slice(0, 10);
function bucketStart(dateStr, period) {
  const d = new Date(dateStr.slice(0, 10) + 'T00:00:00Z');
  if (period === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); else d.setUTCDate(1);
  return iso(d);
}
function nextBucket(s, period) { const d = new Date(s + 'T00:00:00Z'); period === 'week' ? d.setUTCDate(d.getUTCDate() + 7) : d.setUTCMonth(d.getUTCMonth() + 1); return iso(d); }
app.get('/api/growth', wrap(async (req, res) => {
  const period = req.query.period === 'week' ? 'week' : 'month';
  const n = Math.min(104, Math.max(2, +req.query.n || (period === 'week' ? 12 : 12)));
  const { loans, reps, borrowers, byId } = await bookData();
  const capital = (await settingsOut()).starting_capital;
  let start = bucketStart(iso(new Date()), period); const keys = [start];
  for (let i = 1; i < n; i++) { const d = new Date(start + 'T00:00:00Z'); period === 'week' ? d.setUTCDate(d.getUTCDate() - 7 * i) : d.setUTCMonth(d.getUTCMonth() - i); keys.unshift(iso(d)); }
  const first = keys[0];
  const interestOf = r => { const l = byId.get(r.loan_id); return l && l.total_due ? r.amount * l.expected_interest / l.total_due : 0; };
  let cum = reps.filter(r => r.date < first).reduce((a, r) => a + interestOf(r), 0);
  const rows = keys.map(k => {
    const end = nextBucket(k, period), inB = d => d && d.slice(0, 10) >= k && d.slice(0, 10) < end;
    const nl = loans.filter(l => inB(l.start_date)), rp = reps.filter(r => inB(r.date));
    const interest = rp.reduce((a, r) => a + interestOf(r), 0); cum += interest;
    const active = new Set([...nl.map(l => l.borrower_id), ...rp.map(r => byId.get(r.loan_id)?.borrower_id)].filter(x => x != null));
    const paidBy = new Map(); for (const r of reps) if (r.date < end) paidBy.set(r.loan_id, (paidBy.get(r.loan_id) || 0) + r.amount);
    const book = loans.filter(l => l.start_date < end && l.effective_status !== 'defaulted').reduce((a, l) => a + Math.max(0, l.total_due - (paidBy.get(l.id) || 0)), 0);
    const before = loans.filter(l => l.start_date < end), cumLent = before.reduce((a, l) => a + l.principal, 0);
    const cumColl = reps.filter(r => r.date < end).reduce((a, r) => a + r.amount, 0);
    const writeoffs = before.filter(l => l.effective_status === 'defaulted').reduce((a, l) => a + Math.max(0, l.principal - (paidBy.get(l.id) || 0) * l.principal / l.total_due), 0);
    return { period: k, equity: r2s(capital + cum - writeoffs), cash_on_hand: r2s(capital + cumColl - cumLent), on_loan: r2s(book), write_offs: r2s(writeoffs), lent: r2s(nl.reduce((a, l) => a + l.principal, 0)), collected: r2s(rp.reduce((a, r) => a + r.amount, 0)), interest_earned: r2s(interest),
      new_loans: nl.length, new_borrowers: borrowers.filter(b => inB(b.created_at)).length, active_borrowers: active.size, outstanding_book: r2s(book), cumulative_profit: r2s(cum) };
  });
  const [prev, last] = rows.slice(-2), metrics = Object.keys(last).filter(k => k !== 'period');
  const growth = Object.fromEntries(metrics.map(m => [m, prev[m] ? r2s((last[m] - prev[m]) / prev[m] * 100) : null]));
  res.json({ period, starting_capital: capital, series: rows, current: last, previous: prev, growth_pct: growth, empty: !loans.length && !reps.length && !borrowers.length });
}));
app.get('/api/leaderboard', wrap(async (req, res) => {
  const sort = ['loans', 'borrowed', 'repaid', 'ontime'].includes(req.query.sort) ? req.query.sort : 'loans';
  const { loans, reps, borrowers } = await bookData();
  const repsBy = new Map(); for (const r of reps) (repsBy.get(r.loan_id) || repsBy.set(r.loan_id, []).get(r.loan_id)).push(r);
  const rows = borrowers.map(b => {
    const ls = loans.filter(l => l.borrower_id === b.id); let completed = 0, onTime = 0;
    for (const l of ls) {
      if (l.outstanding > 0.01) continue; completed++;
      let c = 0, cleared = null; for (const r of repsBy.get(l.id) || []) { c += r.amount; if (c >= l.total_due - 0.01) { cleared = r.date; break; } }
      if (cleared && cleared <= l.end_date) onTime++;
    }
    return { borrower_id: b.id, name: b.name, phone: b.phone, loan_count: ls.length, total_borrowed: r2s(ls.reduce((a, l) => a + l.principal, 0)),
      total_repaid: r2s(ls.reduce((a, l) => a + l.total_paid, 0)), completed_loans: completed, on_time_loans: onTime,
      on_time_rate: completed ? r2s(onTime / completed * 100) : null, active_loans: ls.filter(l => l.outstanding > 0.01).length };
  }).filter(r => r.loan_count > 0);
  const key = { loans: 'loan_count', borrowed: 'total_borrowed', repaid: 'total_repaid', ontime: 'on_time_rate' }[sort];
  rows.sort((a, b) => ((b[key] ?? -1) - (a[key] ?? -1)) || (b.completed_loans - a.completed_loans) || (b.total_borrowed - a.total_borrowed) || a.name.localeCompare(b.name));
  rows.forEach((r, i) => { r.rank = i + 1; r.badge = ['gold', 'silver', 'bronze'][i] || null; });
  res.json({ sort, rows });
}));


// ---------- cash flow calendar ----------
app.get('/api/cashflow', wrap(async (req, res) => {
  const t = iso(new Date()), add = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return iso(x); };
  const range = ['today', 'week', 'next7', 'next14', 'next30', 'past'].includes(req.query.range) ? req.query.range : 'next7';
  let from, to;
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) { from = req.query.from; to = req.query.to; }
  else if (range === 'today') from = to = t;
  else if (range === 'week') { from = bucketStart(t, 'week'); to = add(from, 6); }
  else if (range === 'past') { from = add(t, -30); to = add(t, -1); }
  else { from = t; to = add(t, +range.slice(4)); }
  const { loans, reps, byId } = await bookData();
  const ev = [];
  for (const l of loans) if (l.start_date >= from && l.start_date <= to) ev.push({ date: l.start_date, type: 'disbursed', direction: 'out', amount: l.principal, loan_id: l.id, borrower_id: l.borrower_id, borrower_name: l.borrower_name });
  for (const r of reps) if (r.date >= from && r.date <= to) { const l = byId.get(r.loan_id); ev.push({ date: r.date, type: 'received', direction: 'in', amount: r.amount, loan_id: r.loan_id, borrower_id: l?.borrower_id, borrower_name: l?.borrower_name }); }
  const overdue = [];
  for (const l of loans) { if (l.effective_status === 'defaulted' || l.outstanding <= 0.01) continue;
    for (const s of schedule(l, l.total_paid)) { if (s.status === 'paid') continue; const due = Math.round((s.amount - s.paid) * 100) / 100;
      const e = { date: s.due_date, type: 'expected', direction: 'in', amount: due, loan_id: l.id, borrower_id: l.borrower_id, borrower_name: l.borrower_name, installment: s.number,
        due_today: s.due_date === t, overdue: s.due_date < t };
      if (e.overdue) overdue.push(e);
      if (s.due_date >= from && s.due_date <= to && (!e.overdue || range === 'past' || req.query.from)) ev.push(e); } }
  ev.sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));
  const days = []; for (const e of ev) { let d = days[days.length - 1]; if (!d || d.date !== e.date) days.push(d = { date: e.date, out: 0, in_received: 0, in_expected: 0, events: [] });
    d.events.push(e); d[e.type === 'disbursed' ? 'out' : e.type === 'received' ? 'in_received' : 'in_expected'] += e.amount; }
  for (const d of days) for (const k of ['out', 'in_received', 'in_expected']) d[k] = r2s(d[k]);
  const tot = k => r2s(days.reduce((a, d) => a + d[k], 0));
  res.json({ range, from, to, today: t, totals: { out: tot('out'), in_received: tot('in_received'), in_expected: tot('in_expected') },
    overdue: overdue.sort((a, b) => a.date.localeCompare(b.date)), overdue_total: r2s(overdue.reduce((a, e) => a + e.amount, 0)),
    due_today_total: r2s(ev.filter(e => e.due_today).reduce((a, e) => a + e.amount, 0)), days });
}));

// ---------- export (xlsx + per-table CSV; plain GET so cookie auth works for iOS Safari downloads) ----------
const ExcelJS = require('exceljs');
const EXPORT_COLS = {
  borrowers: ['id', 'name', 'phone', 'email', 'address', 'id_number', 'loan_count', 'total_borrowed', 'last_loan_date', 'next_due_date', 'created_at'],
  loans: ['id', 'borrower_id', 'borrower_name', 'borrower_phone', 'model', 'principal', 'expected_interest', 'interest_pct', 'term_days', 'installments', 'start_date', 'end_date', 'next_due_date',
    'interest_rate', 'term_months', 'repayment_frequency',
    'total_due', 'total_paid', 'outstanding', 'arrears', 'effective_status', 'notes'],
  repayments: ['id', 'loan_id', 'borrower_id', 'borrower_name', 'amount', 'date', 'method', 'reference'],
};
const HEAD = { effective_status: 'status', outstanding: 'balance', expected_interest: 'interest_amount', interest_pct: 'interest_pct_of_principal', end_date: 'due_date', start_date: 'disbursed_date', interest_rate: 'legacy_annual_rate', term_months: 'legacy_term_months', repayment_frequency: 'legacy_frequency' };
async function exportData() {
  await afterWrite();
  const borrowers = await db.all(`SELECT b.*, COUNT(l.id) AS loan_count, COALESCE(SUM(l.principal),0) AS total_borrowed
    FROM borrowers b LEFT JOIN loans l ON l.borrower_id=b.id GROUP BY b.id ORDER BY b.id`);
  const loans = (await allLoans()).sort((a, b) => a.id - b.id);
  for (const b of borrowers) { const ls = loans.filter(l => l.borrower_id === b.id); b.last_loan_date = ls.map(l => l.start_date).sort().pop() || '';
    b.next_due_date = ls.filter(l => l.outstanding > 0.01 && l.next_due_date).map(l => l.next_due_date).sort()[0] || ''; }
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
