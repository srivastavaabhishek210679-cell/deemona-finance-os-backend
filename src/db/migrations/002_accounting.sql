-- ============================================================
-- DEEMONA AI FINANCE OS — Accounting Module
-- Migration: 002_accounting.sql
-- Run in Neon SQL Editor after 001_finance_memory.sql
-- ============================================================

-- ── Chart of Accounts ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  code          TEXT NOT NULL,                    -- e.g. 1001, 2001
  name          TEXT NOT NULL,                    -- e.g. Cash, Accounts Payable
  type          TEXT NOT NULL,                    -- asset | liability | equity | income | expense
  sub_type      TEXT,                             -- current_asset | fixed_asset | etc.
  parent_id     UUID REFERENCES accounts(id),     -- for hierarchical COA
  currency      TEXT DEFAULT 'INR',
  is_active     BOOLEAN DEFAULT TRUE,
  description   TEXT,
  opening_balance NUMERIC(18,2) DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_accounts_tenant ON accounts (tenant_id, type);

-- ── Journal Entries ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS journal_entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  entry_number  TEXT NOT NULL,                    -- JE-2026-0001
  date          DATE NOT NULL,
  description   TEXT NOT NULL,
  reference     TEXT,                             -- invoice no, payment ref, etc.
  status        TEXT DEFAULT 'draft',             -- draft | posted | reversed
  entry_type    TEXT DEFAULT 'manual',            -- manual | system | ai_suggested
  posted_by     UUID,
  posted_at     TIMESTAMPTZ,
  notes         TEXT,
  ai_confidence NUMERIC(5,2),                    -- if AI suggested this entry
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, entry_number)
);

