import { Env, OCRChunkRequest } from './types';

// Re-export DO class for Cloudflare
export { OCRChunkDO } from './do/OCRChunkDO';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // POST /process - Start processing an OCR chunk
    if (request.method === 'POST' && url.pathname === '/process') {
      try {
        const body: OCRChunkRequest = await request.json();

        // Validate request
        if (!body.batch_id || !body.chunk_id || !body.pis) {
          return Response.json(
            { error: 'Missing required fields: batch_id, chunk_id, pis' },
            { status: 400 }
          );
        }

        // Get DO by batch_id + chunk_id
        const doId = env.OCR_CHUNK_DO.idFromName(`${body.batch_id}:${body.chunk_id}`);
        const stub = env.OCR_CHUNK_DO.get(doId);

        // Forward request to DO
        return stub.fetch(new Request('https://do/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }));
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('[OCR] /process error:', msg);
        return Response.json(
          { error: 'Invalid request', details: msg },
          { status: 400 }
        );
      }
    }

    // GET /status/:batchId/:chunkId - Check chunk status
    if (request.method === 'GET' && url.pathname.startsWith('/status/')) {
      const parts = url.pathname.split('/');
      if (parts.length === 4) {
        const batchId = parts[2];
        const chunkId = parts[3];

        const doId = env.OCR_CHUNK_DO.idFromName(`${batchId}:${chunkId}`);
        const stub = env.OCR_CHUNK_DO.get(doId);

        return stub.fetch(new Request('https://do/status', {
          method: 'GET',
        }));
      }

      return Response.json(
        { error: 'Invalid status path. Use /status/:batchId/:chunkId' },
        { status: 400 }
      );
    }

    // GET /health - Health check
    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        service: 'arke-ocr-service',
        version: '3.0.0',  // SQLite version
      });
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  },
};
