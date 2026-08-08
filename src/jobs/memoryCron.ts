// ============================================================
// Deemona AI Finance OS — Finance Memory Cron Worker
// File: services/memoryCron.ts
// Drop into: deemona-api/src/jobs/memoryCron.ts
// Register in your existing cron job setup (next to the 9 crons)
// ============================================================

import { Pool } from 'pg';
import { getMemoryService } from '../services/memoryService';

/**
 * Job 1: Process embedding queue
 * Runs every 30s. Generates embeddings for any memory entries
 * that were written without one (fast-path writes).
 */
export async function processEmbeddingQueue(pool: Pool): Promise<void> {
  const svc = getMemoryService(pool);
  try {
    const processed = await svc.processEmbeddingQueue(10);
    if (processed > 0) {
      console.log(`[MemoryCron] Embedded ${processed} memory entries`);
    }
  } catch (err) {
    console.error('[MemoryCron] Embedding queue error:', err);
  }
}

/**
 * Job 2: Refresh entity profiles
 * Runs every 6 hours. Regenerates AI summaries for the most
 * active entities so the profiles stay current.
 */
export async function refreshEntityProfiles(pool: Pool): Promise<void> {
  const svc = getMemoryService(pool);
  try {
    // Find entities with recent memory activity that need refreshing
    const result = await pool.query<{
      tenant_id: string;
      entity_type: string;
      entity_id: string;
    }>(
      `SELECT DISTINCT ON (tenant_id, entity_type, entity_id)
         tenant_id, entity_type, entity_id
       FROM finance_memory_entity_profiles
       WHERE last_memory_at > updated_at - INTERVAL '6 hours'
         AND entity_id IS NOT NULL
       ORDER BY tenant_id, entity_type, entity_id, last_memory_at DESC
       LIMIT 50`
    );

    let refreshed = 0;
    for (const row of result.rows) {
      try {
        await svc.refreshEntityProfile(row.tenant_id, row.entity_type as any, row.entity_id);
        refreshed++;
        // Rate-limit AI calls
        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        console.error(`[MemoryCron] Profile refresh error for ${row.entity_type}/${row.entity_id}:`, err);
      }
    }

    if (refreshed > 0) {
      console.log(`[MemoryCron] Refreshed ${refreshed} entity profiles`);
    }
  } catch (err) {
    console.error('[MemoryCron] Profile refresh job error:', err);
  }
}

/**
 * Job 3: Archive old routine memories
 * Runs daily. Archives importance-1 memories older than 90 days
 * to keep the active set lean for fast search.
 */
export async function archiveOldMemories(pool: Pool): Promise<void> {
  try {
    const result = await pool.query(
      `UPDATE finance_memory
       SET is_archived = TRUE
       WHERE importance = 1
         AND is_pinned = FALSE
         AND created_at < NOW() - INTERVAL '90 days'
         AND is_archived = FALSE`
    );
    if ((result.rowCount ?? 0) > 0) {
      console.log(`[MemoryCron] Archived ${result.rowCount} old routine memories`);
    }
  } catch (err) {
    console.error('[MemoryCron] Archive job error:', err);
  }
}

// ── Register with your existing cron setup ───────────────────
// In your main cron file (e.g. src/jobs/cronJobs.ts), add:
//
// import { processEmbeddingQueue, refreshEntityProfiles, archiveOldMemories } from './memoryCron';
//
// // Every 30 seconds
// cron.schedule('*/30 * * * * *', () => processEmbeddingQueue(pool));
//
// // Every 6 hours
// cron.schedule('0 */6 * * *', () => refreshEntityProfiles(pool));
//
// // Daily at 2am IST (UTC+5:30 = 20:30 UTC)
// cron.schedule('30 20 * * *', () => archiveOldMemories(pool));
