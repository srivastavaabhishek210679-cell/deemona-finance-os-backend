// ============================================================
// Deemona AI Finance OS — CFO Setup data model (Step 2)
// Adds the data the agent was missing: business-unit / region / product
// dimensions, default tags for customers & vendors, KPI targets (plan),
// and saved forecasts. All tables are created on demand; the only change
// to existing tables is three nullable tag columns on ar_invoices/ap_invoices.
// ============================================================
import { Pool } from 'pg';

export const DIM_KINDS = ['business_unit', 'region', 'product'] as const;
export type DimKind = typeof DIM_KINDS[number];
export const DIM_COLUMN: Record<DimKind, string> = { business_unit: 'business_unit_id', region: 'region_id', product: 'product_id' };

// Metrics a target can be set for. `dims` = can also be set per business unit / region / product
// (only possible where the underlying invoices carry a tag).
export const TARGET_METRICS: Record<string, { label: string; higher_is_better: boolean; dims: boolean }> = {
  revenue:      { label: 'Revenue (pre-tax invoiced)', higher_is_better: true,  dims: true  },
  ebitda:       { label: 'EBITDA',                     higher_is_better: true,  dims: false },
  cash_in:      { label: 'Cash received',              higher_is_better: true,  dims: false },
  vendor_costs: { label: 'Vendor costs (AP invoiced)', higher_is_better: false, dims: true  },
  payroll:      { label: 'Payroll (gross)',            higher_is_better: false, dims: false },
  cash_out:     { label: 'Cash paid out',              higher_is_better: false, dims: false },
};
export const FORECAST_METRICS = ['revenue', 'cash_in', 'cash_out'] as const;
export const PERIOD_TYPES = ['month', 'quarter', 'year'] as const;
export type PeriodType = typeof PERIOD_TYPES[number];

let ready = false;
export async function ensureCfoSetupTables(pool: Pool): Promise<void> {
  if (ready) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cfo_dimensions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('business_unit','region','product')),
      name TEXT NOT NULL,
      code TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (tenant_id, kind, name)
    );
    CREATE TABLE IF NOT EXISTS cfo_entity_defaults (
      tenant_id TEXT NOT NULL,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('customer','vendor')),
      entity_id TEXT NOT NULL,
      business_unit_id UUID, region_id UUID, product_id UUID,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (tenant_id, entity_type, entity_id)
    );
    CREATE TABLE IF NOT EXISTS cfo_targets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      period_type TEXT NOT NULL CHECK (period_type IN ('month','quarter','year')),
      period_start DATE NOT NULL,
      dimension_kind TEXT,
      dimension_id UUID,
      target_value NUMERIC NOT NULL,
      notes TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS cfo_targets_uq ON cfo_targets
      (tenant_id, metric, period_type, period_start, COALESCE(dimension_id, '00000000-0000-0000-0000-000000000000'::uuid));
    CREATE TABLE IF NOT EXISTS cfo_forecasts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      period_start DATE NOT NULL,
      forecast_value NUMERIC NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('system','manual')),
      method TEXT,
      made_on DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (tenant_id, metric, period_start, source)
    );
    ALTER TABLE ar_invoices ADD COLUMN IF NOT EXISTS business_unit_id UUID, ADD COLUMN IF NOT EXISTS region_id UUID, ADD COLUMN IF NOT EXISTS product_id UUID;
    ALTER TABLE ap_invoices ADD COLUMN IF NOT EXISTS business_unit_id UUID, ADD COLUMN IF NOT EXISTS region_id UUID, ADD COLUMN IF NOT EXISTS product_id UUID;
  `);
  ready = true;
}

// ── date helpers (string based, timezone-safe) ───────────────
export const istTodayYmd = (): string =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });   // YYYY-MM-DD
const utc = (s: string): Date => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fmt = (d: Date): string => d.toISOString().slice(0, 10);
export const isYmd = (s: any): boolean => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(utc(s).getTime());

/** Last day (inclusive) of a target period. */
export function periodEnd(type: PeriodType, start: string): string {
  const d = utc(start); const months = type === 'month' ? 1 : type === 'quarter' ? 3 : 12;
  return fmt(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 0)));
}

/** Is `start` a valid first day for the period type? (Indian fiscal year: Apr–Mar; quarters start Apr/Jul/Oct/Jan.) */
export function isAlignedStart(type: PeriodType, start: string): boolean {
  if (!isYmd(start)) return false;
  const d = utc(start); if (d.getUTCDate() !== 1) return false;
  const m = d.getUTCMonth();
  return type === 'month' ? true : type === 'quarter' ? m % 3 === 0 : m === 3;
}

/** Start of the period containing `today`, shifted by `offset` periods (0 = current, -1 = previous). */
export function currentPeriodStart(type: PeriodType, today: string, offset = 0): string {
  const d = utc(today); const y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (type === 'month') return fmt(new Date(Date.UTC(y, m + offset, 1)));
  if (type === 'quarter') return fmt(new Date(Date.UTC(y, Math.floor(m / 3) * 3 + offset * 3, 1)));
  const fy = m >= 3 ? y : y - 1;
  return fmt(new Date(Date.UTC(fy + offset, 3, 1)));
}

export const daysBetweenInclusive = (a: string, b: string): number => Math.round((utc(b).getTime() - utc(a).getTime()) / 86400000) + 1;
export const addMonthsYmd = (s: string, n: number): string => { const d = utc(s); return fmt(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))); };
