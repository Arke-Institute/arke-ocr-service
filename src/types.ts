/**
 * OCR request structure for URL-based input
 */
export interface OCRRequest {
  imageUrl: string;      // URL of the image to process
}

/**
 * OCR response structure expected by the orchestrator
 */
export interface OCRResponse {
  text: string;          // Extracted text from the image
  tokens: number;        // Number of tokens consumed
  warning?: string;      // Optional warning message (e.g., about dimensions)
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
