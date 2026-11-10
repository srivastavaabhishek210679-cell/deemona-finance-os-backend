// ============================================================
// Deemona AI Finance OS — Accounting Agent
// File: src/services/accountingAgent.ts
// The first specialized AI agent — reads GL, detects anomalies,
// suggests journal entries, answers accounting questions.
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import { Pool } from 'pg';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Data fetchers ─────────────────────────────────────────────

async function getGLSnapshot(pool: Pool, tenantId: string): Promise<string> {
  const [accounts, recentEntries, apSummary, arSummary, apByVendor, arByCustomer] = await Promise.all([
    pool.query(
      `SELECT code, name, type, sub_type,
              COALESCE(SUM(jel.debit - jel.credit), 0) as balance
       FROM accounts a
       LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
       LEFT JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'posted'
       WHERE a.tenant_id = $1 AND a.is_active = TRUE
       GROUP BY a.id ORDER BY a.code`,
      [tenantId]
    ),
    pool.query(
      `SELECT je.entry_number, je.date, je.description, je.status,
              json_agg(json_build_object(
                'account', a.name, 'debit', jel.debit, 'credit', jel.credit
              )) as lines
       FROM journal_entries je
       JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
       JOIN accounts a ON a.id = jel.account_id
       WHERE je.tenant_id = $1
       GROUP BY je.id
       ORDER BY je.date DESC LIMIT 10`,
      [tenantId]
    ),
    pool.query(
      `SELECT COUNT(*) as total_bills,
              COALESCE(SUM(total_amount), 0) as total_amount,
              COALESCE(SUM(balance_due), 0) as outstanding,
              COUNT(*) FILTER (WHERE due_date < CURRENT_DATE AND status NOT IN ('paid','rejected')) as overdue
       FROM ap_invoices WHERE tenant_id = $1`,
      [tenantId]
    ),
    pool.query(
      `SELECT COUNT(*) as total_invoices,
              COALESCE(SUM(total_amount), 0) as total_amount,
              COALESCE(SUM(balance_due), 0) as outstanding,
              COUNT(*) FILTER (WHERE due_date < CURRENT_DATE AND status NOT IN ('paid','cancelled')) as overdue
       FROM ar_invoices WHERE tenant_id = $1`,
      [tenantId]
    ),
    pool.query(
      "SELECT COALESCE(v.name,'Unknown') AS vendor, COUNT(*)::int AS bills, COALESCE(SUM(i.balance_due),0) AS outstanding, " +
      "COUNT(*) FILTER (WHERE i.due_date < CURRENT_DATE)::int AS overdue_bills " +
      "FROM ap_invoices i LEFT JOIN vendors v ON v.id = i.vendor_id AND v.tenant_id = i.tenant_id " +
      "WHERE i.tenant_id = $1 AND i.status NOT IN ('paid','rejected','draft') AND i.balance_due > 0 " +
      "GROUP BY v.name ORDER BY outstanding DESC LIMIT 10",
      [tenantId]
    ),
    pool.query(
      "SELECT COALESCE(c.name,'Unknown') AS customer, COUNT(*)::int AS invoices, COALESCE(SUM(i.balance_due),0) AS outstanding, " +
      "COUNT(*) FILTER (WHERE i.due_date < CURRENT_DATE)::int AS overdue_invoices " +
      "FROM ar_invoices i LEFT JOIN customers c ON c.id = i.customer_id AND c.tenant_id = i.tenant_id " +
      "WHERE i.tenant_id = $1 AND i.status NOT IN ('paid','cancelled','draft') AND i.balance_due > 0 " +
      "GROUP BY c.name ORDER BY outstanding DESC LIMIT 10",
      [tenantId]
    ),
  ]);

  const accountSummary = accounts.rows
    .map(a => `  ${a.code} | ${a.name} | ${a.type} | Balance: INR ${parseFloat(a.balance).toLocaleString('en-IN')}`)
    .join('\n');

  const entrySummary = recentEntries.rows
    .map(e => `  ${e.entry_number} | ${e.date} | ${e.description} | ${e.status}`)
    .join('\n');

  const ap = apSummary.rows[0];
  const ar = arSummary.rows[0];
  const money = (n: any): string => 'INR ' + parseFloat(n).toLocaleString('en-IN');
  const apVendors = apByVendor.rows.map((r: any) => '  ' + r.vendor + ' | ' + r.bills + ' open bills | Outstanding: ' + money(r.outstanding) + ' | Overdue bills: ' + r.overdue_bills).join('\n');
  const arCustomers = arByCustomer.rows.map((r: any) => '  ' + r.customer + ' | ' + r.invoices + ' open invoices | Outstanding: ' + money(r.outstanding) + ' | Overdue invoices: ' + r.overdue_invoices).join('\n');
  const extra = '\n\nOPEN PAYABLES BY VENDOR (largest first):\n' + (apVendors || '  None') +
    '\n\nOPEN RECEIVABLES BY CUSTOMER (largest first):\n' + (arCustomers || '  None') +
    '\n\nNOTE: Account balances above come only from POSTED journal entries. The payables and receivables summaries and the vendor and customer lists come from the invoice sub-ledgers. The two can differ when invoices have not been journalised.';

  return `
CHART OF ACCOUNTS (with current balances):
${accountSummary || '  No accounts configured yet'}

RECENT JOURNAL ENTRIES:
${entrySummary || '  No journal entries yet'}

ACCOUNTS PAYABLE SUMMARY:
  Total Bills: ${ap.total_bills}
  Total Amount: INR ${parseFloat(ap.total_amount).toLocaleString('en-IN')}
  Outstanding: INR ${parseFloat(ap.outstanding).toLocaleString('en-IN')}
  Overdue: ${ap.overdue}

ACCOUNTS RECEIVABLE SUMMARY:
  Total Invoices: ${ar.total_invoices}
  Total Amount: INR ${parseFloat(ar.total_amount).toLocaleString('en-IN')}
  Outstanding: INR ${parseFloat(ar.outstanding).toLocaleString('en-IN')}
  Overdue: ${ar.overdue}
`.trim() + extra;
}

