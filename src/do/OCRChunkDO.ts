/**
 * OCR Chunk Durable Object - SQLite-backed
 *
 * Processes OCR for a chunk of PIs. Uses SQLite storage to handle 1000s of refs.
 *
 * SQLite Tables:
 * - state: Single row with chunk metadata and counters
 * - pis: One row per PI with entity update status
 * - refs: One row per ref (the main scalability fix)
 * - debug_log: Capped debug entries
 */

import { DurableObject } from 'cloudflare:workers';
import {
  Env,
  OCRChunkRequest,
  OCRChunkStatusResponse,
  OCRChunkCallback,
  RefData,
  OCRPhase,
} from '../types';
import {
  createBackoffState,
  isInBackoff,
  getBackoffRemaining,
  onSuccess,
  onError,
  clearBackoff,
  BackoffState,
} from './rate-limiter';
import { IPFSWrapperClient } from '../services/ipfs-client';
import {
  PermanentOCRError,
  RateLimitError,
  buildOCRImageUrl,
  createDeepInfraClient,
  extractTextFromImage,
} from '../services/deepinfra';
import { fetchAllPIContexts } from '../lib/context-fetcher';

const DEFAULT_MAX_PARALLEL = 20;
const MAX_DEBUG_LOG_ENTRIES = 100;

interface RefRow {
  id: number;
  pi: string;
  filename: string;
  cdn_url: string;
  original_cid: string;
  status: string;
  error: string | null;
  retry_count: number;
  ref_data_json: string | null;
  result_cid: string | null;
  ocr_text_length: number | null;
}

interface PIRow {
  pi: string;
  entity_updated: number;
  new_tip: string | null;
  new_version: number | null;
  entity_error: string | null;
}

