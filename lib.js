// Loan math: flat annual interest over the term, equal installments.
const PERIODS_PER_MONTH = { weekly: 52 / 12, biweekly: 26 / 12, monthly: 1 };
function addPeriod(d, freq, i) {
  const x = new Date(d + 'T00:00:00Z');
  if (freq === 'monthly') x.setUTCMonth(x.getUTCMonth() + i);
  else x.setUTCDate(x.getUTCDate() + i * (freq === 'weekly' ? 7 : 14));
  return x.toISOString().slice(0, 10);
}
function totals(loan) {
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
    rows.push({ number: i, due_date: addPeriod(loan.start_date, loan.repayment_frequency, i), amount: amt, cumulative_due: cum,
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
    next_due_date: next ? next.due_date : null, end_date: addPeriod(loan.start_date, 'monthly', loan.term_months) };
}
const r2 = x => Math.round(x * 100) / 100;
module.exports = { totals, schedule, enrich, addPeriod };