CREATE INDEX IF NOT EXISTS idx_je_tenant_date ON journal_entries (tenant_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_je_status ON journal_entries (tenant_id, status);

-- ── Journal Entry Lines (double-entry) ───────────────────────
CREATE TABLE IF NOT EXISTS journal_entry_lines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id      UUID NOT NULL REFERENCES accounts(id),
  description     TEXT,
  debit           NUMERIC(18,2) DEFAULT 0,
  credit          NUMERIC(18,2) DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jel_entry ON journal_entry_lines (journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_jel_account ON journal_entry_lines (account_id);

-- ── Vendors ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendors (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  name          TEXT NOT NULL,
  code          TEXT,
  gstin         TEXT,                             -- GST number
  pan           TEXT,
  email         TEXT,
  phone         TEXT,
  address       TEXT,
  city          TEXT,
  state         TEXT,
  payment_terms INT DEFAULT 30,                   -- days
  currency      TEXT DEFAULT 'INR',
  bank_account  TEXT,
  ifsc          TEXT,
  is_active     BOOLEAN DEFAULT TRUE,
  is_blocked    BOOLEAN DEFAULT FALSE,
  block_reason  TEXT,
  credit_limit  NUMERIC(18,2),
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendors_tenant ON vendors (tenant_id, is_active);

-- ── AP Invoices (Bills) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS ap_invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  vendor_id       UUID NOT NULL REFERENCES vendors(id),
  invoice_number  TEXT NOT NULL,                  -- vendor's invoice number
  our_reference   TEXT,                           -- internal PO/ref
  date            DATE NOT NULL,
  due_date        DATE NOT NULL,
  status          TEXT DEFAULT 'draft',           -- draft | pending_approval | approved | paid | overdue | rejected
  currency        TEXT DEFAULT 'INR',
  subtotal        NUMERIC(18,2) DEFAULT 0,
  tax_amount      NUMERIC(18,2) DEFAULT 0,
  total_amount    NUMERIC(18,2) DEFAULT 0,
  paid_amount     NUMERIC(18,2) DEFAULT 0,
  balance_due     NUMERIC(18,2) GENERATED ALWAYS AS (total_amount - paid_amount) STORED,
  tax_type        TEXT DEFAULT 'GST',             -- GST | TDS | none
  gst_rate        NUMERIC(5,2),
  notes           TEXT,
  attachment_url  TEXT,
  approved_by     UUID,
  approved_at     TIMESTAMPTZ,
  rejected_by     UUID,
  rejected_at     TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ap_tenant_status ON ap_invoices (tenant_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_ap_vendor ON ap_invoices (vendor_id, status);

-- ── AP Invoice Line Items ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS ap_invoice_lines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ap_invoice_id   UUID NOT NULL REFERENCES ap_invoices(id) ON DELETE CASCADE,
  description     TEXT NOT NULL,
  quantity        NUMERIC(10,3) DEFAULT 1,
  unit_price      NUMERIC(18,2) NOT NULL,
  amount          NUMERIC(18,2) NOT NULL,
  account_id      UUID REFERENCES accounts(id),
  hsn_sac         TEXT,                           -- HSN/SAC code for GST
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Customers ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  name          TEXT NOT NULL,
  code          TEXT,
  gstin         TEXT,
  pan           TEXT,
  email         TEXT,
  phone         TEXT,
  address       TEXT,
  city          TEXT,
  state         TEXT,
  payment_terms INT DEFAULT 30,
  currency      TEXT DEFAULT 'INR',
  credit_limit  NUMERIC(18,2),
  is_active     BOOLEAN DEFAULT TRUE,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customers_tenant ON customers (tenant_id, is_active);

-- ── AR Invoices (Sales) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS ar_invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  customer_id     UUID NOT NULL REFERENCES customers(id),
  invoice_number  TEXT NOT NULL,
  date            DATE NOT NULL,
  due_date        DATE NOT NULL,
  status          TEXT DEFAULT 'draft',           -- draft | sent | partially_paid | paid | overdue | cancelled
  currency        TEXT DEFAULT 'INR',
  subtotal        NUMERIC(18,2) DEFAULT 0,
  tax_amount      NUMERIC(18,2) DEFAULT 0,
  total_amount    NUMERIC(18,2) DEFAULT 0,
  paid_amount     NUMERIC(18,2) DEFAULT 0,
  balance_due     NUMERIC(18,2) GENERATED ALWAYS AS (total_amount - paid_amount) STORED,
  tax_type        TEXT DEFAULT 'GST',
  gst_rate        NUMERIC(5,2),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ar_tenant_status ON ar_invoices (tenant_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_ar_customer ON ar_invoices (customer_id, status);

-- ── AR Invoice Line Items ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS ar_invoice_lines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ar_invoice_id   UUID NOT NULL REFERENCES ar_invoices(id) ON DELETE CASCADE,
  description     TEXT NOT NULL,
  quantity        NUMERIC(10,3) DEFAULT 1,
  unit_price      NUMERIC(18,2) NOT NULL,
  amount          NUMERIC(18,2) NOT NULL,
  account_id      UUID REFERENCES accounts(id),
  hsn_sac         TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Payments ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  type            TEXT NOT NULL,                  -- incoming | outgoing
  reference       TEXT,                           -- cheque no, UTR, UPI ref
  date            DATE NOT NULL,
  amount          NUMERIC(18,2) NOT NULL,
  currency        TEXT DEFAULT 'INR',
  method          TEXT DEFAULT 'bank_transfer',   -- bank_transfer | upi | cheque | cash | neft | rtgs | imps
  status          TEXT DEFAULT 'completed',       -- pending | completed | failed | reversed
  vendor_id       UUID REFERENCES vendors(id),
  customer_id     UUID REFERENCES customers(id),
  ap_invoice_id   UUID REFERENCES ap_invoices(id),
  ar_invoice_id   UUID REFERENCES ar_invoices(id),
  bank_account    TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments (tenant_id, date DESC);

-- ── Auto-increment entry numbers ──────────────────────────────
CREATE TABLE IF NOT EXISTS accounting_counters (
  tenant_id     UUID NOT NULL,
  counter_type  TEXT NOT NULL,                    -- journal_entry | ap_invoice | ar_invoice
  last_number   INT DEFAULT 0,
  PRIMARY KEY (tenant_id, counter_type)
);

CREATE OR REPLACE FUNCTION next_accounting_number(
  p_tenant_id UUID,
  p_type TEXT,
  p_prefix TEXT
) RETURNS TEXT AS $$
DECLARE
  v_num INT;
  v_year TEXT := TO_CHAR(NOW(), 'YYYY');
BEGIN
  INSERT INTO accounting_counters (tenant_id, counter_type, last_number)
  VALUES (p_tenant_id, p_type, 1)
  ON CONFLICT (tenant_id, counter_type)
  DO UPDATE SET last_number = accounting_counters.last_number + 1
  RETURNING last_number INTO v_num;
  RETURN p_prefix || '-' || v_year || '-' || LPAD(v_num::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;

-- ── Updated_at triggers ───────────────────────────────────────
CREATE TRIGGER trg_accounts_updated_at BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_je_updated_at BEFORE UPDATE ON journal_entries FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_vendors_updated_at BEFORE UPDATE ON vendors FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_ap_updated_at BEFORE UPDATE ON ap_invoices FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_customers_updated_at BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_ar_updated_at BEFORE UPDATE ON ar_invoices FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Seed: Default Chart of Accounts (Indian SME standard) ─────
-- These are inserted per-tenant during onboarding, not here.
-- Use the /api/accounting/setup endpoint to seed for a tenant.