export class OCRChunkDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private initialized = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  /**
   * Initialize SQL tables
   */
  private initTables(): void {
    if (this.initialized) return;

    this.sql.exec(`
      -- Core state (single row)
      CREATE TABLE IF NOT EXISTS state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        batch_id TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        phase TEXT NOT NULL,
        total_refs INTEGER DEFAULT 0,
        completed_refs INTEGER DEFAULT 0,
        failed_refs INTEGER DEFAULT 0,
        skipped_refs INTEGER DEFAULT 0,
        global_error TEXT,
        global_retry_count INTEGER DEFAULT 0,
        backoff_consecutive_errors INTEGER DEFAULT 0,
        backoff_until INTEGER
      );

      -- PIs being processed
      CREATE TABLE IF NOT EXISTS pis (
        pi TEXT PRIMARY KEY,
        entity_updated INTEGER DEFAULT 0,
        new_tip TEXT,
        new_version INTEGER,
        entity_error TEXT
      );

      -- Individual refs (handles 1000s of refs)
      CREATE TABLE IF NOT EXISTS refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pi TEXT NOT NULL,
        filename TEXT NOT NULL,
        cdn_url TEXT NOT NULL,
        original_cid TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        retry_count INTEGER DEFAULT 0,
        ref_data_json TEXT,
        result_cid TEXT,
        ocr_text_length INTEGER,
        UNIQUE(pi, filename)
      );

      -- Debug log (capped)
      CREATE TABLE IF NOT EXISTS debug_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        message TEXT NOT NULL
      );

      -- Index for efficient pending ref queries
      CREATE INDEX IF NOT EXISTS idx_refs_status ON refs(status);
      CREATE INDEX IF NOT EXISTS idx_refs_pi ON refs(pi);
    `);

    this.initialized = true;
  }

  /** Add debug entry to log (capped) */
  private debugLog(msg: string): void {
    const timestamp = new Date().toISOString();
    console.log(`[OCRChunkDO] ${msg}`);

    this.sql.exec(
      `INSERT INTO debug_log (timestamp, message) VALUES (?, ?)`,
      timestamp,
      msg
    );

    // Cap at MAX_DEBUG_LOG_ENTRIES
    this.sql.exec(
      `DELETE FROM debug_log WHERE id NOT IN (
        SELECT id FROM debug_log ORDER BY id DESC LIMIT ?
      )`,
      MAX_DEBUG_LOG_ENTRIES
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === 'POST' && url.pathname === '/process') {
        return await this.handleProcess(request);
      }

      if (request.method === 'GET' && url.pathname === '/status') {
        return await this.handleStatus();
      }

      return new Response('Not Found', { status: 404 });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[OCRChunkDO] Request error:', msg);
      return Response.json({ error: msg }, { status: 500 });
    }
  }

  private async handleProcess(request: Request): Promise<Response> {
    this.initTables();

    const req: OCRChunkRequest = await request.json();

    // Check if already processing
    const stateRows = [...this.sql.exec('SELECT phase FROM state WHERE id = 1')];
    if (stateRows.length > 0) {
      const phase = stateRows[0].phase as string;
      if (phase !== 'ERROR' && phase !== 'DONE') {
        return Response.json({
          status: 'already_processing',
          chunk_id: req.chunk_id,
          phase,
        });
      }
      // Clear old state for reprocessing
      this.clearAllTables();
    }

    const now = new Date().toISOString();

    // Initialize state
    this.sql.exec(
      `INSERT INTO state (id, batch_id, chunk_id, started_at, phase, global_retry_count, backoff_consecutive_errors)
       VALUES (1, ?, ?, ?, 'FETCHING', 0, 0)`,
      req.batch_id,
      req.chunk_id,
      now
    );

    // Store PI list
    for (const pi of req.pis) {
      this.sql.exec(
        `INSERT INTO pis (pi, entity_updated) VALUES (?, 0)`,
        pi
      );
    }

    this.debugLog(`handleProcess - initialized with ${req.pis.length} PIs, starting FETCHING phase`);

    // Schedule immediate processing
    await this.ctx.storage.setAlarm(Date.now() + 100);

    console.log(`[OCRChunkDO] Started chunk ${req.chunk_id}: ${req.pis.length} PIs`);

    return Response.json({
      status: 'accepted',
      chunk_id: req.chunk_id,
      total_pis: req.pis.length,
      total_refs: 0,  // Will be determined after fetching
    });
  }

  private async handleStatus(): Promise<Response> {
    this.initTables();

    const stateRows = [...this.sql.exec('SELECT * FROM state WHERE id = 1')];
    if (stateRows.length === 0) {
      return Response.json({ status: 'not_found' } as OCRChunkStatusResponse);
    }
    const state = stateRows[0];

    // Count pending refs
    const pendingRows = [...this.sql.exec(`SELECT COUNT(*) as cnt FROM refs WHERE status = 'pending'`)];
    const pending = (pendingRows[0]?.cnt as number) || 0;

    // Get debug log
    const logRows = [...this.sql.exec('SELECT timestamp, message FROM debug_log ORDER BY id DESC LIMIT 50')];
    const debugLog = logRows.map(r => `${r.timestamp} ${r.message}`).reverse();

    return Response.json({
      status: state.phase === 'DONE' ? 'done' :
              state.phase === 'ERROR' ? 'error' : 'processing',
      phase: state.phase as OCRPhase,
      progress: {
        total_refs: state.total_refs as number,
        completed: state.completed_refs as number,
        failed: state.failed_refs as number,
        skipped: state.skipped_refs as number,
        pending,
      },
      backoff: {
        consecutive_errors: state.backoff_consecutive_errors as number,
        backoff_until: state.backoff_until
          ? new Date(state.backoff_until as number).toISOString()
          : undefined,
      },
      error: state.global_error as string | undefined,
      debug_log: debugLog,
    });
  }

  async alarm(): Promise<void> {
    this.initTables();

    const stateRows = [...this.sql.exec('SELECT * FROM state WHERE id = 1')];
    if (stateRows.length === 0) {
      console.log(`[OCRChunkDO] ALARM - No state, returning`);
      return;
    }
    const state = stateRows[0];

    this.debugLog(`ALARM FIRED - phase: ${state.phase}`);

    try {
      switch (state.phase as OCRPhase) {
        case 'FETCHING':
          await this.fetchPhase();
          break;
        case 'PROCESSING':
          await this.processPhase();
          break;
        case 'PUBLISHING':
          await this.publishPhase();
          break;
        case 'DONE':
          await this.sendCallback();
          break;
        case 'ERROR':
          await this.sendErrorCallback();
          break;
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[OCRChunkDO] Alarm error:`, msg);
      await this.handleGlobalError(msg);
    }
  }

  /**
   * FETCHING phase - fetch context from IPFS for all PIs
   */
  private async fetchPhase(): Promise<void> {
    const piRows = [...this.sql.exec('SELECT pi FROM pis')];
    const piList = piRows.map(r => r.pi as string);

    this.debugLog(`fetchPhase START - fetching context for ${piList.length} PIs`);

    const ipfs = new IPFSWrapperClient(this.env.IPFS_WRAPPER);

    // Fetch context for all PIs
    const contexts = await fetchAllPIContexts(ipfs, piList);

    // Store refs in SQL (individual rows - scales to 1000s)
    let totalRefs = 0;
    for (const ctx of contexts) {
      for (const ref of ctx.refs) {
        this.sql.exec(
          `INSERT INTO refs (pi, filename, cdn_url, original_cid, status, retry_count, ref_data_json)
           VALUES (?, ?, ?, ?, 'pending', 0, ?)`,
          ctx.pi,
          ref.filename,
          ref.cdn_url,
          ref.cid,
          ref.ref_data ? JSON.stringify(ref.ref_data) : null
        );
        totalRefs++;
      }
    }

    // Update state
    this.sql.exec(
      `UPDATE state SET total_refs = ?, phase = 'PROCESSING' WHERE id = 1`,
      totalRefs
    );

    this.debugLog(`fetchPhase COMPLETE - found ${totalRefs} refs across ${contexts.length} PIs`);

    await this.ctx.storage.setAlarm(Date.now() + 100);
  }

  /**
   * PROCESSING phase - process pending refs in parallel batches
   */
  private async processPhase(): Promise<void> {
    // Get backoff state
    const stateRows = [...this.sql.exec('SELECT backoff_consecutive_errors, backoff_until FROM state WHERE id = 1')];
    const state = stateRows[0];
    const backoff: BackoffState = {
      consecutive_errors: state.backoff_consecutive_errors as number,
      backoff_until: state.backoff_until as number | undefined,
    };

    // Check if in backoff
    if (isInBackoff(backoff)) {
      const remaining = getBackoffRemaining(backoff);
      this.debugLog(`In backoff, waiting ${remaining}ms`);
      await this.ctx.storage.setAlarm(Date.now() + Math.min(remaining + 100, 5000));
      return;
    }

    // Clear backoff if expired
    clearBackoff(backoff);
    this.sql.exec(
      `UPDATE state SET backoff_consecutive_errors = ?, backoff_until = NULL WHERE id = 1`,
      backoff.consecutive_errors
    );

    // Get pending refs (efficient SQL query)
    const maxParallel = parseInt(this.env.MAX_PARALLEL_OCR || String(DEFAULT_MAX_PARALLEL));
    const pendingRows = [...this.sql.exec(
      `SELECT * FROM refs WHERE status = 'pending' LIMIT ?`,
      maxParallel
    )] as unknown as RefRow[];

    if (pendingRows.length === 0) {
      this.debugLog(`All refs processed, moving to PUBLISHING`);
      this.sql.exec(`UPDATE state SET phase = 'PUBLISHING' WHERE id = 1`);
      await this.ctx.storage.setAlarm(Date.now() + 100);
      return;
    }

    this.debugLog(`Processing ${pendingRows.length} refs in parallel`);

    // Mark as processing
    const refIds = pendingRows.map(r => r.id);
    this.sql.exec(
      `UPDATE refs SET status = 'processing' WHERE id IN (${refIds.join(',')})`
    );

    // Process all in parallel
    const results = await Promise.allSettled(
      pendingRows.map(ref => this.processOneRef(ref))
    );

    // Handle results
    let hadRateLimit = false;
    let completedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const ref = pendingRows[i];

      if (result.status === 'fulfilled') {
        const { cid, skipped, textLength } = result.value;

        this.sql.exec(
          `UPDATE refs SET status = ?, result_cid = ?, ocr_text_length = ? WHERE id = ?`,
          skipped ? 'skipped' : 'done',
          cid,
          textLength,
          ref.id
        );

        if (skipped) {
          skippedCount++;
        } else {
          completedCount++;
        }
      } else {
        const error = result.reason;
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.debugLog(`✗ ${ref.filename} failed: ${errorMsg}`);

        if (error instanceof RateLimitError) {
          hadRateLimit = true;
          const newRetryCount = ref.retry_count + 1;
          this.sql.exec(
            `UPDATE refs SET status = 'pending', retry_count = ? WHERE id = ?`,
            newRetryCount,
            ref.id
          );
          this.debugLog(`Rate limited, will retry`);
        } else if (error instanceof PermanentOCRError) {
          this.sql.exec(
            `UPDATE refs SET status = 'error', error = ? WHERE id = ?`,
            errorMsg,
            ref.id
          );
          failedCount++;
          this.debugLog(`Permanent error: ${errorMsg}`);
        } else {
          // Transient error - retry
          const newRetryCount = ref.retry_count + 1;
          const maxRetries = parseInt(this.env.MAX_RETRIES_PER_REF || '3');

          if (newRetryCount >= maxRetries) {
            this.sql.exec(
              `UPDATE refs SET status = 'error', error = ?, retry_count = ? WHERE id = ?`,
              `Failed after ${maxRetries} retries: ${errorMsg}`,
              newRetryCount,
              ref.id
            );
            failedCount++;
            this.debugLog(`Failed after ${maxRetries} retries`);
          } else {
            this.sql.exec(
              `UPDATE refs SET status = 'pending', retry_count = ? WHERE id = ?`,
              newRetryCount,
              ref.id
            );
            this.debugLog(`Will retry (attempt ${newRetryCount}/${maxRetries})`);
          }
        }
      }
    }

    // Update counters
    this.sql.exec(
      `UPDATE state SET
        completed_refs = completed_refs + ?,
        failed_refs = failed_refs + ?,
        skipped_refs = skipped_refs + ?
       WHERE id = 1`,
      completedCount,
      failedCount,
      skippedCount
    );

    // Update backoff state
    if (hadRateLimit) {
      onError(backoff);
    } else {
      onSuccess(backoff);
    }
    this.sql.exec(
      `UPDATE state SET backoff_consecutive_errors = ?, backoff_until = ? WHERE id = 1`,
      backoff.consecutive_errors,
      backoff.backoff_until || null
    );

    const successCount = completedCount + skippedCount;
    this.debugLog(`Batch complete: ${successCount}/${pendingRows.length} succeeded${hadRateLimit ? ' (rate limited)' : ''}`);

    // Schedule next iteration
    if (hadRateLimit) {
      const delay = getBackoffRemaining(backoff);
      await this.ctx.storage.setAlarm(Date.now() + delay);
    } else {
      await this.ctx.storage.setAlarm(Date.now() + 100);
    }
  }

  private async processOneRef(ref: RefRow): Promise<{
    cid: string;
    skipped: boolean;
    textLength: number;
  }> {
    console.log(`[OCRChunkDO] processOneRef starting: ${ref.filename}`);

    // Load cached ref data
    if (!ref.ref_data_json) {
      throw new PermanentOCRError(`Ref data not found for: ${ref.filename}`);
    }

    const refData: RefData = JSON.parse(ref.ref_data_json);

    // Skip if already has OCR
    if (refData.ocr) {
      console.log(`[OCRChunkDO] Skipping ${ref.filename} - already has OCR`);
      const ipfs = new IPFSWrapperClient(this.env.IPFS_WRAPPER);
      const cid = await ipfs.uploadContent(JSON.stringify(refData, null, 2), ref.filename);
      return { cid, skipped: true, textLength: refData.ocr.length };
    }

    // Build OCR URL (try medium variant for Arke CDN)
    const { primary, fallback } = buildOCRImageUrl(ref.cdn_url);

    // Call DeepInfra OCR
    const client = createDeepInfraClient(this.env.DEEPINFRA_API_KEY);
    const ocrResult = await extractTextFromImage(client, primary, fallback);

    // Update ref data with OCR
    refData.ocr = ocrResult.text;

    // Upload updated ref to IPFS
    const ipfs = new IPFSWrapperClient(this.env.IPFS_WRAPPER);
    const refJson = JSON.stringify(refData, null, 2);
    const cid = await ipfs.uploadContent(refJson, ref.filename);

    console.log(`[OCRChunkDO] ✓ ${ref.filename}: ${ocrResult.text.length} chars`);

    return { cid, skipped: false, textLength: ocrResult.text.length };
  }

  /**
   * PUBLISHING phase - update entities with OCR results
   */
  private async publishPhase(): Promise<void> {
    this.debugLog(`publishPhase START`);
    const ipfs = new IPFSWrapperClient(this.env.IPFS_WRAPPER);

    const piRows = [...this.sql.exec('SELECT * FROM pis WHERE entity_updated = 0')] as unknown as PIRow[];

    for (const pi of piRows) {
      // Get completed refs for this PI
      const refRows = [...this.sql.exec(
        `SELECT filename, result_cid FROM refs
         WHERE pi = ? AND (status = 'done' OR status = 'skipped') AND result_cid IS NOT NULL`,
        pi.pi
      )];

      this.debugLog(`PI ${pi.pi}: ${refRows.length} refs to publish`);

      if (refRows.length === 0) {
        this.sql.exec(`UPDATE pis SET entity_updated = 1 WHERE pi = ?`, pi.pi);
        continue;
      }

      // Build components
      const components: Record<string, string> = {};
      for (const ref of refRows) {
        components[ref.filename as string] = ref.result_cid as string;
      }

      try {
        // Fetch fresh tip before updating
        this.debugLog(`Fetching fresh tip for ${pi.pi}`);
        const freshTip = await ipfs.getEntityTip(pi.pi);
        this.debugLog(`Got fresh tip: ${freshTip}`);

        const result = await ipfs.appendVersionWithRetry(
          pi.pi,
          freshTip,
          components,
          `OCR: Updated ${Object.keys(components).length} refs`
        );

        this.sql.exec(
          `UPDATE pis SET entity_updated = 1, new_tip = ?, new_version = ? WHERE pi = ?`,
          result.tip,
          result.ver,
          pi.pi
        );

        this.debugLog(`Published v${result.ver} for ${pi.pi}`);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        this.debugLog(`Entity update FAILED for ${pi.pi}: ${msg}`);
        this.sql.exec(
          `UPDATE pis SET entity_updated = 1, entity_error = ? WHERE pi = ?`,
          msg,
          pi.pi
        );
      }
    }

    this.sql.exec(
      `UPDATE state SET phase = 'DONE', completed_at = ? WHERE id = 1`,
      new Date().toISOString()
    );
    await this.ctx.storage.setAlarm(Date.now() + 100);
  }

  private async sendCallback(): Promise<void> {
    const callback = this.buildCallback();
    const stateRows = [...this.sql.exec('SELECT batch_id FROM state WHERE id = 1')];
    const batchId = stateRows[0]?.batch_id as string;
    // Orchestrator expects /callback/:service/:batchId
    const callbackPath = `/callback/ocr/${batchId}`;

    try {
      const response = await this.env.ORCHESTRATOR.fetch(
        new Request(`https://orchestrator${callbackPath}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(callback),
        })
      );

      if (!response.ok) {
        throw new Error(`Callback failed: ${response.status}`);
      }

      console.log(`[OCRChunkDO] Callback sent successfully`);
      await this.cleanup();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[OCRChunkDO] Callback failed:`, msg);

      const retryRows = [...this.sql.exec('SELECT global_retry_count FROM state WHERE id = 1')];
      const retryCount = (retryRows[0]?.global_retry_count as number) || 0;

      if (retryCount < 3) {
        this.sql.exec(`UPDATE state SET global_retry_count = ? WHERE id = 1`, retryCount + 1);
        await this.ctx.storage.setAlarm(Date.now() + 5000);
      } else {
        this.debugLog(`Callback failed after 3 retries, state preserved`);
      }
    }
  }

  private async sendErrorCallback(): Promise<void> {
    const callback = this.buildCallback();
    const stateRows = [...this.sql.exec('SELECT batch_id, global_error FROM state WHERE id = 1')];
    const batchId = stateRows[0]?.batch_id as string;
    callback.status = 'error';
    callback.error = stateRows[0]?.global_error as string;
    // Orchestrator expects /callback/:service/:batchId
    const callbackPath = `/callback/ocr/${batchId}`;

    try {
      const response = await this.env.ORCHESTRATOR.fetch(
        new Request(`https://orchestrator${callbackPath}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(callback),
        })
      );
      if (response.ok) {
        await this.cleanup();
        return;
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[OCRChunkDO] Error callback failed:`, msg);
    }

    this.debugLog(`Error callback failed, state preserved`);
  }

  private buildCallback(): OCRChunkCallback {
    const stateRows = [...this.sql.exec('SELECT * FROM state WHERE id = 1')];
    const state = stateRows[0];

    const piRows = [...this.sql.exec('SELECT * FROM pis')] as unknown as PIRow[];

    const results = piRows.map(pi => {
      // Get ref counts for this PI
      const completedRows = [...this.sql.exec(
        `SELECT COUNT(*) as cnt FROM refs WHERE pi = ? AND (status = 'done' OR status = 'skipped')`,
        pi.pi
      )];
      const failedRows = [...this.sql.exec(
        `SELECT COUNT(*) as cnt FROM refs WHERE pi = ? AND status = 'error'`,
        pi.pi
      )];
      const refsCompleted = (completedRows[0]?.cnt as number) || 0;
      const refsFailed = (failedRows[0]?.cnt as number) || 0;

      // Get failed ref details
      const failedRefRows = [...this.sql.exec(
        `SELECT filename, error FROM refs WHERE pi = ? AND status = 'error'`,
        pi.pi
      )];
      const failedRefs = failedRefRows.map(r => ({
        filename: r.filename as string,
        error: (r.error as string) || 'Unknown error',
      }));

      let status: 'success' | 'partial' | 'error';
      if (pi.entity_error) {
        status = 'error';
      } else if (refsFailed > 0 && refsCompleted > 0) {
        status = 'partial';
      } else if (refsFailed > 0 && refsCompleted === 0) {
        status = 'error';
      } else {
        status = 'success';
      }

      return {
        pi: pi.pi,
        status,
        new_tip: pi.new_tip || undefined,
        new_version: pi.new_version || undefined,
        refs_completed: refsCompleted,
        refs_failed: refsFailed,
        failed_refs: failedRefs.length > 0 ? failedRefs : undefined,
      };
    });

    const overallStatus = results.every(r => r.status === 'success') ? 'success' :
                          results.every(r => r.status === 'error') ? 'error' : 'partial';

    const startedAt = new Date(state.started_at as string).getTime();
    const completedAt = state.completed_at
      ? new Date(state.completed_at as string).getTime()
      : Date.now();

    return {
      batch_id: state.batch_id as string,
      chunk_id: state.chunk_id as string,
      status: overallStatus,
      results,
      summary: {
        total_refs: state.total_refs as number,
        completed: state.completed_refs as number,
        failed: state.failed_refs as number,
        skipped: state.skipped_refs as number,
        processing_time_ms: completedAt - startedAt,
      },
    };
  }

  private async handleGlobalError(errorMsg: string): Promise<void> {
    const retryRows = [...this.sql.exec('SELECT global_retry_count FROM state WHERE id = 1')];
    const retryCount = (retryRows[0]?.global_retry_count as number) || 0;
    const newRetryCount = retryCount + 1;
    const maxRetries = parseInt(this.env.MAX_GLOBAL_RETRIES || '5');

    if (newRetryCount >= maxRetries) {
      this.sql.exec(
        `UPDATE state SET phase = 'ERROR', global_error = ?, global_retry_count = ? WHERE id = 1`,
        errorMsg,
        newRetryCount
      );
      await this.ctx.storage.setAlarm(Date.now() + 100);
      return;
    }

    const delay = Math.min(60000, 1000 * Math.pow(2, newRetryCount));
    console.log(`[OCRChunkDO] Global error, retry ${newRetryCount}/${maxRetries} after ${delay}ms`);
    this.sql.exec(`UPDATE state SET global_retry_count = ? WHERE id = 1`, newRetryCount);
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  private async cleanup(): Promise<void> {
    this.sql.exec('DELETE FROM state');
    this.sql.exec('DELETE FROM pis');
    this.sql.exec('DELETE FROM refs');
    this.sql.exec('DELETE FROM debug_log');
  }

  private clearAllTables(): void {
    this.sql.exec('DELETE FROM state');
    this.sql.exec('DELETE FROM pis');
    this.sql.exec('DELETE FROM refs');
    this.sql.exec('DELETE FROM debug_log');
  }
}