async function getAnomalyData(pool: Pool, tenantId: string) {
  const [duplicates, largeEntries, imbalanced, overduePayables] = await Promise.all([
    // Potential duplicate AP invoices
    pool.query(
      `SELECT vendor_id, invoice_number, COUNT(*) as count, SUM(total_amount) as total
       FROM ap_invoices WHERE tenant_id = $1
       GROUP BY vendor_id, invoice_number HAVING COUNT(*) > 1`,
      [tenantId]
    ),
    // Unusually large journal entries (> 10 lakh)
    pool.query(
      `SELECT je.entry_number, je.date, je.description,
              SUM(jel.debit) as total_debit
       FROM journal_entries je
       JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
       WHERE je.tenant_id = $1 AND je.date >= NOW() - INTERVAL '30 days'
       GROUP BY je.id HAVING SUM(jel.debit) > 1000000
       ORDER BY SUM(jel.debit) DESC`,
      [tenantId]
    ),
    // Journal entries where debits != credits (data integrity)
    pool.query(
      `SELECT je.entry_number, je.date, je.description,
              SUM(jel.debit) as total_debit, SUM(jel.credit) as total_credit
       FROM journal_entries je
       JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
       WHERE je.tenant_id = $1 AND je.status = 'posted'
       GROUP BY je.id
       HAVING ABS(SUM(jel.debit) - SUM(jel.credit)) > 0.01`,
      [tenantId]
    ),
    // Overdue payables > 60 days
    pool.query(
      `SELECT ap.invoice_number, ap.due_date, ap.balance_due, v.name as vendor_name,
              CURRENT_DATE - ap.due_date as days_overdue
       FROM ap_invoices ap JOIN vendors v ON v.id = ap.vendor_id
       WHERE ap.tenant_id = $1
       AND ap.due_date < CURRENT_DATE - INTERVAL '60 days'
       AND ap.status NOT IN ('paid','rejected')
       ORDER BY ap.due_date ASC`,
      [tenantId]
    ),
  ]);

  return {
    duplicateInvoices: duplicates.rows,
    largeEntries: largeEntries.rows,
    imbalancedEntries: imbalanced.rows,
    severelyOverduePayables: overduePayables.rows,
  };
}

// ── Agent system prompt ───────────────────────────────────────

const AGENT_SYSTEM_PROMPT = `You are the Accounting Agent of Deemona AI Finance OS — a specialized AI accountant for Indian businesses.

Your capabilities:
- Read and analyze the General Ledger (GL) data provided
- Detect accounting anomalies, errors, and risks
- Suggest journal entries with proper double-entry formatting
- Answer questions about the books, accounts, and financial position
- Provide GST-aware accounting advice (CGST, SGST, IGST)
- Flag compliance risks under Indian accounting standards

Rules:
- Always use INR and Indian numbering (lakhs, crores)
- Suggest journal entries in the format: Dr. [Account] / Cr. [Account] with amounts
- Be specific — cite account codes and entry numbers when available
- Flag anomalies clearly with severity: CRITICAL / HIGH / MEDIUM / LOW
- If data is insufficient, say so and explain what's needed
- Keep responses concise and actionable

Answer only from the data in the context. Use the vendor and customer lists to answer questions about who owes what. If the data does not contain the answer, say what is missing in one sentence and stop. Account balances come only from posted journal entries while invoice totals come from the sub-ledgers, so a difference between them is an observation to mention calmly (the invoices may not be journalised yet), not a critical error. Do not draft journal entries, estimate GST or input tax credit, or suggest corrective entries unless the user asks for them. Do not add a closing checklist of next steps. Quote amounts exactly as given.

You are NOT a replacement for a CA — always recommend professional review for significant decisions.`;

