/**
 * Environment bindings for Cloudflare Worker
 */
export interface Env {
  // Secrets
  DEEPINFRA_API_KEY: string;

  // Service bindings
  IPFS_WRAPPER: Fetcher;
  ORCHESTRATOR: Fetcher;
  STAGING_BUCKET: R2Bucket;

  // Durable Object binding
  OCR_CHUNK_DO: DurableObjectNamespace;

  // Configuration (from wrangler.jsonc vars)
  ENVIRONMENT: string;
  MAX_PARALLEL_OCR?: string;
  MAX_RETRIES_PER_REF?: string;
  MAX_GLOBAL_RETRIES?: string;
  ALARM_INTERVAL_MS?: string;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

/**
 * Request to start processing an OCR chunk
 */
export interface OCRChunkRequest {
  // Identity
  batch_id: string;
  chunk_id: string;

  // Work items
  pis: Array<{
    pi: string;
    current_tip: string;
    refs: Array<{
      filename: string;      // e.g., "photo.jpg.ref.json"
      staging_key: string;   // R2 key for ref JSON
      cdn_url: string;       // CDN URL for image
    }>;
  }>;
}

/**
 * Response when chunk is accepted
 */
export interface OCRChunkAcceptedResponse {
  status: 'accepted';
  chunk_id: string;
  total_pis: number;
  total_refs: number;
}

/**
 * Response when chunk is already processing
 */
export interface OCRChunkAlreadyProcessingResponse {
  status: 'already_processing';
  chunk_id: string;
  phase: string;
}

/**
 * Status check response
 */
export interface OCRChunkStatusResponse {
  status: 'processing' | 'done' | 'error' | 'not_found';
  phase?: OCRPhase;

  progress?: {
    total_refs: number;
    completed: number;
    failed: number;
    skipped: number;
    pending: number;
  };

  backoff?: {
    consecutive_errors: number;
    backoff_until?: string;
  };

  error?: string;
}

/**
 * Callback payload sent to orchestrator when complete
 */
export interface OCRChunkCallback {
  batch_id: string;
  chunk_id: string;
  status: 'success' | 'partial' | 'error';

  // Per-PI results
  results: Array<{
    pi: string;
    status: 'success' | 'partial' | 'error';
    new_tip?: string;
    new_version?: number;
    refs_completed: number;
    refs_failed: number;
    failed_refs?: Array<{
      filename: string;
      error: string;
    }>;
  }>;

  // Summary
  summary: {
    total_refs: number;
    completed: number;
    failed: number;
    skipped: number;
    processing_time_ms: number;
  };

  error?: string;
}

// ============================================================================
// Internal State Types
// ============================================================================

/**
 * Processing phases
 */
export type OCRPhase = 'PENDING' | 'FETCHING' | 'PROCESSING' | 'PUBLISHING' | 'DONE' | 'ERROR';

/**
 * Status of a single ref
 */
export type RefStatus = 'pending' | 'processing' | 'done' | 'skipped' | 'error';

/**
 * State for a single ref being processed
 */
export interface RefState {
  filename: string;
  staging_key: string;
  cdn_url: string;

  // Processing state
  status: RefStatus;
  error?: string;
  retry_count: number;

  // Result
  result_cid?: string;
  ocr_text_length?: number;
}

/**
 * State for a single PI being processed
 */
export interface PIState {
  pi: string;
  current_tip: string;
  refs: RefState[];

  // PI-level state
  entity_updated: boolean;
  new_tip?: string;
  new_version?: number;
  entity_error?: string;
}

/**
 * Simple backoff state for error handling
 */
export interface BackoffState {
  consecutive_errors: number;
  backoff_until?: number;
}

/**
 * Full state for an OCR chunk DO
 */
export interface OCRChunkState {
  // Identity
  batch_id: string;
  chunk_id: string;

  // Timestamps
  started_at: string;
  completed_at?: string;

  // Phase
  phase: OCRPhase;

  // PIs and their refs
  pis: PIState[];

  // Backoff state for rate limit handling
  backoff: BackoffState;

  // Counters
  total_refs: number;
  completed_refs: number;
  failed_refs: number;
  skipped_refs: number;

  // Error tracking
  global_error?: string;
  global_retry_count: number;

  // Debug log (stored in state for debugging)
  debug_log?: string[];
}

// ============================================================================
// Service Types
// ============================================================================

/**
 * Result from DeepInfra OCR call
 */
export interface OCRResult {
  text: string;
  tokens: number;
}

/**
 * Ref data structure (stored in R2 staging)
 */
export interface RefData {
  url: string;
  ipfs_cid?: string;
  type?: string;
  size?: number;
  filename?: string;
  ocr?: string;
}

/**
 * Result from IPFS upload
 */
export interface IPFSUploadResult {
  cid: string;
  size: number;
}

/**
 * Result from IPFS append version
 */
export interface IPFSAppendVersionResult {
  id: string;
  type: string;
  ver: number;
  manifest_cid: string;
  tip: string;
}

