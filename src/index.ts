import { Env, OCRResponse, ErrorResponse } from './types';
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
 * Validates that the Content-Type is an image MIME type
 */
function isValidImageContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  return contentType.startsWith('image/');
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
      // Validate Content-Type header
      const contentType = request.headers.get('Content-Type');
      if (!isValidImageContentType(contentType)) {
        return Response.json(
          {
            error: 'Invalid Content-Type',
            details: 'Content-Type must be an image MIME type (e.g., image/jpeg, image/png)',
          } as ErrorResponse,
          { status: 400 }
        );
      }

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

      // Read binary image data
      const imageBuffer = await request.arrayBuffer();
      if (imageBuffer.byteLength === 0) {
        return Response.json(
          { error: 'Empty request body' } as ErrorResponse,
          { status: 400 }
        );
      }

      // Convert to base64 data URL
      const imageDataUrl = createImageDataUrl(imageBuffer, contentType!);

      // Initialize DeepInfra client and extract text
      const client = createDeepInfraClient(env.DEEPINFRA_API_KEY);
      const result = await extractTextFromImage(client, imageDataUrl);

      // Return OCR response
      const response: OCRResponse = {
        text: result.text,
        tokens: result.tokens,
      };

      return Response.json(response, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
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
