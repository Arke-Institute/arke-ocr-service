import {
  Env,
  OCRChunkRequest,
  OCRChunkState,
  OCRChunkStatusResponse,
  OCRChunkCallback,
  RefState,
  RefData,
} from '../types';
import {
  createBackoffState,
  isInBackoff,
  getBackoffRemaining,
  onSuccess,
  onError,
  clearBackoff,
} from './rate-limiter';
import { IPFSWrapperClient } from '../services/ipfs-client';
import {
  PermanentOCRError,
  RateLimitError,
  buildOCRImageUrl,
  createDeepInfraClient,
  extractTextFromImage,
} from '../services/deepinfra';

const STATE_KEY = 'state';
const DEFAULT_MAX_PARALLEL = 20;

/**
 * OCR Chunk Durable Object
 *
 * Processes OCR for a chunk of PIs. Processes all refs in parallel
 * with simple exponential backoff on rate limit errors.
 */
export class OCRChunkDO implements DurableObject {
  private state: OCRChunkState | null = null;
  private ctx: DurableObjectState;
  private env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  /** Add debug entry to state log */
  private debugLog(msg: string): void {
    if (this.state) {
      if (!this.state.debug_log) this.state.debug_log = [];
      const entry = `${new Date().toISOString()} ${msg}`;
      this.state.debug_log.push(entry);
      console.log(`[OCRChunkDO] ${msg}`);
    }
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
    } catch (error: any) {
      console.error('[OCRChunkDO] Request error:', error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  private async handleProcess(request: Request): Promise<Response> {
    const req: OCRChunkRequest = await request.json();

    await this.loadState();

    // Check if already processing
    if (this.state && this.state.phase !== 'ERROR' && this.state.phase !== 'DONE') {
      return Response.json({
        status: 'already_processing',
        chunk_id: this.state.chunk_id,
        phase: this.state.phase,
      });
    }

    // Count total refs
    const totalRefs = req.pis.reduce((sum, pi) => sum + pi.refs.length, 0);

    // Initialize state
    this.state = {
      batch_id: req.batch_id,
      chunk_id: req.chunk_id,
      started_at: new Date().toISOString(),
      phase: 'PROCESSING',
      pis: req.pis.map(pi => ({
        pi: pi.pi,
        // Note: No current_tip stored - we fetch fresh tips before publishing
        refs: pi.refs.map(r => ({
          filename: r.filename,
          staging_key: r.staging_key,
          cdn_url: r.cdn_url,
          status: 'pending' as const,
          retry_count: 0,
        })),
        entity_updated: false,
      })),
      backoff: createBackoffState(),
      total_refs: totalRefs,
      completed_refs: 0,
      failed_refs: 0,
      skipped_refs: 0,
      global_retry_count: 0,
      debug_log: [],  // Initialize debug log
    };

    // Log initialization
    const refStatuses = this.state.pis.flatMap(pi =>
      pi.refs.map(r => `${r.filename}:${r.status}`)
    ).join(', ');
    this.debugLog(`handleProcess - initialized: ${refStatuses}`);

    await this.saveState();
    this.debugLog(`handleProcess - state saved`);

    // Set alarm
    const alarmTime = Date.now() + 100;  // Back to 100ms
    await this.ctx.storage.setAlarm(alarmTime);
    this.debugLog(`handleProcess - alarm scheduled for +100ms`);

    await this.saveState();  // Save again to persist debug log

    console.log(
      `[OCRChunkDO] Started chunk ${req.chunk_id}: ${req.pis.length} PIs, ${totalRefs} refs`
    );

    return Response.json({
      status: 'accepted',
      chunk_id: req.chunk_id,
      total_pis: req.pis.length,
      total_refs: totalRefs,
    });
  }

  private async handleStatus(): Promise<Response> {
    await this.loadState();

    if (!this.state) {
      return Response.json({ status: 'not_found' } as OCRChunkStatusResponse);
    }

    const pending = this.getPendingRefs().length;

    return Response.json({
      status: this.state.phase === 'DONE' ? 'done' :
              this.state.phase === 'ERROR' ? 'error' : 'processing',
      phase: this.state.phase,
      progress: {
        total_refs: this.state.total_refs,
        completed: this.state.completed_refs,
        failed: this.state.failed_refs,
        skipped: this.state.skipped_refs,
        pending,
      },
      backoff: {
        consecutive_errors: this.state.backoff.consecutive_errors,
        backoff_until: this.state.backoff.backoff_until
          ? new Date(this.state.backoff.backoff_until).toISOString()
          : undefined,
      },
      error: this.state.global_error,
      debug_log: this.state.debug_log,
    });
  }

  async alarm(): Promise<void> {
    await this.loadState();
    if (!this.state) {
      console.log(`[OCRChunkDO] ALARM - No state after loadState, returning`);
      return;
    }
    this.debugLog(`ALARM FIRED - phase: ${this.state.phase}`);

    try {
      switch (this.state.phase) {
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
    } catch (error: any) {
      console.error(`[OCRChunkDO] Alarm error:`, error);
      await this.handleGlobalError(error);
    }
  }

  /**
   * PROCESSING phase - process all pending refs in parallel
   */
  private async processPhase(): Promise<void> {
    // Debug: log ref statuses
    const refStatuses = this.state!.pis.flatMap(pi =>
      pi.refs.map(r => `${r.filename}:${r.status}`)
    ).join(', ');
    this.debugLog(`processPhase START - refs: ${refStatuses}`);

    // Check if in backoff
    if (isInBackoff(this.state!.backoff)) {
      const remaining = getBackoffRemaining(this.state!.backoff);
      this.debugLog(`In backoff, waiting ${remaining}ms`);
      await this.saveState();
      await this.ctx.storage.setAlarm(Date.now() + Math.min(remaining + 100, 5000));
      return;
    }

    // Clear backoff if it expired
    clearBackoff(this.state!.backoff);

    const pendingRefs = this.getPendingRefs();
    this.debugLog(`pendingRefs count: ${pendingRefs.length}`);

    if (pendingRefs.length === 0) {
      this.debugLog(`All refs processed, moving to PUBLISHING`);
      this.state!.phase = 'PUBLISHING';
      await this.saveState();
      await this.ctx.storage.setAlarm(Date.now() + 100);
      return;
    }

    // Process refs in parallel (up to max limit)
    const maxParallel = parseInt(this.env.MAX_PARALLEL_OCR || String(DEFAULT_MAX_PARALLEL));
    const batch = pendingRefs.slice(0, maxParallel);

    this.debugLog(`Processing ${batch.length} refs in parallel`);

    // Mark as processing
    for (const ref of batch) {
      ref.status = 'processing';
    }
    await this.saveState();

    // Process all in parallel
    const results = await Promise.allSettled(
      batch.map(ref => this.processOneRef(ref))
    );

    // Handle results
    let hadRateLimit = false;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const ref = batch[i];

      if (result.status === 'fulfilled') {
        const { cid, skipped, textLength } = result.value;
        ref.status = skipped ? 'skipped' : 'done';
        ref.result_cid = cid;
        ref.ocr_text_length = textLength;

        if (skipped) {
          this.state!.skipped_refs++;
        } else {
          this.state!.completed_refs++;
        }
      } else {
        const error = result.reason;
        this.debugLog(`✗ ${ref.filename} failed: ${error.message || error}`);

        if (error instanceof RateLimitError) {
          hadRateLimit = true;
          ref.status = 'pending'; // Re-queue
          ref.retry_count++;
          this.debugLog(`Rate limited, will retry`);
        } else if (error instanceof PermanentOCRError) {
          ref.status = 'error';
          ref.error = error.message;
          this.state!.failed_refs++;
          this.debugLog(`Permanent error: ${error.message}`);
        } else {
          // Transient error - retry
          ref.retry_count++;
          const maxRetries = parseInt(this.env.MAX_RETRIES_PER_REF || '3');

          if (ref.retry_count >= maxRetries) {
            ref.status = 'error';
            ref.error = `Failed after ${maxRetries} retries: ${error.message}`;
            this.state!.failed_refs++;
            this.debugLog(`Failed after ${maxRetries} retries`);
          } else {
            ref.status = 'pending';
            this.debugLog(`Will retry (attempt ${ref.retry_count}/${maxRetries})`);
          }
        }
      }
    }

    // Update backoff state
    if (hadRateLimit) {
      onError(this.state!.backoff);
    } else {
      onSuccess(this.state!.backoff);
    }

    const successCount = results.filter(r => r.status === 'fulfilled').length;
    this.debugLog(`Batch complete: ${successCount}/${batch.length} succeeded${hadRateLimit ? ' (rate limited)' : ''}`);

    await this.saveState();

    // Schedule next iteration
    if (hadRateLimit) {
      const delay = getBackoffRemaining(this.state!.backoff);
      await this.ctx.storage.setAlarm(Date.now() + delay);
    } else {
      await this.ctx.storage.setAlarm(Date.now() + 100);
    }
  }

  private async processOneRef(ref: RefState): Promise<{
    cid: string;
    skipped: boolean;
    textLength: number;
  }> {
    console.log(`[OCRChunkDO] processOneRef starting: ${ref.filename}, staging_key: ${ref.staging_key}`);

    // Load ref data from R2
    const refObj = await this.env.STAGING_BUCKET.get(ref.staging_key);
    console.log(`[OCRChunkDO] R2 get result: ${refObj ? 'found' : 'NOT FOUND'}`);
    if (!refObj) {
      throw new PermanentOCRError(`Ref not found: ${ref.staging_key}`);
    }

    const refData: RefData = JSON.parse(await refObj.text());

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

    // Update ref data
    refData.ocr = ocrResult.text;

    // Save to R2
    const refJson = JSON.stringify(refData, null, 2);
    await this.env.STAGING_BUCKET.put(ref.staging_key, refJson);

    // Upload to IPFS
    const ipfs = new IPFSWrapperClient(this.env.IPFS_WRAPPER);
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

    for (const pi of this.state!.pis) {
      if (pi.entity_updated) {
        this.debugLog(`PI ${pi.pi} already updated, skipping`);
        continue;
      }

      // Build components from completed refs
      const components: Record<string, string> = {};
      for (const ref of pi.refs) {
        this.debugLog(`  Ref ${ref.filename}: status=${ref.status}, result_cid=${ref.result_cid || 'none'}`);
        if ((ref.status === 'done' || ref.status === 'skipped') && ref.result_cid) {
          components[ref.filename] = ref.result_cid;
        }
      }

      this.debugLog(`Components to publish: ${Object.keys(components).length}`);

      if (Object.keys(components).length === 0) {
        this.debugLog(`No components to publish for ${pi.pi}`);
        pi.entity_updated = true;
        continue;
      }

      try {
        // Fetch fresh tip before updating (avoids stale tip bug from bidirectional updates)
        this.debugLog(`Fetching fresh tip for ${pi.pi}`);
        const freshTip = await ipfs.getEntityTip(pi.pi);
        this.debugLog(`Got fresh tip: ${freshTip}`);

        this.debugLog(`Calling appendVersionWithRetry for ${pi.pi}`);
        const result = await ipfs.appendVersionWithRetry(
          pi.pi,
          freshTip,
          components,
          `OCR: Updated ${Object.keys(components).length} refs`
        );

        pi.new_tip = result.tip;
        pi.new_version = result.ver;
        pi.entity_updated = true;

        this.debugLog(`Published v${result.ver} for ${pi.pi}`);
      } catch (error: any) {
        this.debugLog(`Entity update FAILED for ${pi.pi}: ${error.message}`);
        pi.entity_error = error.message;
        pi.entity_updated = true;
      }
    }

    this.state!.phase = 'DONE';
    this.state!.completed_at = new Date().toISOString();
    await this.saveState();
    await this.ctx.storage.setAlarm(Date.now() + 100);
  }

  private async sendCallback(): Promise<void> {
    const callback = this.buildCallback();
    const callbackPath = `/callback/${this.state!.batch_id}/ocr`;

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
    } catch (error: any) {
      console.error(`[OCRChunkDO] Callback failed:`, error.message);
      this.state!.global_retry_count++;

      if (this.state!.global_retry_count < 3) {
        await this.saveState();
        await this.ctx.storage.setAlarm(Date.now() + 5000);
      } else {
        // Don't cleanup on callback failure - keep state for debugging/retry
        console.error(`[OCRChunkDO] Callback failed after 3 retries, keeping state`);
        this.debugLog(`Callback failed after 3 retries, state preserved`);
        await this.saveState();
      }
    }
  }

  private async sendErrorCallback(): Promise<void> {
    const callback = this.buildCallback();
    callback.status = 'error';
    callback.error = this.state!.global_error;
    const callbackPath = `/callback/${this.state!.batch_id}/ocr`;

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
    } catch (error: any) {
      console.error(`[OCRChunkDO] Error callback failed:`, error.message);
    }

    // Don't cleanup on callback failure
    this.debugLog(`Error callback failed, state preserved`);
    await this.saveState();
  }

