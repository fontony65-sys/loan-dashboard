-- Short-term flat-fee model: term in days, interest is a whole-loan charge, 1 (lump sum) or N equal installments.
-- Existing loans keep term_days NULL and are computed with the legacy annual/monthly model, so their totals are unchanged.
ALTER TABLE loans ADD COLUMN term_days INTEGER CHECK (term_days IS NULL OR term_days > 0);
ALTER TABLE loans ADD COLUMN interest_amount REAL CHECK (interest_amount IS NULL OR interest_amount >= 0);
ALTER TABLE loans ADD COLUMN installments INTEGER NOT NULL DEFAULT 1 CHECK (installments >= 1);
