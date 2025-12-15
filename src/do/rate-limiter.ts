/**
 * Simple backoff state for handling rate limits and errors
 */
export interface BackoffState {
  consecutive_errors: number;
  backoff_until?: number;
}

/**
 * Create initial backoff state
 */
export function createBackoffState(): BackoffState {
  return {
    consecutive_errors: 0,
    backoff_until: undefined,
  };
}

/**
 * Check if currently in backoff period
 */
export function isInBackoff(state: BackoffState): boolean {
  return !!(state.backoff_until && Date.now() < state.backoff_until);
}

/**
 * Get remaining backoff time in ms (0 if not in backoff)
 */
export function getBackoffRemaining(state: BackoffState): number {
  if (!state.backoff_until) return 0;
  return Math.max(0, state.backoff_until - Date.now());
}

/**
 * Record a successful request - resets error count
 */
export function onSuccess(state: BackoffState): void {
  state.consecutive_errors = 0;
  state.backoff_until = undefined;
}

/**
 * Record a rate limit or error - triggers exponential backoff with jitter
 */
export function onError(state: BackoffState): void {
  state.consecutive_errors++;

  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, max 60s
  const baseDelay = 1000 * Math.pow(2, Math.min(state.consecutive_errors - 1, 5));
  const maxDelay = 60000;
  const delay = Math.min(baseDelay, maxDelay);

  // Add random jitter (±25%)
  const jitter = delay * 0.25 * (Math.random() * 2 - 1);
  const finalDelay = Math.round(delay + jitter);

  state.backoff_until = Date.now() + finalDelay;

  console.log(
    `[Backoff] Error #${state.consecutive_errors}, waiting ${finalDelay}ms`
  );
}

/**
 * Clear backoff (e.g., when backoff period has passed)
 */
export function clearBackoff(state: BackoffState): void {
  state.backoff_until = undefined;
}