// ── Main agent function ───────────────────────────────────────

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentResponse {
  answer: string;
  anomalies?: any[];
  suggestedEntries?: any[];
  confidence: 'high' | 'medium' | 'low';
}

export async function runAccountingAgent(
  pool: Pool,
  tenantId: string,
  question: string,
  conversationHistory: AgentMessage[] = []
): Promise<AgentResponse> {

  // Fetch current GL state
  const glSnapshot = await getGLSnapshot(pool, tenantId);

  const userMessage = `CURRENT GL SNAPSHOT:
${glSnapshot}

USER QUESTION: ${question}

Please answer based on the GL data above. If you detect any anomalies in the data, flag them clearly.
If the question involves a transaction, suggest the appropriate journal entry.`;

  const messages: AgentMessage[] = [
    ...conversationHistory,
    { role: 'user', content: userMessage },
  ];

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: AGENT_SYSTEM_PROMPT,
    messages,
  });

  const answer = response.content[0].type === 'text' ? response.content[0].text : '';

  // Parse confidence from response
  const confMatch = answer.match(/\b(HIGH|MEDIUM|LOW)\b confidence/i);
  const confidence = (confMatch?.[1]?.toLowerCase() ?? 'medium') as 'high' | 'medium' | 'low';

  return { answer, confidence };
}

// ── Anomaly detection (runs on schedule) ─────────────────────

export async function detectAnomalies(
  pool: Pool,
  tenantId: string
): Promise<{ anomalies: Array<{ type: string; severity: string; description: string; data: any }> }> {

  const data = await getAnomalyData(pool, tenantId);
  const anomalies: Array<{ type: string; severity: string; description: string; data: any }> = [];

  // Duplicate invoices
  for (const dup of data.duplicateInvoices) {
    anomalies.push({
      type: 'duplicate_invoice',
      severity: 'HIGH',
      description: `Duplicate AP invoice number detected: ${dup.invoice_number} appears ${dup.count} times`,
      data: dup,
    });
  }

  // Large entries
  for (const entry of data.largeEntries) {
    anomalies.push({
      type: 'large_transaction',
      severity: 'MEDIUM',
      description: `Large journal entry: ${entry.entry_number} — INR ${parseFloat(entry.total_debit).toLocaleString('en-IN')}`,
      data: entry,
    });
  }

  // Imbalanced entries
  for (const entry of data.imbalancedEntries) {
    anomalies.push({
      type: 'imbalanced_entry',
      severity: 'CRITICAL',
      description: `Posted journal entry ${entry.entry_number} has mismatched debits/credits — data integrity issue`,
      data: entry,
    });
  }

  // Severely overdue payables
  for (const payable of data.severelyOverduePayables) {
    anomalies.push({
      type: 'overdue_payable',
      severity: 'HIGH',
      description: `Invoice ${payable.invoice_number} from ${payable.vendor_name} is ${payable.days_overdue} days overdue — INR ${parseFloat(payable.balance_due).toLocaleString('en-IN')}`,
      data: payable,
    });
  }

  // If anomalies found, get AI analysis
  if (anomalies.length > 0) {
    const anomalySummary = anomalies
      .map(a => `[${a.severity}] ${a.type}: ${a.description}`)
      .join('\n');

    const aiAnalysis = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `As an accounting agent, briefly analyze these anomalies and give top 2 recommended actions:\n${anomalySummary}`,
      }],
      system: AGENT_SYSTEM_PROMPT,
    });

    const aiText = aiAnalysis.content[0].type === 'text' ? aiAnalysis.content[0].text : '';
    anomalies.push({
      type: 'ai_analysis',
      severity: 'INFO',
      description: aiText,
      data: null,
    });
  }

  return { anomalies };
}

// ── Suggest journal entry for a transaction ───────────────────

export async function suggestJournalEntry(
  pool: Pool,
  tenantId: string,
  transactionDescription: string
): Promise<{ suggestion: string; entries: Array<{ account: string; debit: number; credit: number }> }> {

  // Get available accounts for context
  const accounts = await pool.query(
    `SELECT code, name, type FROM accounts WHERE tenant_id = $1 AND is_active = TRUE ORDER BY code`,
    [tenantId]
  );

  const accountList = accounts.rows
    .map(a => `${a.code}: ${a.name} (${a.type})`)
    .join('\n');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: AGENT_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Available accounts:\n${accountList || 'No accounts configured'}\n\nTransaction to record: ${transactionDescription}\n\nSuggest the journal entry. Format each line as: Dr/Cr | Account Code | Account Name | Amount`,
    }],
  });

  const suggestion = response.content[0].type === 'text' ? response.content[0].text : '';

  return { suggestion, entries: [] };
}
