# OCR Service DO Implementation Plan

> **Note:** This service implements the canonical AI Service DO Pattern.
> See [`../SERVICE_DO_PATTERN.md`](../SERVICE_DO_PATTERN.md) for the full specification.

## Goal

Transform the OCR service from a stateless single-image worker into an independent Durable Object that can:

1. Accept a **chunk** of PIs (5-10 PIs per DO)
2. Process all refs for those PIs with robust rate limiting
3. Handle DeepInfra rate limits with adaptive backoff
4. Write results directly to R2 + IPFS
5. Callback orchestrator when complete

## Fan-Out Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Orchestrator DO                               │
│                                                                      │
│  500 PIs need OCR                                                    │
│  → Chunk into groups of 10                                          │
│  → Dispatch 50 OCR DOs in parallel (1 subrequest each)              │
│  → Wait for callbacks                                                │
└─────────────────────────────────────────────────────────────────────┘
         │         │         │         │         │
         │         │         │         │         │
         ▼         ▼         ▼         ▼         ▼
    ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
    │ OCR DO │ │ OCR DO │ │ OCR DO │ │ OCR DO │ │ OCR DO │  ... x50
    │chunk:0 │ │chunk:1 │ │chunk:2 │ │chunk:3 │ │chunk:4 │
    │10 PIs  │ │10 PIs  │ │10 PIs  │ │10 PIs  │ │10 PIs  │
    │~50 refs│ │~50 refs│ │~50 refs│ │~50 refs│ │~50 refs│
    └────────┘ └────────┘ └────────┘ └────────┘ └────────┘
         │         │         │         │         │
         │    Each DO has:                       │
         │    - Own 1000 subrequest budget       │
         │    - Own rate limiter                 │
         │    - Own retry state                  │
         │         │         │         │         │
         ▼         ▼         ▼         ▼         ▼
    ┌─────────────────────────────────────────────────┐
    │              DeepInfra olmOCR-2 API             │
    │                                                  │
    │  Total capacity: 50 DOs × ~5 RPS = ~250 RPS    │
    │  (vs single DO at ~10 RPS)                      │
    └─────────────────────────────────────────────────┘
```

## DO Naming & Identity

```
DO ID: ocr:{batch_id}:{chunk_id}

Examples:
- ocr:batch_abc123:0
- ocr:batch_abc123:1
- ocr:batch_abc123:2
...
```

The `chunk_id` is just an index (0, 1, 2...) assigned by the orchestrator when chunking PIs.

---

## API Design

### POST /process - Start OCR Chunk

**Request:**
```typescript
interface OCRChunkRequest {
  // Identity
  batch_id: string;
  chunk_id: string;              // "0", "1", "2", etc.

  // Callback
  callback_url: string;          // Where to POST when done

  // Work items - array of PIs with their refs
  pis: Array<{
    pi: string;
    current_tip: string;         // For CAS on entity update
    refs: Array<{
      filename: string;          // e.g., "photo.jpg.ref.json"
      staging_key: string;       // R2 key for ref JSON
      cdn_url: string;           // CDN URL for image (already computed by orchestrator)
    }>;
  }>;
}
```

**Response:**
```typescript
{
  status: 'accepted';
  chunk_id: string;
  total_pis: number;
  total_refs: number;
}
```

### GET /status/:batchId/:chunkId - Check Progress

**Response:**
```typescript
{
  status: 'processing' | 'done' | 'error';
  phase: 'FETCHING' | 'PROCESSING' | 'PUBLISHING' | 'DONE' | 'ERROR';

  progress: {
    total_refs: number;
    completed: number;
    failed: number;
    pending: number;
  };

  rate_limiter: {
    tokens: number;
    max_tokens: number;
    rps: number;
    backoff_until?: string;      // ISO timestamp if in backoff
  };

  error?: string;
}
```

### Callback Payload (POST to callback_url)

```typescript
interface OCRChunkCallback {
  batch_id: string;
  chunk_id: string;
  status: 'success' | 'partial' | 'error';

  // Per-PI results
  results: Array<{
    pi: string;
    status: 'success' | 'partial' | 'error';
    new_tip?: string;            // Updated entity tip
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
    processing_time_ms: number;
  };

