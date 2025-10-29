
  The arke-ocr-service is a separate Cloudflare Worker that provides OCR (Optical
   Character Recognition) functionality. Here's what it needs to do:

  Input Structure

  - HTTP Method: POST to /ocr endpoint
  - Headers: Content-Type with the image MIME type (e.g., image/jpeg, image/png)
  - Body: Raw binary image data as a stream

  Output Structure

  The service must return a JSON response matching this interface:
  {
    text: string;          // Extracted text from the image
    confidence: number;    // OCR confidence score (0-1 or 0-100)
    cost_usd: number;      // Cost of the operation in USD
    tokens: number;        // Number of tokens consumed
  }

  Responsibilities

  1. Extract text from image files using OCR technology (likely Claude Vision API
   or similar)
  2. Provide confidence scores to assess OCR quality
  3. Track costs for billing and monitoring purposes
  4. Count tokens used by the underlying OCR API
  5. Handle errors gracefully and return appropriate HTTP status codes

  Integration Details

  - Called via Cloudflare Service Binding (OCR_SERVICE) for efficient
  worker-to-worker communication
  - Processes images stored in R2 staging bucket
  - Processed in batches of 10 (configurable via BATCH_SIZE_OCR)
  - Results saved to R2 at {r2_prefix}derived/{path}/{filename}/ocr.txt
  - Costs and tokens accumulated in batch state for tracking

  The orchestrator expects the service to be deployed as a separate Cloudflare
  Worker named arke-ocr-service (as configured in wrangler.jsonc:44-46).