  private buildCallback(): OCRChunkCallback {
    const results = this.state!.pis.map(pi => {
      const refsCompleted = pi.refs.filter(r => r.status === 'done' || r.status === 'skipped').length;
      const refsFailed = pi.refs.filter(r => r.status === 'error').length;
      const failedRefs = pi.refs
        .filter(r => r.status === 'error')
        .map(r => ({ filename: r.filename, error: r.error || 'Unknown error' }));

      let status: 'success' | 'partial' | 'error';
      if (pi.entity_error) {
        status = 'error';
      } else if (refsFailed > 0 && refsCompleted > 0) {
        status = 'partial';
      } else if (refsFailed === pi.refs.length) {
        status = 'error';
      } else {
        status = 'success';
      }

      return {
        pi: pi.pi,
        status,
        new_tip: pi.new_tip,
        new_version: pi.new_version,
        refs_completed: refsCompleted,
        refs_failed: refsFailed,
        failed_refs: failedRefs.length > 0 ? failedRefs : undefined,
      };
    });

    const overallStatus = results.every(r => r.status === 'success') ? 'success' :
                          results.every(r => r.status === 'error') ? 'error' : 'partial';

    return {
      batch_id: this.state!.batch_id,
      chunk_id: this.state!.chunk_id,
      status: overallStatus,
      results,
      summary: {
        total_refs: this.state!.total_refs,
        completed: this.state!.completed_refs,
        failed: this.state!.failed_refs,
        skipped: this.state!.skipped_refs,
        processing_time_ms: this.state!.completed_at
          ? new Date(this.state!.completed_at).getTime() - new Date(this.state!.started_at).getTime()
          : Date.now() - new Date(this.state!.started_at).getTime(),
      },
    };
  }

