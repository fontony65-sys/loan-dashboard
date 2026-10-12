// Shared by server (require) and browser (/lib.js -> window.LoanLib).
(function () {
// Loan math. Default (term_days set): flat interest charge on the principal for the whole loan
// (interest_amount, or interest_rate = % of principal for the whole loan), repaid as one lump sum at
// start+term_days or in N equal installments spread evenly over the term.
// Legacy (term_days NULL): flat ANNUAL interest_rate over term_months, equal weekly/biweekly/monthly installments.
const PERIODS_PER_MONTH = { weekly: 52 / 12, biweekly: 26 / 12, monthly: 1 };
function addPeriod(d, freq, i) {
  const x = new Date(d + 'T00:00:00Z');
  if (freq === 'monthly') x.setUTCMonth(x.getUTCMonth() + i);
  else x.setUTCDate(x.getUTCDate() + i * (freq === 'weekly' ? 7 : 14));
  return x.toISOString().slice(0, 10);
}
const isShort = l => l.term_days != null && l.term_days !== '';
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const shortInterest = l => l.interest_amount != null && l.interest_amount !== '' ? +l.interest_amount : +l.principal * (+l.interest_rate || 0) / 100;
function dueDate(loan, i, n) { return isShort(loan) ? addDays(loan.start_date, Math.round(+loan.term_days * i / n)) : addPeriod(loan.start_date, loan.repayment_frequency, i); }
function totals(loan) {
  if (isShort(loan)) {
    const interest = shortInterest(loan), n = Math.max(1, Math.min(+loan.term_days, Math.round(+loan.installments || 1))), totalDue = +loan.principal + interest;
    return { interest: r2(interest), totalDue: r2(totalDue), n, installment: r2(totalDue / n) };
  }
  const interest = loan.principal * (loan.interest_rate / 100) * (loan.term_months / 12);
  const n = Math.max(1, Math.round(loan.term_months * (PERIODS_PER_MONTH[loan.repayment_frequency] || 1)));
  const totalDue = loan.principal + interest;
  return { interest: r2(interest), totalDue: r2(totalDue), n, installment: r2(totalDue / n) };
}
function schedule(loan, paid = 0) {
  const t = totals(loan);
  let cum = 0, remainingPaid = paid;
  const rows = [];
  for (let i = 1; i <= t.n; i++) {
    const amt = i === t.n ? r2(t.totalDue - cum) : t.installment;
    cum = r2(cum + amt);
    const covered = Math.min(amt, Math.max(0, remainingPaid));
    remainingPaid -= covered;
    rows.push({ number: i, due_date: dueDate(loan, i, t.n), amount: amt, cumulative_due: cum,
      paid: r2(covered), status: covered >= amt - 0.01 ? 'paid' : covered > 0 ? 'partial' : 'pending' });
  }
  return rows;
}
// Enrich a loan row (with total_paid) with computed fields & effective status.
function enrich(loan, today = new Date().toISOString().slice(0, 10)) {
  const t = totals(loan);
  const paid = loan.total_paid || 0;
  const sched = schedule(loan, paid);
  const dueToDate = sched.filter(s => s.due_date <= today).reduce((a, s) => a + s.amount, 0);
  const arrears = r2(Math.max(0, dueToDate - paid));
  const outstanding = r2(Math.max(0, t.totalDue - paid));
  let effective = loan.status;
  if (loan.status !== 'defaulted') {
    if (outstanding <= 0.01) effective = 'paid';
    else if (arrears > 0.01) effective = 'overdue';
    else effective = 'active';
  }
  const next = sched.find(s => s.status !== 'paid');
  return { ...loan, total_paid: r2(paid), expected_interest: t.interest, total_due: t.totalDue, installment: t.installment,
    installments: t.n, outstanding, arrears: loan.status === 'defaulted' ? outstanding : arrears, effective_status: effective,
    next_due_date: next ? next.due_date : null, end_date: isShort(loan) ? addDays(loan.start_date, +loan.term_days) : addPeriod(loan.start_date, 'monthly', loan.term_months),
    model: isShort(loan) ? 'short' : 'legacy', interest_pct: r2(t.interest / loan.principal * 100) };
}
const r2 = x => Math.round(x * 100) / 100;
// Calculator: the default short-term model, using the same totals()/schedule() as real loans.
function calculate(q) {
  const loan = { principal: +q.principal, term_days: +q.term_days, installments: +(q.installments || 1), start_date: q.start_date,
    interest_rate: q.interest_rate === '' || q.interest_rate == null ? null : +q.interest_rate,
    interest_amount: q.interest_amount === '' || q.interest_amount == null ? null : +q.interest_amount };
  if (!(loan.principal > 0) || !(loan.term_days >= 1) || !(loan.installments >= 1) || !/^\d{4}-\d{2}-\d{2}$/.test(loan.start_date || '') ||
    (loan.interest_amount == null && !(loan.interest_rate >= 0)) || (loan.interest_amount != null && !(loan.interest_amount >= 0))) throw new Error('Invalid input');
  const t = totals(loan), share = loan.principal / t.totalDue; let bal = t.totalDue, pAcc = 0;
  const rows = schedule(loan).map((s, k, a) => { const prin = k === a.length - 1 ? r2(loan.principal - pAcc) : r2(s.amount * share); pAcc = r2(pAcc + prin); bal = r2(bal - s.amount);
    return { number: s.number, due_date: s.due_date, amount: s.amount, principal: prin, interest: r2(s.amount - prin), balance: Math.max(0, bal) }; });
  return { installment: t.installment, installments: t.n, total_interest: t.interest, interest_pct: r2(t.interest / loan.principal * 100), total_repayable: t.totalDue,
    due_date: addDays(loan.start_date, loan.term_days), schedule: rows };
}
const api = { totals, schedule, enrich, addPeriod, addDays, calculate };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else window.LoanLib = api;
})();
