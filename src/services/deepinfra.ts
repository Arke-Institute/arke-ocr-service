import OpenAI from 'openai/index.mjs';
import { OCRResult } from '../types';

/**
 * Creates a DeepInfra client using OpenAI SDK
 */
export function createDeepInfraClient(apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: 'https://api.deepinfra.com/v1/openai',
  });
}

/**
 * Error thrown for permanent OCR failures (don't retry)
 */
export class PermanentOCRError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentOCRError';
  }
}

/**
 * Error thrown for rate limit errors (handled specially by rate limiter)
 */
export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

/**
 * Check if an error message indicates a permanent failure
 */
function isPermanentError(errorMessage: string): boolean {
  const permanentPatterns = [
    'unsupported base64 file format',
    'unsupported file format',
    'invalid image format',
    'failed to process some items',
    'invalid url',
    'image too large',
    'unable to decode image',
    'corrupted image',
  ];

  const lowerMessage = errorMessage.toLowerCase();
  return permanentPatterns.some(pattern => lowerMessage.includes(pattern));
}

/**
 * Check if an error message indicates a rate limit
 */
function isRateLimitError(errorMessage: string): boolean {
  const rateLimitPatterns = [
    '429',
    'rate limit',
    'too many requests',
    'rate_limit_exceeded',
  ];

  const lowerMessage = errorMessage.toLowerCase();
  return rateLimitPatterns.some(pattern => lowerMessage.includes(pattern));
}

/**
 * Build optimal image URL for OCR
 *
 * For Arke CDN images, tries to use the /medium variant (1288px)
 * which is optimal for OCR token usage.
 */
export function buildOCRImageUrl(cdnUrl: string): { primary: string; fallback?: string } {
  // For Arke CDN images, try medium variant first
  if (cdnUrl.includes('cdn.arke.institute/asset/')) {
    const match = cdnUrl.match(/\/asset\/([A-Z0-9]+)(?:\/\w+)?/);
    if (match) {
      const assetId = match[1];
      return {
        primary: `https://cdn.arke.institute/asset/${assetId}/medium`,
        fallback: `https://cdn.arke.institute/asset/${assetId}`,
      };
    }
  }

  return { primary: cdnUrl };
}

/**
 * Extract text from an image using olmOCR-2 model
 *
 * This is a single call without retries - the caller (DO) handles retries.
 * Throws:
 * - PermanentOCRError for unrecoverable errors
 * - RateLimitError for 429 errors (handled by rate limiter)
 * - Error for transient errors (retry-able)
 */
export async function extractTextFromImage(
  client: OpenAI,
  imageUrl: string,
  fallbackUrl?: string
): Promise<OCRResult> {
  try {
    const response = await client.chat.completions.create({
      model: 'allenai/olmOCR-2',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: imageUrl },
            },
            {
              type: 'text',
              text: 'Extract all text from this image.',
            },
          ],
        },
      ],
      max_tokens: 8192,
      temperature: 0.0,
    });

    const extractedText = response.choices[0]?.message?.content || '';
    const totalTokens = response.usage?.total_tokens || 0;

    return {
      text: extractedText,
      tokens: totalTokens,
    };
  } catch (error: any) {
    const errorMessage = error.message || String(error);

    // Check for rate limit
    if (isRateLimitError(errorMessage)) {
      throw new RateLimitError(`Rate limited: ${errorMessage}`);
    }

    // Check for permanent error
    if (isPermanentError(errorMessage)) {
      throw new PermanentOCRError(`Permanent OCR failure: ${errorMessage}`);
    }

    // Check if this is a 400 from failed image download and we have a fallback
    if (
      fallbackUrl &&
      errorMessage.includes('400') &&
      errorMessage.toLowerCase().includes('failed to download')
    ) {
      console.log(`[OCR] Primary URL failed, trying fallback: ${fallbackUrl}`);

      // Retry with fallback URL
      try {
        const response = await client.chat.completions.create({
          model: 'allenai/olmOCR-2',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: { url: fallbackUrl },
                },
                {
                  type: 'text',
                  text: 'Extract all text from this image.',
                },
              ],
            },
          ],
          max_tokens: 8192,
          temperature: 0.0,
        });

        const extractedText = response.choices[0]?.message?.content || '';
        const totalTokens = response.usage?.total_tokens || 0;

        return {
          text: extractedText,
          tokens: totalTokens,
        };
      } catch (fallbackError: any) {
        const fallbackMessage = fallbackError.message || String(fallbackError);

        if (isRateLimitError(fallbackMessage)) {
          throw new RateLimitError(`Rate limited on fallback: ${fallbackMessage}`);
        }

        if (isPermanentError(fallbackMessage)) {
          throw new PermanentOCRError(`Permanent OCR failure on fallback: ${fallbackMessage}`);
        }

        throw new Error(`OCR fallback failed: ${fallbackMessage}`);
      }
    }

    // Transient error - throw for retry
    throw new Error(`OCR failed: ${errorMessage}`);
  }
}

/**
 * Process OCR with automatic retry for transient errors
 *
 * Note: Does NOT retry rate limit errors (429) - those are handled by the rate limiter.
 *
 * @param cdnUrl - CDN URL of the image
 * @param apiKey - DeepInfra API key
 * @param maxRetries - Max retries for transient errors (not 429s)
 */
export async function processOCRWithRetry(
  cdnUrl: string,
  apiKey: string,
  maxRetries: number = 3
): Promise<OCRResult> {
  const client = createDeepInfraClient(apiKey);
  const { primary, fallback } = buildOCRImageUrl(cdnUrl);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await extractTextFromImage(client, primary, fallback);
    } catch (error: any) {
      lastError = error;

      // Don't retry permanent errors
      if (error instanceof PermanentOCRError) {
        throw error;
      }

      // Don't retry rate limit errors (let caller handle via rate limiter)
      if (error instanceof RateLimitError) {
        throw error;
      }

      // Transient error - retry with exponential backoff
      if (attempt < maxRetries - 1) {
        const delay = 1000 * Math.pow(2, attempt);
        console.log(`[OCR] Transient error, retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
        await sleep(delay);
      }
    }
  }

  throw lastError || new Error('OCR failed after all retries');
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
