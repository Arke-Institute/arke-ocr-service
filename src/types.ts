/**
 * OCR response structure expected by the orchestrator
 */
export interface OCRResponse {
  text: string;          // Extracted text from the image
  tokens: number;        // Number of tokens consumed
}

/**
 * Error response structure
 */
export interface ErrorResponse {
  error: string;
  details?: string;
}

/**
 * Environment bindings for Cloudflare Worker
 */
export interface Env {
  DEEPINFRA_API_KEY: string;
}