  error?: string;                // Global error if status === 'error'
}
```

---

## State Machine

```
┌─────────────┐
│   PENDING   │  Initial state after request received
└──────┬──────┘
       │ alarm fires
       ▼
┌─────────────┐
│  FETCHING   │  Load ref data from R2 for all PIs
└──────┬──────┘  (Could skip if orchestrator passes ref data in request)
       │
       ▼
┌─────────────────────────────────────────────────┐
│              PROCESSING                          │
│                                                  │
│  For each ref:                                   │
│  1. Check rate limiter tokens                    │
│  2. If tokens available: start OCR call          │
│  3. On success: mark done, update ref in R2      │
│  4. On 429: backoff, re-queue ref                │
│  5. On error: retry or mark failed               │
│                                                  │
│  Alarm fires every 200-500ms to process more     │
└──────────────────┬──────────────────────────────┘
                   │ all refs done (or failed)
                   ▼
           ┌─────────────┐
           │ PUBLISHING  │  Upload refs to IPFS, update entities
           └──────┬──────┘
                  │
                  ▼
           ┌─────────────┐
           │    DONE     │  Send callback, cleanup
           └─────────────┘

Error handling:
- Transient errors → retry with backoff (up to MAX_RETRIES)
- After MAX_RETRIES → mark ref as failed, continue others
- Global failure → ERROR state, error callback
```

---

## Rate Limiting Strategy

### Problem
DeepInfra doesn't document rate limits. We've observed ~10-20 RPS before 429 errors, but this varies.

### Solution: Adaptive Token Bucket

```typescript
interface RateLimiter {
  // Token bucket state
  tokens: number;              // Current available tokens
  max_tokens: number;          // Max tokens (bucket size)
  refill_rate: number;         // Tokens added per second
  last_refill: number;         // Timestamp of last refill

  // Adaptive state
  consecutive_successes: number;
  consecutive_429s: number;
  backoff_until?: number;      // Don't make requests until this time
}

// Configuration
const INITIAL_MAX_TOKENS = 5;
const INITIAL_REFILL_RATE = 3;  // Conservative start
const MAX_MAX_TOKENS = 15;
const MAX_REFILL_RATE = 10;
const MIN_MAX_TOKENS = 2;
const MIN_REFILL_RATE = 1;
```

### Algorithm

```typescript
function refillTokens(limiter: RateLimiter): void {
  const now = Date.now();
  const elapsed = (now - limiter.last_refill) / 1000;
  const tokensToAdd = elapsed * limiter.refill_rate;
  limiter.tokens = Math.min(limiter.max_tokens, limiter.tokens + tokensToAdd);
  limiter.last_refill = now;
}

function canMakeRequest(limiter: RateLimiter): boolean {
  // In backoff?
  if (limiter.backoff_until && Date.now() < limiter.backoff_until) {
    return false;
  }

  refillTokens(limiter);
  return limiter.tokens >= 1;
}

function consumeToken(limiter: RateLimiter): void {
  limiter.tokens -= 1;
}

function onSuccess(limiter: RateLimiter): void {
  limiter.consecutive_successes++;
  limiter.consecutive_429s = 0;

  // Speed up after 10 consecutive successes
  if (limiter.consecutive_successes >= 10) {
    limiter.max_tokens = Math.min(MAX_MAX_TOKENS, limiter.max_tokens + 1);
    limiter.refill_rate = Math.min(MAX_REFILL_RATE, limiter.refill_rate + 0.5);
    limiter.consecutive_successes = 0;
    console.log(`[RateLimit] Increased: max=${limiter.max_tokens}, rate=${limiter.refill_rate}`);
  }
}

function onRateLimit(limiter: RateLimiter): void {
  limiter.consecutive_429s++;
  limiter.consecutive_successes = 0;

  // Slow down
  limiter.max_tokens = Math.max(MIN_MAX_TOKENS, limiter.max_tokens - 2);
  limiter.refill_rate = Math.max(MIN_REFILL_RATE, limiter.refill_rate - 1);

  // Exponential backoff
  const backoffMs = Math.min(60000, 1000 * Math.pow(2, limiter.consecutive_429s));
  limiter.backoff_until = Date.now() + backoffMs;

  console.log(`[RateLimit] 429! Backing off ${backoffMs}ms. New: max=${limiter.max_tokens}, rate=${limiter.refill_rate}`);
}
```

---

## DO State Structure

```typescript
interface OCRChunkState {
  // Identity
  batch_id: string;
  chunk_id: string;
  callback_url: string;

