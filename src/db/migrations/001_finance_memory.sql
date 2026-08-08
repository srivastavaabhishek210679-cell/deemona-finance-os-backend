-- ============================================================
-- DEEMONA AI FINANCE OS — Finance Memory Layer
-- Schema: 001_finance_memory.sql
-- Run this on your Neon DB (neondb)
-- Requires: pgvector extension (available on Neon by default)
-- ============================================================

-- Enable pgvector for semantic search
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm; -- for fast text search

-- ============================================================
-- CORE: finance_memory
-- The central table. Every significant event in the OS is
-- written here as a memory entry with a vector embedding.
-- ============================================================
CREATE TABLE IF NOT EXISTS finance_memory (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL,                          -- org isolation

  -- Classification
  memory_type       TEXT NOT NULL,                          -- see MEMORY_TYPES below
  entity_type       TEXT NOT NULL,                          -- vendor | invoice | transaction | budget | employee | contract | project | user
  entity_id         TEXT,                                   -- the ID of the related record (invoice_id, vendor_id, etc.)
  entity_ref        TEXT,                                   -- human-readable: "Vendor: Tata Consultancy", "Invoice #INV-2024-001"

  -- The memory itself
  title             TEXT NOT NULL,                          -- short headline: "Vendor X rejected — fraud flag"
  summary           TEXT NOT NULL,                          -- 1-3 sentence human-readable summary
  detail            JSONB DEFAULT '{}',                     -- full structured context (amounts, reasons, actors, etc.)

  -- AI vector embedding (text-embedding-3-small = 1536 dims)
  -- We use 1536 for OpenAI or can use a smaller model; adjust dim if needed
  embedding         vector(1536),

  -- Who did this / who was involved
  actor_user_id     UUID,                                   -- the user who triggered this (null = system/agent)
  actor_name        TEXT,                                   -- "Priya Sharma", "Accounting Agent", "System"
  actor_type        TEXT DEFAULT 'user',                    -- user | agent | system | integration

  -- Financial context (quick-filter columns — also stored in detail JSONB)
  amount            NUMERIC(18,2),
  currency          TEXT DEFAULT 'INR',
  module            TEXT,                                   -- accounting | treasury | procurement | payroll | tax | compliance | crm | inventory | assets | projects | expenses | budgeting
  tags              TEXT[] DEFAULT '{}',                    -- ['fraud', 'vendor', 'approval', 'rejection']

  -- Linking
  related_memory_ids BIGINT[] DEFAULT '{}',                 -- links to other memory entries (e.g. approval follows rejection)
  workflow_id        TEXT,                                   -- links to an automation workflow execution
  conversation_id    TEXT,                                   -- links to a CFO Agent conversation

  -- Lifecycle
  importance        SMALLINT DEFAULT 3 CHECK (importance BETWEEN 1 AND 5), -- 5=critical, 1=routine
  is_pinned         BOOLEAN DEFAULT FALSE,                  -- pinned memories always surfaced
  is_archived       BOOLEAN DEFAULT FALSE,
  expires_at        TIMESTAMPTZ,                            -- null = keep forever; set for temp context

  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- MEMORY_TYPES reference (stored as text for extensibility)
-- ============================================================
-- decision           → A human or AI made a significant decision
-- approval           → Something was approved (invoice, PO, payment, budget)
-- rejection          → Something was rejected, with reason
-- anomaly            → AI detected an anomaly (duplicate, fraud signal, unusual amount)
-- recommendation     → AI made a recommendation (whether acted on or not)
-- policy_change      → A finance policy was updated
-- vendor_event       → Significant vendor interaction (onboard, block, dispute, payment)
-- transaction        → Large or notable financial transaction recorded
-- alert              → System generated an alert (budget breach, cash shortfall, etc.)
-- audit_comment      → Auditor or controller added a comment/note
-- ai_insight         → AI-generated insight from analysis (not a recommendation, just observation)
-- contract_event     → Contract signed, renewed, expired, disputed
-- compliance_event   → Compliance check passed/failed, filing submitted
-- simulation_result  → Digital Twin scenario was run and saved

-- ============================================================
-- INDEXES
-- ============================================================

-- Vector similarity search (cosine) — primary semantic search index
CREATE INDEX IF NOT EXISTS idx_fm_embedding
  ON finance_memory USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Tenant + time (most queries are tenant-scoped and time-ordered)
CREATE INDEX IF NOT EXISTS idx_fm_tenant_created
  ON finance_memory (tenant_id, created_at DESC);

-- Module filtering
CREATE INDEX IF NOT EXISTS idx_fm_tenant_module
  ON finance_memory (tenant_id, module, created_at DESC);

-- Entity lookups ("all memories for Invoice #123")
CREATE INDEX IF NOT EXISTS idx_fm_entity
  ON finance_memory (tenant_id, entity_type, entity_id);

-- Memory type filtering
CREATE INDEX IF NOT EXISTS idx_fm_type
  ON finance_memory (tenant_id, memory_type, created_at DESC);

-- Full-text search on title + summary (fast keyword search)
CREATE INDEX IF NOT EXISTS idx_fm_fts
  ON finance_memory USING gin (to_tsvector('english', title || ' ' || summary));

-- Tags array search
CREATE INDEX IF NOT EXISTS idx_fm_tags
  ON finance_memory USING gin (tags);

-- Importance + pinned (for priority surfacing)
CREATE INDEX IF NOT EXISTS idx_fm_importance
  ON finance_memory (tenant_id, importance DESC, created_at DESC)
  WHERE is_archived = FALSE;

-- ============================================================
-- finance_memory_conversations
-- Stores full CFO Agent / AI Copilot conversation history
-- so the AI can reference past Q&A as memory
-- ============================================================
CREATE TABLE IF NOT EXISTS finance_memory_conversations (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  conversation_id TEXT NOT NULL,                -- UUID string, groups turns together
  user_id         UUID,
  agent_type      TEXT DEFAULT 'cfo_agent',     -- cfo_agent | accounting_agent | treasury_agent etc.

  role            TEXT NOT NULL,                -- 'user' | 'assistant'
  content         TEXT NOT NULL,
  context_snapshot JSONB DEFAULT '{}',          -- snapshot of what data the AI had at this turn

  -- If this turn produced a memory, link it
  generated_memory_id BIGINT REFERENCES finance_memory(id) ON DELETE SET NULL,

  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fmc_conversation
  ON finance_memory_conversations (tenant_id, conversation_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_fmc_agent
  ON finance_memory_conversations (tenant_id, agent_type, created_at DESC);

-- ============================================================
-- finance_memory_embeddings_queue
-- When a new memory is written without an embedding (fast path),
-- it lands here for async embedding by the background worker.
-- ============================================================
CREATE TABLE IF NOT EXISTS finance_memory_embeddings_queue (
  id            BIGSERIAL PRIMARY KEY,
  memory_id     BIGINT NOT NULL REFERENCES finance_memory(id) ON DELETE CASCADE,
  status        TEXT DEFAULT 'pending',   -- pending | processing | done | failed
  attempts      SMALLINT DEFAULT 0,
  error         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  processed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_fmeq_status
  ON finance_memory_embeddings_queue (status, created_at ASC)
  WHERE status IN ('pending', 'failed');

-- ============================================================
-- finance_memory_entity_profiles
-- Aggregated profile per entity (vendor, customer, employee)
-- built from memory entries — like a "memory card" per entity.
-- The AI uses this for instant context without searching.
-- ============================================================
CREATE TABLE IF NOT EXISTS finance_memory_entity_profiles (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  entity_name     TEXT,

  -- AI-generated profile summary (regenerated periodically)
  ai_summary      TEXT,
  risk_score      SMALLINT DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
  trust_score     SMALLINT DEFAULT 50 CHECK (trust_score BETWEEN 0 AND 100),

  -- Key stats
  total_transactions  INT DEFAULT 0,
  total_amount        NUMERIC(18,2) DEFAULT 0,
  rejection_count     INT DEFAULT 0,
  approval_count      INT DEFAULT 0,
  anomaly_count       INT DEFAULT 0,

  last_memory_at  TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (tenant_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_fmep_tenant_entity
  ON finance_memory_entity_profiles (tenant_id, entity_type, risk_score DESC);

-- ============================================================
-- TRIGGERS: auto-update updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_fm_updated_at
  BEFORE UPDATE ON finance_memory
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_fmep_updated_at
  BEFORE UPDATE ON finance_memory_entity_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- FUNCTION: write_memory()
-- Called from application code — handles queue insertion
-- ============================================================
CREATE OR REPLACE FUNCTION write_memory(
  p_tenant_id       UUID,
  p_memory_type     TEXT,
  p_entity_type     TEXT,
  p_entity_id       TEXT,
  p_entity_ref      TEXT,
  p_title           TEXT,
  p_summary         TEXT,
  p_detail          JSONB DEFAULT '{}',
  p_actor_user_id   UUID DEFAULT NULL,
  p_actor_name      TEXT DEFAULT 'System',
  p_actor_type      TEXT DEFAULT 'system',
  p_amount          NUMERIC DEFAULT NULL,
  p_currency        TEXT DEFAULT 'INR',
  p_module          TEXT DEFAULT NULL,
  p_tags            TEXT[] DEFAULT '{}',
  p_importance      SMALLINT DEFAULT 3,
  p_workflow_id     TEXT DEFAULT NULL
)
RETURNS BIGINT AS $$
DECLARE
  v_memory_id BIGINT;
BEGIN
  INSERT INTO finance_memory (
    tenant_id, memory_type, entity_type, entity_id, entity_ref,
    title, summary, detail,
    actor_user_id, actor_name, actor_type,
    amount, currency, module, tags, importance, workflow_id
  ) VALUES (
    p_tenant_id, p_memory_type, p_entity_type, p_entity_id, p_entity_ref,
    p_title, p_summary, p_detail,
    p_actor_user_id, p_actor_name, p_actor_type,
    p_amount, p_currency, p_module, p_tags, p_importance, p_workflow_id
  ) RETURNING id INTO v_memory_id;

  -- Queue for embedding
  INSERT INTO finance_memory_embeddings_queue (memory_id)
  VALUES (v_memory_id);

  -- Upsert entity profile stats
  INSERT INTO finance_memory_entity_profiles (
    tenant_id, entity_type, entity_id, entity_name,
    total_transactions, total_amount,
    rejection_count, approval_count, anomaly_count, last_memory_at
  ) VALUES (
    p_tenant_id, p_entity_type, p_entity_id, p_entity_ref,
    CASE WHEN p_memory_type = 'transaction' THEN 1 ELSE 0 END,
    COALESCE(p_amount, 0),
    CASE WHEN p_memory_type = 'rejection' THEN 1 ELSE 0 END,
    CASE WHEN p_memory_type = 'approval' THEN 1 ELSE 0 END,
    CASE WHEN p_memory_type = 'anomaly' THEN 1 ELSE 0 END,
    NOW()
  )
  ON CONFLICT (tenant_id, entity_type, entity_id) DO UPDATE SET
    total_transactions = finance_memory_entity_profiles.total_transactions +
      CASE WHEN p_memory_type = 'transaction' THEN 1 ELSE 0 END,
    total_amount       = finance_memory_entity_profiles.total_amount + COALESCE(p_amount, 0),
    rejection_count    = finance_memory_entity_profiles.rejection_count +
      CASE WHEN p_memory_type = 'rejection' THEN 1 ELSE 0 END,
    approval_count     = finance_memory_entity_profiles.approval_count +
      CASE WHEN p_memory_type = 'approval' THEN 1 ELSE 0 END,
    anomaly_count      = finance_memory_entity_profiles.anomaly_count +
      CASE WHEN p_memory_type = 'anomaly' THEN 1 ELSE 0 END,
    last_memory_at     = NOW(),
    entity_name        = p_entity_ref;

  RETURN v_memory_id;
END;
$$ LANGUAGE plpgsql;