  private async handleGlobalError(error: Error): Promise<void> {
    this.state!.global_retry_count++;
    const maxRetries = parseInt(this.env.MAX_GLOBAL_RETRIES || '5');

    if (this.state!.global_retry_count >= maxRetries) {
      this.state!.phase = 'ERROR';
      this.state!.global_error = error.message;
      await this.saveState();
      await this.ctx.storage.setAlarm(Date.now() + 100);
      return;
    }

    const delay = Math.min(60000, 1000 * Math.pow(2, this.state!.global_retry_count));
    console.log(`[OCRChunkDO] Global error, retry ${this.state!.global_retry_count}/${maxRetries} after ${delay}ms`);
    await this.saveState();
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  private async cleanup(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.state = null;
  }

  private getPendingRefs(): RefState[] {
    if (!this.state) return [];
    const pending: RefState[] = [];
    for (const pi of this.state.pis) {
      for (const ref of pi.refs) {
        if (ref.status === 'pending') {
          pending.push(ref);
        }
      }
    }
    return pending;
  }

  private async loadState(): Promise<void> {
    this.state = await this.ctx.storage.get<OCRChunkState>(STATE_KEY) || null;
  }

  private async saveState(): Promise<void> {
    if (this.state) {
      await this.ctx.storage.put(STATE_KEY, this.state);
    }
  }
}