  // Timestamps
  started_at: string;
  completed_at?: string;

  // Phase
  phase: 'PENDING' | 'FETCHING' | 'PROCESSING' | 'PUBLISHING' | 'DONE' | 'ERROR';

  // PIs and their refs
  pis: Array<{
    pi: string;
    current_tip: string;
    refs: Array<{
      filename: string;
      staging_key: string;
      cdn_url: string;

      // Processing state
      status: 'pending' | 'processing' | 'done' | 'skipped' | 'error';
      error?: string;
      retry_count: number;

      // Result
      result_cid?: string;       // CID of updated ref JSON in IPFS
      ocr_text_length?: number;  // For logging
    }>;

    // PI-level state
    entity_updated: boolean;
    new_tip?: string;
    new_version?: number;
    entity_error?: string;
  }>;

  // Rate limiter
  rate_limiter: RateLimiter;

  // Counters
  total_refs: number;
  completed_refs: number;
  failed_refs: number;
  skipped_refs: number;         // Already had OCR

  // Error tracking
  global_error?: string;
  global_retry_count: number;
}
```

---

## File Structure

```
arke-ocr-service/
├── src/
│   ├── index.ts                 # Worker entry + routing
│   ├── types.ts                 # All TypeScript interfaces
│   │
│   ├── do/
│   │   ├── OCRChunkDO.ts        # Main Durable Object class
│   │   ├── phases/
│   │   │   ├── fetching.ts      # FETCHING phase logic
│   │   │   ├── processing.ts    # PROCESSING phase logic (main OCR loop)
│   │   │   └── publishing.ts    # PUBLISHING phase logic
│   │   └── rate-limiter.ts      # Adaptive rate limiter
│   │
│   ├── services/
│   │   ├── deepinfra.ts         # DeepInfra OCR client with retry
│   │   └── ipfs-client.ts       # IPFS wrapper client
│   │
│   └── utils/
│       ├── cdn-url.ts           # CDN URL helpers (medium variant, etc.)
│       └── errors.ts            # Error classification (permanent vs transient)
│
├── wrangler.jsonc
├── package.json
├── tsconfig.json
└── IMPLEMENTATION_PLAN.md       # This file
```

---

## Implementation Steps

### Step 1: Types & Interfaces
Create `src/types.ts` with all the interfaces defined above.

### Step 2: Rate Limiter
Create `src/do/rate-limiter.ts`:
- Token bucket implementation
- Adaptive speed up/slow down
- Backoff tracking

### Step 3: DeepInfra Client
Update `src/services/deepinfra.ts`:
- Keep existing `extractTextFromImage` function
- Add wrapper with single-retry for transient errors (not 429)
- Return structured result with tokens count
- Classify errors as permanent vs transient

### Step 4: IPFS Client
Create `src/services/ipfs-client.ts`:
- `uploadContent(content: string): Promise<string>` - returns CID
- `appendVersion(pi, components, note): Promise<{tip, ver}>`

### Step 5: OCRChunkDO Skeleton
Create `src/do/OCRChunkDO.ts`:
- Constructor
- `fetch()` handler for /process and /status
- `alarm()` handler with phase dispatch
- State load/save helpers

### Step 6: FETCHING Phase
Create `src/do/phases/fetching.ts`:
- For now: just validate refs exist (orchestrator passes everything we need)
- Future: could fetch ref data from R2 if not passed in request

### Step 7: PROCESSING Phase
Create `src/do/phases/processing.ts`:
- Main OCR processing loop
- Rate limiter integration
- Parallel processing (process multiple refs per alarm)
- Handle success/429/error for each ref
- Update ref in R2 staging after OCR
- Schedule next alarm

### Step 8: PUBLISHING Phase
Create `src/do/phases/publishing.ts`:
- Upload each updated ref to IPFS (get CID)
- Batch update entity per PI (one `appendVersion` call per PI)
- Track new tips/versions

### Step 9: Callback & Cleanup
- Send callback to orchestrator
- Retry callback if it fails
- Clear DO storage after successful callback

### Step 10: Worker Entry Point
Update `src/index.ts`:
- Route `/process` to DO
- Route `/status/:batchId/:chunkId` to DO
- Keep legacy `/ocr` endpoint for backwards compatibility (or deprecate)

### Step 11: Wrangler Config
Update `wrangler.jsonc`:
- Add DO binding
- Add R2 bucket binding
- Add IPFS_WRAPPER service binding
- Add configuration vars

---

## Wrangler Configuration

```jsonc
{
  "name": "arke-ocr-service",
  "main": "src/index.ts",
  "compatibility_date": "2024-10-01",
  "compatibility_flags": ["nodejs_compat"],

  "durable_objects": {
    "bindings": [
      {
        "name": "OCR_CHUNK_DO",
        "class_name": "OCRChunkDO"
      }
    ]
  },

  "migrations": [
    {
      "tag": "v1",
      "new_classes": ["OCRChunkDO"]
    }
  ],

  "r2_buckets": [
    {
      "binding": "STAGING_BUCKET",
      "bucket_name": "arke-staging"
    }
  ],

  "services": [
    {
      "binding": "IPFS_WRAPPER",
      "service": "arke-ipfs-api"
    }
  ],

  "vars": {
    "ENVIRONMENT": "development",

    // Rate limiting
    "INITIAL_MAX_TOKENS": "5",
    "INITIAL_REFILL_RATE": "3",
    "MAX_REFILL_RATE": "10",

    // Retry config
    "MAX_RETRIES_PER_REF": "3",
    "MAX_GLOBAL_RETRIES": "5",

    // Processing
    "ALARM_INTERVAL_MS": "300",
    "MAX_CONCURRENT_PER_ALARM": "5"
  }
}
```

---

## Orchestrator Integration

### Chunking Logic

```typescript
// In orchestrator, when starting OCR phase:

