-- ============================================================
-- DEEMONA AI FINANCE OS — Procurement Module
-- Migration: 004_procurement.sql
-- ============================================================

-- ── Purchase Orders ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  po_number       TEXT NOT NULL,
  vendor_id       UUID REFERENCES vendors(id),
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  expected_date   DATE,
  status          TEXT DEFAULT 'draft',
  -- draft | submitted | approved | partially_received | received | cancelled
  priority        TEXT DEFAULT 'normal',          -- low | normal | high | urgent
  department      TEXT,
  requested_by    UUID,
  approved_by     UUID,
  approved_at     TIMESTAMPTZ,
  rejected_by     UUID,
  rejection_reason TEXT,
  subtotal        NUMERIC(18,2) DEFAULT 0,
  tax_amount      NUMERIC(18,2) DEFAULT 0,
  total_amount    NUMERIC(18,2) DEFAULT 0,
  notes           TEXT,
  ai_recommendation TEXT,                         -- AI vendor/price recommendation
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, po_number)
);

CREATE INDEX IF NOT EXISTS idx_po_tenant_status ON purchase_orders (tenant_id, status, date DESC);
CREATE INDEX IF NOT EXISTS idx_po_vendor ON purchase_orders (vendor_id);

-- ── PO Line Items ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS po_lines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id           UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  description     TEXT NOT NULL,
  quantity        NUMERIC(10,3) NOT NULL DEFAULT 1,
  unit            TEXT DEFAULT 'pcs',
  unit_price      NUMERIC(18,2) NOT NULL,
  amount          NUMERIC(18,2) NOT NULL,
  received_qty    NUMERIC(10,3) DEFAULT 0,
  account_id      UUID REFERENCES accounts(id),
  hsn_sac         TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_po_lines_po ON po_lines (po_id);

-- ── PO Approval History ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS po_approvals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id           UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  action          TEXT NOT NULL,                  -- submitted | approved | rejected | revised
  actor_id        UUID,
  actor_name      TEXT,
  comment         TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Triggers ──────────────────────────────────────────────────
CREATE TRIGGER trg_po_updated_at
  BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
