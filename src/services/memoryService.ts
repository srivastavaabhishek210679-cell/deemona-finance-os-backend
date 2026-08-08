// ============================================================
// Deemona AI Finance OS — Finance Memory Service
// File: services/memoryService.ts
// Drop into: deemona-api/src/services/memoryService.ts
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import { Pool } from 'pg';

// ── Types ────────────────────────────────────────────────────

export type MemoryType =
  | 'decision' | 'approval' | 'rejection' | 'anomaly'
  | 'recommendation' | 'policy_change' | 'vendor_event'
  | 'transaction' | 'alert' | 'audit_comment'
  | 'ai_insight' | 'contract_event' | 'compliance_event'
  | 'simulation_result';

export type EntityType =
  | 'vendor' | 'customer' | 'invoice' | 'transaction'
  | 'budget' | 'employee' | 'contract' | 'project'
  | 'user' | 'policy' | 'account' | 'payment';

export type ActorType = 'user' | 'agent' | 'system' | 'integration';

export type Module =
  | 'accounting' | 'treasury' | 'procurement' | 'payroll'
  | 'tax' | 'compliance' | 'crm' | 'inventory'
  | 'assets' | 'projects' | 'expenses' | 'budgeting';

export interface WriteMemoryInput {
  tenantId: string;
  memoryType: MemoryType;
  entityType: EntityType;
  entityId?: string;
  entityRef?: string;
  title: string;
  summary: string;
  detail?: Record<string, unknown>;
  actorUserId?: string;
  actorName?: string;
  actorType?: ActorType;
  amount?: number;
  currency?: string;
  module?: Module;
  tags?: string[];
  importance?: 1 | 2 | 3 | 4 | 5;
  workflowId?: string;
  relatedMemoryIds?: number[];
  conversationId?: string;
}

export interface MemorySearchOptions {
  tenantId: string;
  query: string;
  limit?: number;
  module?: Module;
  memoryType?: MemoryType;
  entityType?: EntityType;
  entityId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  minImportance?: number;
  searchMode?: 'semantic' | 'keyword' | 'hybrid';
}

export interface MemoryEntry {
  id: number;
  tenantId: string;
  memoryType: MemoryType;
  entityType: EntityType;
  entityId?: string;
  entityRef?: string;
  title: string;
  summary: string;
  detail: Record<string, unknown>;
  actorName: string;
  actorType: ActorType;
  amount?: number;
  currency: string;
  module?: Module;
  tags: string[];
  importance: number;
  isPinned: boolean;
  createdAt: Date;
  similarityScore?: number;
}

export interface EntityProfile {
  entityType: string;
  entityId: string;
  entityName?: string;
  aiSummary?: string;
  riskScore: number;
  trustScore: number;
  totalTransactions: number;
  totalAmount: number;
  rejectionCount: number;
  approvalCount: number;
  anomalyCount: number;
  lastMemoryAt?: Date;
  recentMemories?: MemoryEntry[];
}

// ── Embedding helper ─────────────────────────────────────────
// Uses Anthropic's embeddings if available, or falls back to a
// simple text hash approach for development without the API.

async function generateEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  // Anthropic doesn't have a dedicated embeddings endpoint yet;
  // use OpenAI embeddings if available, or voyage-ai (Anthropic-aligned).
  // This is designed to be swappable. Current: OpenAI text-embedding-3-small.
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return null;

  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: text.slice(0, 8000), // token limit safety
        dimensions: 1536,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

// Text to embed: combine title + summary + key detail fields
function buildEmbeddingText(input: WriteMemoryInput): string {
  const parts = [
    input.title,
    input.summary,
    input.entityRef ? `Entity: ${input.entityRef}` : '',
    input.module ? `Module: ${input.module}` : '',
    input.tags?.length ? `Tags: ${input.tags.join(', ')}` : '',
    input.amount ? `Amount: ${input.currency ?? 'INR'} ${input.amount}` : '',
    input.detail ? JSON.stringify(input.detail).slice(0, 500) : '',
  ];
  return parts.filter(Boolean).join('\n');
}

// ── MemoryService class ──────────────────────────────────────

export class MemoryService {
  private pool: Pool;
  private anthropic: Anthropic;

