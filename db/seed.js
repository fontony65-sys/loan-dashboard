// Seeds clearly labelled EXAMPLE data. Usage: node db/seed.js [--force]  (--force wipes existing data)
// Also exported as seed(db, {force}) so the server can seed at startup when SEED_EXAMPLE_DATA=true.
const { open, migrate } = require('./index');
async function seed(db, { force = false } = {}) {
if ((await db.get('SELECT COUNT(*) c FROM borrowers')).c && !force) { console.log('DB already has data; use --force to reseed.'); return false; }
await db.batch([['DELETE FROM repayments'], ['DELETE FROM loans'], ['DELETE FROM borrowers'], ["DELETE FROM sqlite_sequence WHERE name IN ('borrowers','loans','repayments')"]]);
let s = 42; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
const pickA = a => a[Math.floor(rnd() * a.length)];
const names = ['Jean-Paul Mbarga', 'Aïcha Bello', 'Emmanuel Nkodo', 'Grace Ngo Mbappe', 'Samuel Etoundi', 'Brenda Fon', 'Ibrahim Moussa', 'Christelle Kamga',
  'Patrick Tchinda', 'Mireille Essomba', 'Hervé Ndjock', 'Linda Atangana', 'Oumarou Hamadou', 'Florence Ewane', 'Didier Fotso'];
const areas = ['Akwa', 'Bonapriso', 'Deido', 'Bonabéri', 'Makepe', 'Bonamoussadi', 'Ndokoti', 'New Bell', 'Logbaba', 'Kotto'];
const bIds = [];
for (const [i, n] of names.entries()) bIds.push((await db.run('INSERT INTO borrowers(name,phone,email,address,id_number) VALUES(?,?,?,?,?)', `[EXAMPLE] ${n}`, `+237 6${String(70000000 + Math.floor(rnd() * 29999999)).slice(0, 8)}`,
  n.toLowerCase().normalize('NFD').replace(/[^a-z ]/g, '').replace(' ', '.').split(' ')[0] + '@example.com',
  `${pickA(areas)}, Douala, Cameroon (example)`, `EX-CNI-${String(100000 + i * 7919).padStart(9, '0')}`)).lastInsertRowid);
const { totals, schedule } = require('../lib');
const today = new Date(); const iso = d => d.toISOString().slice(0, 10);
// behaviour per loan: good payer, paid off, late payer, defaulted
const plan = ['good', 'good', 'paid', 'late', 'good', 'paid', 'late', 'good', 'defaulted', 'good', 'late', 'good', 'paid', 'good', 'late',
  'good', 'good', 'paid', 'late', 'good', 'defaulted', 'good', 'good', 'late', 'good'];
const reps = [];
  for (const [i, kind] of plan.entries()) {
    const term = pickA([3, 6, 6, 9, 12, 12]);
    const ago = kind === 'paid' ? term + Math.floor(rnd() * 3) : Math.floor(rnd() * Math.min(term, 11)) + 1;
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - ago, 1 + Math.floor(rnd() * 27)));
    const loan = { principal: pickA([100, 150, 250, 300, 500, 750, 1000, 1500, 2000]) * 1000, interest_rate: pickA([18, 20, 24, 30, 36]),
      term_months: term, start_date: iso(start), repayment_frequency: rnd() < 0.2 ? 'weekly' : 'monthly' };
    const id = (await db.run('INSERT INTO loans(borrower_id,principal,interest_rate,term_months,start_date,repayment_frequency,status,notes) VALUES(?,?,?,?,?,?,?,?)', bIds[i % bIds.length], loan.principal, loan.interest_rate, loan.term_months, loan.start_date, loan.repayment_frequency,
      kind === 'defaulted' ? 'defaulted' : 'active', `[EXAMPLE] ${kind} payer`)).lastInsertRowid;
    for (const inst of schedule(loan)) {
      if (inst.due_date > iso(today)) break;
      if (kind === 'late' && rnd() < 0.55) continue;
      if (kind === 'defaulted' && inst.number > 1) break;
      const pd = new Date(inst.due_date + 'T00:00:00Z'); pd.setUTCDate(pd.getUTCDate() - Math.floor(rnd() * 4));
      reps.push(['INSERT INTO repayments(loan_id,amount,date,method,reference) VALUES(?,?,?,?,?)', [id, inst.amount, iso(pd) > iso(today) ? iso(today) : iso(pd), pickA(['mobile_money', 'mobile_money', 'cash', 'bank_transfer']), `EX-${id}-${inst.number}`]]);
    }
  }
  await db.batch(reps);
const c = async t => (await db.get(`SELECT COUNT(*) c FROM ${t}`)).c;
console.log(`Seeded example data: ${await c('borrowers')} borrowers, ${await c('loans')} loans, ${await c('repayments')} repayments`);
return true;
}
module.exports = { seed };
if (require.main === module) (async () => { const db = open(); await migrate(db); await seed(db, { force: process.argv.includes('--force') }); db.close(); })()
  .catch(e => { console.error(e); process.exit(1); });