function chunkPIs(pis: PIWithRefs[], chunkSize: number): PIWithRefs[][] {
  const chunks: PIWithRefs[][] = [];
  for (let i = 0; i < pis.length; i += chunkSize) {
    chunks.push(pis.slice(i, i + chunkSize));
  }
  return chunks;
}

async function dispatchOCRChunks(
  state: BatchState,
  env: Env,
  config: Config
): Promise<void> {
  const pisNeedingOCR = getPIsNeedingOCR(state);
  const chunks = chunkPIs(pisNeedingOCR, config.OCR_CHUNK_SIZE); // e.g., 10

  console.log(`[OCR] Dispatching ${chunks.length} chunks (${pisNeedingOCR.length} PIs)`);

  // Dispatch all chunks in parallel
  const dispatches = chunks.map((chunk, index) => {
    const chunkId = String(index);
    const doId = env.OCR_CHUNK_DO.idFromName(`ocr:${state.batch_id}:${chunkId}`);
    const stub = env.OCR_CHUNK_DO.get(doId);

    return stub.fetch('https://ocr/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batch_id: state.batch_id,
        chunk_id: chunkId,
        callback_url: `https://orchestrator.arke.institute/callback/${state.batch_id}/ocr`,
        pis: chunk.map(pi => ({
          pi: pi.pi,
          current_tip: pi.current_tip,
          refs: pi.refs.map(r => ({
            filename: r.filename,
            staging_key: r.staging_key,
            cdn_url: r.cdn_url
          }))
        }))
      })
    });
  });

  await Promise.all(dispatches);

  // Track dispatched chunks
  state.ocr_chunks = chunks.map((_, i) => ({
    chunk_id: String(i),
    status: 'dispatched',
    dispatched_at: new Date().toISOString()
  }));
}
```

### Callback Handler

```typescript
// In orchestrator:

async handleOCRCallback(payload: OCRChunkCallback): Promise<void> {
  await this.loadState();

  // Find chunk
  const chunk = this.state.ocr_chunks?.find(c => c.chunk_id === payload.chunk_id);
  if (chunk) {
    chunk.status = payload.status === 'error' ? 'error' : 'complete';
    chunk.completed_at = new Date().toISOString();
  }

  // Update PI states from results
  for (const result of payload.results) {
    const node = this.findNodeByPi(result.pi);
    if (!node) continue;

    if (result.new_tip) {
      node.current_tip = result.new_tip;
      node.current_version = result.new_version;
    }

    // Mark refs as complete
    for (const ref of node.refs) {
      const failed = result.failed_refs?.find(f => f.filename === ref.filename);
      if (failed) {
        ref.ocr_error = failed.error;
      } else {
        ref.ocr_complete = true;
      }
    }

    // Check if all refs done
    const ocrRefs = node.refs.filter(r => isOCRCompatibleImage(r.filename));
    if (ocrRefs.every(r => r.ocr_complete || r.ocr_error)) {
      node.ocr_complete = true;
    }
  }

  // Check if all chunks complete
  const allChunksComplete = this.state.ocr_chunks?.every(
    c => c.status === 'complete' || c.status === 'error'
  );

  if (allChunksComplete) {
    // Move to next phase
    this.state.status = 'REORGANIZATION';
  }

  await this.saveState();
}
```

---

## Configuration Tuning

| Parameter | Default | Notes |
|-----------|---------|-------|
| `OCR_CHUNK_SIZE` | 10 | PIs per chunk. Tune based on avg refs per PI. |
| `INITIAL_MAX_TOKENS` | 5 | Start conservative |
| `INITIAL_REFILL_RATE` | 3 | Tokens per second |
| `MAX_REFILL_RATE` | 10 | Don't exceed this even after speedup |
| `MAX_RETRIES_PER_REF` | 3 | Retries for transient errors (not 429) |
| `ALARM_INTERVAL_MS` | 300 | How often to check for work |

### Sizing Example

```
Batch: 500 PIs, avg 5 refs each = 2,500 total refs

OCR_CHUNK_SIZE = 10
→ 50 chunks
→ 50 DOs spawned in parallel

Each DO: 10 PIs × 5 refs = 50 refs
At 5 RPS initial rate: ~10 seconds per DO
With adaptive speedup to 10 RPS: ~5 seconds per DO

Total time: ~10 seconds (all parallel)
vs. single worker at 10 RPS: ~250 seconds

25x speedup!
```

---

## Error Handling

### Permanent Errors (don't retry)
- Unsupported image format
- Invalid URL
- Image too large
- Corrupt image

### Transient Errors (retry with backoff)
- Network timeout
- 5xx server errors
- Connection refused

### Rate Limit (special handling)
- 429 errors
- Trigger rate limiter backoff
- Re-queue ref for later

### Global Errors
- If too many refs fail, mark chunk as error
- Send error callback
- Orchestrator can retry entire chunk later

---

## Testing Plan

### Unit Tests
1. Rate limiter token bucket logic
2. Adaptive speedup/slowdown
3. Error classification
4. State transitions

### Integration Tests
1. Single ref OCR end-to-end
2. Multiple refs with rate limiting
3. 429 handling and backoff
4. Entity update batching
5. Callback delivery

### Load Tests
1. 100 refs in single chunk
2. Multiple chunks in parallel
3. Sustained rate limiting
4. Recovery after backoff

---

## Migration Path

### Phase 1: Build & Test (Days 1-3)
- [ ] Implement types and interfaces
- [ ] Implement rate limiter
- [ ] Implement OCRChunkDO skeleton
- [ ] Implement processing phase
- [ ] Test with single chunk manually

### Phase 2: Publishing & Callbacks (Days 4-5)
- [ ] Implement IPFS client
- [ ] Implement publishing phase
- [ ] Implement callback logic
- [ ] Test full lifecycle

### Phase 3: Orchestrator Integration (Days 6-7)
- [ ] Add chunking logic to orchestrator
- [ ] Add callback handler
- [ ] Test end-to-end with real batch
- [ ] Monitor rate limiter behavior

### Phase 4: Tuning & Cleanup (Day 8)
- [ ] Tune chunk size based on observations
- [ ] Tune rate limiter parameters
- [ ] Remove/deprecate old `/ocr` endpoint
- [ ] Update documentation