  constructor(pool: Pool) {
    this.pool = pool;
    this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  // ── WRITE ────────────────────────────────────────────────

  /**
   * Write a new memory entry. Embedding is generated synchronously
   * if possible, otherwise queued for background processing.
   * Returns the new memory ID.
   */
  async write(input: WriteMemoryInput): Promise<number> {
    const client = await this.pool.connect();
    try {
      // Generate embedding (may be null if no API key configured)
      const embeddingText = buildEmbeddingText(input);
      const embedding = await generateEmbedding(embeddingText);

      const result = await client.query<{ id: number }>(
        `SELECT write_memory(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17
        ) AS id`,
        [
          input.tenantId,
          input.memoryType,
          input.entityType,
          input.entityId ?? null,
          input.entityRef ?? null,
          input.title,
          input.summary,
          JSON.stringify(input.detail ?? {}),
          input.actorUserId ?? null,
          input.actorName ?? 'System',
          input.actorType ?? 'system',
          input.amount ?? null,
          input.currency ?? 'INR',
          input.module ?? null,
          input.tags ?? [],
          input.importance ?? 3,
          input.workflowId ?? null,
        ]
      );

      const memoryId = result.rows[0].id;

      // If we have an embedding, write it directly (skip queue)
      if (embedding) {
        await client.query(
          `UPDATE finance_memory SET embedding = $1 WHERE id = $2`,
          [`[${embedding.join(',')}]`, memoryId]
        );
        await client.query(
          `UPDATE finance_memory_embeddings_queue
           SET status = 'done', processed_at = NOW()
           WHERE memory_id = $1`,
          [memoryId]
        );
      }

      // Write related memory links
      if (input.relatedMemoryIds?.length) {
        await client.query(
          `UPDATE finance_memory
           SET related_memory_ids = $1
           WHERE id = $2`,
          [input.relatedMemoryIds, memoryId]
        );
      }

      return memoryId;
    } finally {
      client.release();
    }
  }

  // ── SEARCH ───────────────────────────────────────────────

  /**
   * Hybrid search: semantic (vector cosine) + keyword (FTS).
   * Returns results ranked by a combined score.
   */
  async search(options: MemorySearchOptions): Promise<MemoryEntry[]> {
    const {
      tenantId, query, limit = 10, module, memoryType,
      entityType, entityId, dateFrom, dateTo,
      minImportance = 1, searchMode = 'hybrid',
    } = options;

    const client = await this.pool.connect();
    try {
      // Build WHERE clauses
      const filters: string[] = ['tenant_id = $1', 'is_archived = FALSE'];
      const params: unknown[] = [tenantId];
      let pIdx = 2;

      if (module)        { filters.push(`module = $${pIdx++}`);       params.push(module); }
      if (memoryType)    { filters.push(`memory_type = $${pIdx++}`);  params.push(memoryType); }
      if (entityType)    { filters.push(`entity_type = $${pIdx++}`);  params.push(entityType); }
      if (entityId)      { filters.push(`entity_id = $${pIdx++}`);    params.push(entityId); }
      if (dateFrom)      { filters.push(`created_at >= $${pIdx++}`);  params.push(dateFrom); }
      if (dateTo)        { filters.push(`created_at <= $${pIdx++}`);  params.push(dateTo); }
      if (minImportance > 1) { filters.push(`importance >= $${pIdx++}`); params.push(minImportance); }

      const whereClause = filters.join(' AND ');

      let rows: MemoryEntry[] = [];

      // ── Semantic search ──────────────────────────────────
      if (searchMode !== 'keyword') {
        const embedding = await generateEmbedding(query);
        if (embedding) {
          const semResult = await client.query(
            `SELECT
               id, tenant_id, memory_type, entity_type, entity_id, entity_ref,
               title, summary, detail, actor_name, actor_type,
               amount, currency, module, tags, importance, is_pinned, created_at,
               1 - (embedding <=> $${pIdx}::vector) AS similarity_score
             FROM finance_memory
             WHERE ${whereClause}
               AND embedding IS NOT NULL
             ORDER BY embedding <=> $${pIdx}::vector
             LIMIT $${pIdx + 1}`,
            [...params, `[${embedding.join(',')}]`, limit * 2]
          );
          rows = semResult.rows.map(this.mapRow);
        }
      }

      // ── Keyword search (FTS) ─────────────────────────────
      if (searchMode !== 'semantic') {
        const kwResult = await client.query(
          `SELECT
             id, tenant_id, memory_type, entity_type, entity_id, entity_ref,
             title, summary, detail, actor_name, actor_type,
             amount, currency, module, tags, importance, is_pinned, created_at,
             ts_rank(
               to_tsvector('english', title || ' ' || summary),
               plainto_tsquery('english', $${pIdx})
             ) AS similarity_score
           FROM finance_memory
           WHERE ${whereClause}
             AND to_tsvector('english', title || ' ' || summary)
                 @@ plainto_tsquery('english', $${pIdx})
           ORDER BY similarity_score DESC, importance DESC, created_at DESC
           LIMIT $${pIdx + 1}`,
          [...params, query, limit * 2]
        );
        const kwRows = kwResult.rows.map(this.mapRow);

        // Merge: deduplicate by id, rank by highest score
        const seen = new Set(rows.map(r => r.id));
        for (const row of kwRows) {
          if (!seen.has(row.id)) rows.push(row);
        }
      }

      // If no embedding / no results, fall back to recency
      if (!rows.length) {
        const fallbackResult = await client.query(
          `SELECT
             id, tenant_id, memory_type, entity_type, entity_id, entity_ref,
             title, summary, detail, actor_name, actor_type,
             amount, currency, module, tags, importance, is_pinned, created_at,
             NULL::float AS similarity_score
           FROM finance_memory
           WHERE ${whereClause}
           ORDER BY is_pinned DESC, importance DESC, created_at DESC
           LIMIT $${pIdx + 1}`,
          [...params, limit]
        );
        rows = fallbackResult.rows.map(this.mapRow);
      }

      // Sort: pinned first, then by score, then by importance, then by recency
      rows.sort((a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        const scoreA = a.similarityScore ?? 0;
        const scoreB = b.similarityScore ?? 0;
        if (Math.abs(scoreA - scoreB) > 0.01) return scoreB - scoreA;
        return b.importance - a.importance;
      });

      return rows.slice(0, limit);
    } finally {
      client.release();
    }
  }

  // ── ASK (AI-powered retrieval with narrative answer) ─────

  /**
   * The core "Why did we reject Vendor X?" capability.
   * Searches memory, then asks Claude to synthesize an answer.
   */
  async ask(tenantId: string, question: string, conversationHistory?: Array<{role: 'user' | 'assistant', content: string}>): Promise<{
    answer: string;
    sources: MemoryEntry[];
    confidence: 'high' | 'medium' | 'low';
  }> {
    // Retrieve relevant memories
    const memories = await this.search({
      tenantId,
      query: question,
      limit: 12,
      searchMode: 'hybrid',
    });

    if (!memories.length) {
      return {
        answer: 'I could not find any relevant records in Finance Memory for this question. The event may predate the memory system, or no relevant context has been recorded yet.',
        sources: [],
        confidence: 'low',
      };
    }

    // Format memories for Claude
    const memoryContext = memories.map((m, i) =>
      `[Memory ${i + 1}] ${m.createdAt.toLocaleDateString('en-IN')} | ${m.memoryType.toUpperCase()} | ${m.entityRef ?? m.entityType}
Title: ${m.title}
Summary: ${m.summary}
Actor: ${m.actorName} (${m.actorType})
${m.amount ? `Amount: ${m.currency} ${m.amount.toLocaleString('en-IN')}` : ''}
${m.tags.length ? `Tags: ${m.tags.join(', ')}` : ''}
${Object.keys(m.detail).length ? `Detail: ${JSON.stringify(m.detail)}` : ''}`
    ).join('\n\n---\n\n');

    const systemPrompt = `You are the Finance Memory Intelligence layer of Deemona AI Finance OS.
You have access to a structured record of all significant financial events, decisions, approvals, rejections, anomalies, and AI recommendations for this organization.

Your job is to answer questions about past financial history with precision and supporting evidence.
Always cite the specific memory entries that inform your answer.
If you are uncertain, say so explicitly and give a confidence level.
Be concise but complete. Format amounts in Indian numbering system (lakhs, crores).
Do not fabricate information not present in the memories.`;

    const userMessage = `Finance Memory Context:
${memoryContext}

---

Question: ${question}

Answer based strictly on the memory context above. Cite specific memory entries by number [Memory N]. End with a confidence level: HIGH / MEDIUM / LOW and a brief reason.`;

    const messages: Array<{role: 'user' | 'assistant', content: string}> = [
      ...(conversationHistory ?? []),
      { role: 'user', content: userMessage },
    ];

    const response = await this.anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    const answer = response.content[0].type === 'text' ? response.content[0].text : '';

    // Parse confidence from response
    const confMatch = answer.match(/\b(HIGH|MEDIUM|LOW)\b/i);
    const confidence = (confMatch?.[1]?.toLowerCase() ?? 'medium') as 'high' | 'medium' | 'low';

    return { answer, sources: memories, confidence };
  }

  // ── ENTITY PROFILE ───────────────────────────────────────

  async getEntityProfile(tenantId: string, entityType: EntityType, entityId: string): Promise<EntityProfile | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT * FROM finance_memory_entity_profiles
         WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3`,
        [tenantId, entityType, entityId]
      );
      if (!result.rows.length) return null;

      const profile = result.rows[0];

      // Get recent memories for this entity
      const memResult = await client.query(
        `SELECT id, tenant_id, memory_type, entity_type, entity_id, entity_ref,
                title, summary, detail, actor_name, actor_type,
                amount, currency, module, tags, importance, is_pinned, created_at,
                NULL::float AS similarity_score
         FROM finance_memory
         WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3
           AND is_archived = FALSE
         ORDER BY importance DESC, created_at DESC
         LIMIT 5`,
        [tenantId, entityType, entityId]
      );

      return {
        entityType: profile.entity_type,
        entityId: profile.entity_id,
        entityName: profile.entity_name,
        aiSummary: profile.ai_summary,
        riskScore: profile.risk_score,
        trustScore: profile.trust_score,
        totalTransactions: profile.total_transactions,
        totalAmount: parseFloat(profile.total_amount),
        rejectionCount: profile.rejection_count,
        approvalCount: profile.approval_count,
        anomalyCount: profile.anomaly_count,
        lastMemoryAt: profile.last_memory_at,
        recentMemories: memResult.rows.map(this.mapRow),
      };
    } finally {
      client.release();
    }
  }

  /**
   * Regenerate the AI summary for an entity profile.
   * Run this as a background job periodically.
   */
  async refreshEntityProfile(tenantId: string, entityType: EntityType, entityId: string): Promise<void> {
    const memories = await this.search({
      tenantId, query: entityId, entityType, entityId,
      limit: 20, searchMode: 'keyword',
    });
    if (!memories.length) return;

    const context = memories.map(m =>
      `${m.createdAt.toLocaleDateString('en-IN')}: [${m.memoryType}] ${m.title} — ${m.summary}`
    ).join('\n');

    const response = await this.anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: `Based on the following financial history for ${entityType} "${entityId}", write a 2-3 sentence summary capturing key patterns, risks, and notable events. Be factual and concise.\n\n${context}`,
      }],
    });

    const summary = response.content[0].type === 'text' ? response.content[0].text : '';

    // Calculate risk score heuristically from memory stats
    const riskScore = Math.min(100, Math.round(
      (memories.filter(m => m.memoryType === 'anomaly').length * 20) +
      (memories.filter(m => m.memoryType === 'rejection').length * 10) +
      (memories.filter(m => m.tags.includes('fraud')).length * 30)
    ));

    await this.pool.query(
      `UPDATE finance_memory_entity_profiles
       SET ai_summary = $1, risk_score = $2, updated_at = NOW()
       WHERE tenant_id = $3 AND entity_type = $4 AND entity_id = $5`,
      [summary, riskScore, tenantId, entityType, entityId]
    );
  }

  // ── GET RECENT ───────────────────────────────────────────

  async getRecent(tenantId: string, options: {
    limit?: number;
    module?: Module;
    memoryType?: MemoryType;
    minImportance?: number;
  } = {}): Promise<MemoryEntry[]> {
    const { limit = 20, module, memoryType, minImportance = 1 } = options;
    const filters = ['tenant_id = $1', 'is_archived = FALSE', 'importance >= $2'];
    const params: unknown[] = [tenantId, minImportance];
    let pIdx = 3;

    if (module)     { filters.push(`module = $${pIdx++}`);      params.push(module); }
    if (memoryType) { filters.push(`memory_type = $${pIdx++}`); params.push(memoryType); }

    const result = await this.pool.query(
      `SELECT id, tenant_id, memory_type, entity_type, entity_id, entity_ref,
              title, summary, detail, actor_name, actor_type,
              amount, currency, module, tags, importance, is_pinned, created_at,
              NULL::float AS similarity_score
       FROM finance_memory
       WHERE ${filters.join(' AND ')}
       ORDER BY is_pinned DESC, importance DESC, created_at DESC
       LIMIT $${pIdx}`,
      [...params, limit]
    );

    return result.rows.map(this.mapRow);
  }

  // ── PROCESS EMBEDDING QUEUE ──────────────────────────────

  /**
   * Run by a cron job every 30 seconds.
   * Processes pending embedding queue entries.
   */
  async processEmbeddingQueue(batchSize = 10): Promise<number> {
    const client = await this.pool.connect();
    let processed = 0;
    try {
      // Claim batch
      const batch = await client.query<{ id: number; memory_id: number }>(
        `UPDATE finance_memory_embeddings_queue
         SET status = 'processing', attempts = attempts + 1
         WHERE id IN (
           SELECT id FROM finance_memory_embeddings_queue
           WHERE status IN ('pending', 'failed') AND attempts < 3
           ORDER BY created_at ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, memory_id`,
        [batchSize]
      );

      for (const row of batch.rows) {
        try {
          // Fetch the memory text
          const memResult = await client.query(
            `SELECT title, summary, entity_ref, module, tags, amount, currency, detail
             FROM finance_memory WHERE id = $1`,
            [row.memory_id]
          );
          if (!memResult.rows.length) continue;

          const m = memResult.rows[0];
          const text = [
            m.title, m.summary,
            m.entity_ref ? `Entity: ${m.entity_ref}` : '',
            m.module ? `Module: ${m.module}` : '',
            m.tags?.length ? `Tags: ${m.tags.join(', ')}` : '',
          ].filter(Boolean).join('\n');

          const embedding = await generateEmbedding(text);
          if (embedding) {
            await client.query(
              `UPDATE finance_memory SET embedding = $1 WHERE id = $2`,
              [`[${embedding.join(',')}]`, row.memory_id]
            );
          }

          await client.query(
            `UPDATE finance_memory_embeddings_queue
             SET status = 'done', processed_at = NOW()
             WHERE id = $1`,
            [row.id]
          );
          processed++;
        } catch (err) {
          await client.query(
            `UPDATE finance_memory_embeddings_queue
             SET status = 'failed', error = $1
             WHERE id = $2`,
            [String(err), row.id]
          );
        }
      }
    } finally {
      client.release();
    }
    return processed;
  }

  // ── PRIVATE: row mapper ──────────────────────────────────

  private mapRow = (row: Record<string, unknown>): MemoryEntry => ({
    id: row.id as number,
    tenantId: row.tenant_id as string,
    memoryType: row.memory_type as MemoryType,
    entityType: row.entity_type as EntityType,
    entityId: row.entity_id as string | undefined,
    entityRef: row.entity_ref as string | undefined,
    title: row.title as string,
    summary: row.summary as string,
    detail: (row.detail ?? {}) as Record<string, unknown>,
    actorName: row.actor_name as string,
    actorType: row.actor_type as ActorType,
    amount: row.amount ? parseFloat(String(row.amount)) : undefined,
    currency: (row.currency ?? 'INR') as string,
    module: row.module as Module | undefined,
    tags: (row.tags ?? []) as string[],
    importance: row.importance as number,
    isPinned: row.is_pinned as boolean,
    createdAt: new Date(row.created_at as string),
    similarityScore: row.similarity_score as number | undefined,
  });
}

// ── Singleton factory ────────────────────────────────────────

let _memoryService: MemoryService | null = null;

export function getMemoryService(pool: Pool): MemoryService {
  if (!_memoryService) _memoryService = new MemoryService(pool);
  return _memoryService;
}
