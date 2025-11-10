import { Env, OCRRequest, OCRResponse, ErrorResponse } from './types';
import { createDeepInfraClient, extractTextFromImage } from './utils/deepinfra';

/**
 * Converts binary image data to base64 data URL
 */
function createImageDataUrl(imageBuffer: ArrayBuffer, mimeType: string): string {
  const bytes = new Uint8Array(imageBuffer);
  const binary = Array.from(bytes)
    .map((byte) => String.fromCharCode(byte))
    .join('');
  const base64 = btoa(binary);
  return `data:${mimeType};base64,${base64}`;
}

/**
 * Validates that the Content-Type is a supported image MIME type
 * Supported formats: JPEG, PNG, WebP (per DeepInfra olmOCR-2 documentation)
 */
function isValidImageContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const supportedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  return supportedTypes.includes(contentType.toLowerCase());
}

/**
 * Validates that a string is a valid HTTP/HTTPS URL
 */
function isValidHttpUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Gets image dimensions from binary data
 */
async function getImageDimensions(imageBuffer: ArrayBuffer, mimeType: string): Promise<{ width: number; height: number } | null> {
  try {
    // For now, we'll return null as dimension checking in Cloudflare Workers
    // requires additional image processing libraries
    // This is a placeholder for future enhancement
    return null;
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Only accept POST requests
    if (request.method !== 'POST') {
      return Response.json(
        { error: 'Method not allowed' } as ErrorResponse,
        { status: 405 }
      );
    }

    // Only handle /ocr endpoint
    const url = new URL(request.url);
    if (url.pathname !== '/ocr') {
      return Response.json(
        { error: 'Not found' } as ErrorResponse,
        { status: 404 }
      );
    }

    try {
      // Check for API key
      if (!env.DEEPINFRA_API_KEY) {
        return Response.json(
          {
            error: 'Configuration error',
            details: 'DEEPINFRA_API_KEY not configured',
          } as ErrorResponse,
          { status: 500 }
        );
      }

      const contentType = request.headers.get('Content-Type');
      let imageUrl: string;
      let fallbackUrl: string | undefined;

      // Handle JSON input with URL
      if (contentType?.includes('application/json')) {
        const body = await request.json() as OCRRequest;

        if (!body.imageUrl) {
          return Response.json(
            {
              error: 'Invalid request',
              details: 'imageUrl field is required in JSON body',
            } as ErrorResponse,
            { status: 400 }
          );
        }

        if (!isValidHttpUrl(body.imageUrl)) {
          return Response.json(
            {
              error: 'Invalid URL',
              details: 'imageUrl must be a valid HTTP or HTTPS URL',
            } as ErrorResponse,
            { status: 400 }
          );
        }

        // For Arke CDN images, try to use the /medium variant (1288px)
        // which is optimal for OCR token usage
        if (body.imageUrl.includes('cdn.arke.institute/asset/')) {
          // Try to request the medium variant
          // Pattern: https://cdn.arke.institute/asset/{assetId} or
          //          https://cdn.arke.institute/asset/{assetId}/original
          const assetIdMatch = body.imageUrl.match(/\/asset\/([A-Z0-9]+)(?:\/\w+)?/);
          if (assetIdMatch) {
            const assetId = assetIdMatch[1];
            imageUrl = `https://cdn.arke.institute/asset/${assetId}/medium`;
            // Keep the original base URL as fallback (for non-variant assets)
            fallbackUrl = `https://cdn.arke.institute/asset/${assetId}`;
          } else {
            imageUrl = body.imageUrl;
          }
        } else {
          imageUrl = body.imageUrl;
        }
      }
      // Handle binary image input
      else if (isValidImageContentType(contentType)) {
        // Read binary image data
        const imageBuffer = await request.arrayBuffer();
        if (imageBuffer.byteLength === 0) {
          return Response.json(
            { error: 'Empty request body' } as ErrorResponse,
            { status: 400 }
          );
        }

        // Convert to base64 data URL
        imageUrl = createImageDataUrl(imageBuffer, contentType!);
      }
      // Invalid Content-Type
      else {
        return Response.json(
          {
            error: 'Invalid Content-Type',
            details: 'Content-Type must be application/json (for URL input) or a supported image type. Supported formats: image/jpeg, image/png, image/webp. Note: For best results, images should have their longest dimension at 1288 pixels.',
          } as ErrorResponse,
          { status: 400 }
        );
      }

      // Initialize DeepInfra client and extract text
      const client = createDeepInfraClient(env.DEEPINFRA_API_KEY);
      const result = await extractTextFromImage(client, imageUrl, fallbackUrl);

      // Return OCR response with optional dimension warning
      const response: OCRResponse = {
        text: result.text,
        tokens: result.tokens,
      };

      // Add informational note about optimal dimensions
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-OCR-Optimal-Dimensions': '1288px on longest side',
        'X-OCR-Supported-Formats': 'image/jpeg, image/png, image/webp',
      };

      // Add header indicating which URL was actually used (if available)
      if (result.urlUsed) {
        headers['X-Image-URL-Used'] = result.urlUsed.includes('/medium') ? 'medium-variant' : 'base-url';
      }

      return Response.json(response, {
        status: 200,
        headers,
      });
    } catch (error) {
      console.error('OCR processing error:', error);

      // Handle specific error types
      if (error instanceof Error) {
        return Response.json(
          {
            error: 'OCR processing failed',
            details: error.message,
          } as ErrorResponse,
          { status: 500 }
        );
      }

      return Response.json(
        { error: 'Internal server error' } as ErrorResponse,
        { status: 500 }
      );
    }
  },
};
