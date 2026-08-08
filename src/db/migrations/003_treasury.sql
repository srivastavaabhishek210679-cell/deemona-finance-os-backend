-- ============================================================
-- DEEMONA AI FINANCE OS — Treasury Module
-- Migration: 003_treasury.sql
-- Run in Neon SQL Editor after 002_accounting.sql
-- ============================================================

-- ── Bank Accounts ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  name            TEXT NOT NULL,                  -- e.g. "HDFC Current Account"
  account_number  TEXT NOT NULL,
  ifsc            TEXT,
  bank_name       TEXT NOT NULL,
  branch          TEXT,
  account_type    TEXT DEFAULT 'current',         -- current | savings | overdraft | cc
  currency        TEXT DEFAULT 'INR',
  opening_balance NUMERIC(18,2) DEFAULT 0,
  current_balance NUMERIC(18,2) DEFAULT 0,
  is_active       BOOLEAN DEFAULT TRUE,
  is_primary      BOOLEAN DEFAULT FALSE,
  upi_id          TEXT,
  gl_account_id   UUID REFERENCES accounts(id),   -- linked GL account
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_accounts_tenant ON bank_accounts (tenant_id, is_active);

-- ── Bank Transactions ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  bank_account_id UUID NOT NULL REFERENCES bank_accounts(id),
  date            DATE NOT NULL,
  value_date      DATE,
  description     TEXT NOT NULL,
  reference       TEXT,                           -- cheque/UTR/UPI ref
  type            TEXT NOT NULL,                  -- credit | debit
  amount          NUMERIC(18,2) NOT NULL,
  balance_after   NUMERIC(18,2),
  category        TEXT,                           -- salary | vendor_payment | customer_receipt | etc.
  is_reconciled   BOOLEAN DEFAULT FALSE,
  journal_entry_id UUID REFERENCES journal_entries(id),
  vendor_id       UUID REFERENCES vendors(id),
  customer_id     UUID REFERENCES customers(id),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_txn_account_date ON bank_transactions (bank_account_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_bank_txn_tenant ON bank_transactions (tenant_id, date DESC);

-- ── Cash Flow Forecasts ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS cash_flow_forecasts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  forecast_date   DATE NOT NULL,
  category        TEXT NOT NULL,                  -- inflow | outflow
  description     TEXT NOT NULL,
  expected_amount NUMERIC(18,2) NOT NULL,
  actual_amount   NUMERIC(18,2),
  source          TEXT DEFAULT 'manual',          -- manual | ai_predicted | ar_invoice | ap_invoice
  probability     NUMERIC(5,2) DEFAULT 100,       -- % likelihood
  bank_account_id UUID REFERENCES bank_accounts(id),
  ar_invoice_id   UUID REFERENCES ar_invoices(id),
  ap_invoice_id   UUID REFERENCES ap_invoices(id),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cashflow_tenant_date ON cash_flow_forecasts (tenant_id, forecast_date);

-- ── Triggers ──────────────────────────────────────────────────
CREATE TRIGGER trg_bank_accounts_updated_at
  BEFORE UPDATE ON bank_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
