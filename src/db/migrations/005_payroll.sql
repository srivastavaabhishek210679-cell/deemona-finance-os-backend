-- ============================================================
-- DEEMONA AI FINANCE OS — Payroll Module
-- Migration: 005_payroll.sql
-- ============================================================

-- ── Employees ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employees (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  employee_code   TEXT NOT NULL,
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL,
  email           TEXT,
  phone           TEXT,
  designation     TEXT,
  department      TEXT,
  date_of_joining DATE NOT NULL,
  date_of_leaving DATE,
  status          TEXT DEFAULT 'active',          -- active | inactive | terminated
  employment_type TEXT DEFAULT 'full_time',       -- full_time | part_time | contract | intern
  pan             TEXT,
  aadhaar         TEXT,
  uan             TEXT,                           -- PF Universal Account Number
  esic_number     TEXT,
  bank_account    TEXT,
  bank_name       TEXT,
  ifsc            TEXT,
  basic_salary    NUMERIC(12,2) NOT NULL DEFAULT 0,
  hra             NUMERIC(12,2) DEFAULT 0,
  special_allowance NUMERIC(12,2) DEFAULT 0,
  other_allowances NUMERIC(12,2) DEFAULT 0,
  pf_applicable   BOOLEAN DEFAULT TRUE,
  esic_applicable BOOLEAN DEFAULT FALSE,
  tds_applicable  BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, employee_code)
);

CREATE INDEX IF NOT EXISTS idx_employees_tenant ON employees (tenant_id, status, department);

-- ── Payroll Runs ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payroll_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  month           INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  year            INT NOT NULL,
  status          TEXT DEFAULT 'draft',           -- draft | processing | approved | paid | cancelled
  total_employees INT DEFAULT 0,
  total_gross     NUMERIC(14,2) DEFAULT 0,
  total_deductions NUMERIC(14,2) DEFAULT 0,
  total_net       NUMERIC(14,2) DEFAULT 0,
  total_employer_pf NUMERIC(14,2) DEFAULT 0,
  total_tds       NUMERIC(14,2) DEFAULT 0,
  approved_by     UUID,
  approved_at     TIMESTAMPTZ,
  paid_at         TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, month, year)
);

CREATE INDEX IF NOT EXISTS idx_payroll_runs_tenant ON payroll_runs (tenant_id, year DESC, month DESC);

-- ── Payslips ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payslips (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  payroll_run_id  UUID NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id     UUID NOT NULL REFERENCES employees(id),
  month           INT NOT NULL,
  year            INT NOT NULL,

  -- Earnings
  basic_salary    NUMERIC(12,2) DEFAULT 0,
  hra             NUMERIC(12,2) DEFAULT 0,
  special_allowance NUMERIC(12,2) DEFAULT 0,
  other_allowances NUMERIC(12,2) DEFAULT 0,
  overtime        NUMERIC(12,2) DEFAULT 0,
  bonus           NUMERIC(12,2) DEFAULT 0,
  gross_salary    NUMERIC(12,2) DEFAULT 0,

  -- Deductions
  pf_employee     NUMERIC(12,2) DEFAULT 0,        -- 12% of basic
  pf_employer     NUMERIC(12,2) DEFAULT 0,        -- 12% of basic (employer contribution)
  esic_employee   NUMERIC(12,2) DEFAULT 0,        -- 0.75% of gross
  esic_employer   NUMERIC(12,2) DEFAULT 0,        -- 3.25% of gross
  tds             NUMERIC(12,2) DEFAULT 0,
  professional_tax NUMERIC(12,2) DEFAULT 0,
  loan_deduction  NUMERIC(12,2) DEFAULT 0,
  other_deductions NUMERIC(12,2) DEFAULT 0,
  total_deductions NUMERIC(12,2) DEFAULT 0,

  -- Net
  net_salary      NUMERIC(12,2) DEFAULT 0,
  payment_status  TEXT DEFAULT 'pending',         -- pending | paid | failed
  payment_date    DATE,
  payment_ref     TEXT,

  working_days    INT DEFAULT 26,
  days_present    INT DEFAULT 26,
  days_absent     INT DEFAULT 0,
  leaves_taken    INT DEFAULT 0,

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (payroll_run_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_payslips_run ON payslips (payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_payslips_employee ON payslips (employee_id, year DESC, month DESC);

-- ── Triggers ──────────────────────────────────────────────────
CREATE TRIGGER trg_employees_updated_at
  BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_payroll_runs_updated_at
  BEFORE UPDATE ON payroll_runs FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_payslips_updated_at
  BEFORE UPDATE ON payslips FOR EACH ROW EXECUTE FUNCTION update_updated_at();
