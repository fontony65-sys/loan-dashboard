CREATE TABLE IF NOT EXISTS borrowers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  id_number TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  borrower_id INTEGER NOT NULL REFERENCES borrowers(id) ON DELETE RESTRICT,
  principal REAL NOT NULL CHECK (principal > 0),
  interest_rate REAL NOT NULL CHECK (interest_rate >= 0), -- annual %, flat
  term_months INTEGER NOT NULL CHECK (term_months > 0),
  start_date TEXT NOT NULL,
  repayment_frequency TEXT NOT NULL DEFAULT 'monthly' CHECK (repayment_frequency IN ('weekly','biweekly','monthly')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paid','overdue','defaulted')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS repayments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  amount REAL NOT NULL CHECK (amount > 0),
  date TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash','mobile_money','bank_transfer','cheque','other')),
  reference TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_loans_borrower ON loans(borrower_id);
CREATE INDEX IF NOT EXISTS idx_repayments_loan ON repayments(loan_id);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
