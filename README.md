# arke-ocr-service

## Purpose

Heavy-lifting service for OCR extraction and LLM-based catalog description generation. Runs outside Cloudflare runtime limits to handle large images, GPU inference, and long-running LLM calls.

## Architecture

**Deployment**: EC2 instance or ECS/Fargate container in your VPC

**Runtime**: FastAPI (Python) or Express (Node.js)

**Compute**: CPU or GPU (depending on OCR model choice)

**Private**: Not exposed to public internet, only callable by `arke-orchestrator` via shared secret or mTLS

## Responsibilities

### Endpoint 1: `/ocr`
- **Input**: Image URL (presigned R2 URL or data URL)
- **Output**: Extracted text + confidence + optional layout
- **Models**:
  - Option A: DeepInfra olmOCR-2 (API, proven in LOCAL_TEST.md)
  - Option B: Local Tesseract (free, CPU)
  - Option C: Local PaddleOCR (free, GPU)
  - Option D: AWS Textract (API, expensive but excellent)

### Endpoint 2: `/summarize`
- **Input**: Context (directory name, depth) + content items (OCR texts, child descriptions, metadata)
- **Output**: Catalog description (markdown) + title + summary + structured metadata (JSON)
- **Models**:
  - Option A: DeepInfra gpt-oss-20b (API, proven in LOCAL_TEST.md)
  - Option B: Anthropic Claude (API, best quality)
  - Option C: OpenAI GPT-4 (API, good quality)
  - Option D: Local Llama (GPU, free but needs VRAM)

### Dual Prompt Strategy (from LOCAL_TEST.md)
- **Leaf nodes**: OCR + metadata → factual description of items
- **Branch nodes**: Child descriptions → synthesized collection overview
- **Output format**: Professional archival catalog entries

## Interfaces

**Called By**: `arke-orchestrator` (Durable Object)

**Calls**:
- DeepInfra API (OCR and LLM)
- Or: Local model inference (Tesseract, PaddleOCR, Llama)
- Or: AWS Textract, Anthropic, OpenAI APIs

**Authentication**: Shared secret in `Authorization` header or mTLS certificates

## Tech Stack

- **Framework**: FastAPI (Python) or Express (Node.js)
- **OCR Libraries**: DeepInfra SDK, Tesseract, PaddleOCR, or AWS SDK
- **LLM Libraries**: OpenAI SDK (compatible with DeepInfra), Anthropic SDK, or local inference
- **Image Processing**: PIL/Pillow, OpenCV
- **Deployment**: Docker container, EC2 systemd, or ECS task

## Data Contract

### OCR Endpoint: `POST /ocr`

**Request**:
```typescript
{
  image_url?: string,      // Presigned R2 URL
  image_data?: string,     // Base64 data URL
  image_path?: string,     // Local filesystem path (if co-located)
  options?: {
    language?: string,     // "eng", "fra", etc.
    layout?: boolean       // Return layout/bounding boxes
  }
}
```

**Response**:
```typescript
{
  success: boolean,
  text: string,            // Extracted text
  confidence?: number,     // 0.0-1.0 (if available)
  layout?: Array<{         // Optional bounding boxes
    text: string,
    bbox: [x, y, w, h],
    confidence: number
  }>,
  tokens?: number,         // API token usage
  cost_usd?: number,       // Cost for this call
  model: string,           // Model used
  processing_time_ms: number
}
```

### Summarize Endpoint: `POST /summarize`

**Request**:
```typescript
{
  context: {
    directory_name: string,
    depth: number,
    is_leaf: boolean       // Leaf (items) vs branch (collection)
  },
  content_items: Array<{
    type: "ocr" | "metadata" | "child_description",
    source: string,        // Filename or child directory name
    content: string        // Text content
  }>,
  options?: {
    max_length?: number,   // Max description length
    style?: "formal" | "concise" | "detailed"
  }
}
```

**Response**:
```typescript
{
  success: boolean,
  description: string,     // Full catalog description (markdown)
  title: string,           // Extracted title
  summary: string,         // Short summary (1-2 sentences)
  metadata?: {             // Structured metadata (for JSON)
    date_range?: string,
    subjects?: string[],
    creators?: string[],
    languages?: string[]
  },
  tokens: number,
  cost_usd: number,
  model: string,
  processing_time_ms: number
}
```

## Next Steps

### Phase 1: DeepInfra API Integration (Fastest Path)
1. Set up FastAPI project
2. Implement `/ocr` endpoint using DeepInfra olmOCR-2
3. Implement `/summarize` endpoint using DeepInfra gpt-oss-20b
4. Reuse prompt engineering from LOCAL_TEST.md
5. Add authentication (shared secret)
6. Deploy to EC2
7. Test with orchestrator

### Phase 2: Error Handling & Rate Limiting
1. Handle API failures gracefully
2. Implement retry logic with backoff
3. Add request queuing for rate limiting
4. Track costs per request
5. Add circuit breaker for API outages

### Phase 3: Local OCR Option
1. Add Tesseract integration (CPU-based)
2. Or: PaddleOCR (GPU-based, better quality)
3. Compare quality and speed vs DeepInfra
4. Make OCR backend configurable

### Phase 4: Local LLM Option (GPU Required)
1. Set up Llama 3.1 8B or similar
2. Use vLLM or llama.cpp for inference
3. Adapt prompts for local model
4. Compare quality vs DeepInfra
5. Cost analysis (GPU instance vs API)

### Phase 5: Production Hardening
1. Add health check endpoint
2. Implement graceful shutdown
3. Add monitoring (Prometheus metrics)
4. Log all requests for auditing
5. Set up alerting for failures
6. Add request validation (file size limits)

### Phase 6: Optimization
1. Batch OCR requests (multiple images at once)
2. Cache OCR results (deduplicate identical images)
3. Optimize LLM prompts for token usage
4. Implement streaming responses (for long descriptions)

## Key Code Structure (FastAPI Example)

```python
# main.py
from fastapi import FastAPI, HTTPException, Header
from pydantic import BaseModel
from typing import Optional, List
import httpx
from openai import OpenAI  # DeepInfra is OpenAI-compatible

app = FastAPI()

# DeepInfra client
client = OpenAI(
    api_key=os.getenv("DEEPINFRA_API_KEY"),
    base_url="https://api.deepinfra.com/v1/openai"
)

# Authentication
def verify_auth(authorization: str = Header(None)):
    expected = f"Bearer {os.getenv('SERVICE_SECRET')}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")

@app.post("/ocr")
async def ocr(request: OCRRequest, auth: str = Depends(verify_auth)):
    """Extract text from image using olmOCR-2."""

    # Fetch image if URL provided
    if request.image_url:
        async with httpx.AsyncClient() as http:
            image_bytes = await http.get(request.image_url)
            image_data = base64.b64encode(image_bytes.content).decode()
    elif request.image_data:
        image_data = request.image_data.split(',')[1]  # Strip data URL prefix
    else:
        raise HTTPException(400, "Must provide image_url or image_data")

    # Build data URL
    data_url = f"data:image/jpeg;base64,{image_data}"

    # Call olmOCR-2
    response = client.chat.completions.create(
        model="allenai/olmOCR-2",
        messages=[{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": data_url}},
                {"type": "text", "text": "Extract all text from this image."}
            ]
        }],
        max_tokens=4096,
        temperature=0.0
    )

    return {
        "success": True,
        "text": response.choices[0].message.content,
        "tokens": response.usage.total_tokens,
        "cost_usd": calculate_cost(response.usage),
        "model": response.model
    }

@app.post("/summarize")
async def summarize(request: SummarizeRequest, auth: str = Depends(verify_auth)):
    """Generate catalog description from content items."""

    # Build prompt based on is_leaf
    system_prompt = get_system_prompt(request.context.is_leaf)

    # Construct user content
    content_text = "\n\n".join([
        f"## {item.type.upper()}: {item.source}\n{item.content}"
        for item in request.content_items
    ])

    context_text = f"Directory: {request.context.directory_name} (depth {request.context.depth})"

    # Call LLM
    response = client.chat.completions.create(
        model="gpt-oss-20b",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"{context_text}\n\n{content_text}"}
        ],
        max_tokens=2000,
        temperature=0.7
    )

    description = response.choices[0].message.content

    # Extract title and summary (simple heuristics)
    title = extract_title(description, request.context.directory_name)
    summary = extract_summary(description)

    return {
        "success": True,
        "description": description,
        "title": title,
        "summary": summary,
        "tokens": response.usage.total_tokens,
        "cost_usd": calculate_cost(response.usage),
        "model": response.model
    }
```

## Configuration

```bash
# .env
DEEPINFRA_API_KEY=xxx
SERVICE_SECRET=xxx  # Shared with orchestrator
PORT=3000
LOG_LEVEL=info
```

## Deployment Options

### Option A: EC2 Instance (Simple)
```bash
# Install dependencies
pip install fastapi uvicorn openai python-dotenv httpx pillow

# Run service
uvicorn main:app --host 0.0.0.0 --port 3000

# Set up systemd service
sudo systemctl enable arke-ocr-service
sudo systemctl start arke-ocr-service
```

### Option B: Docker Container
```dockerfile
FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3000"]
```

### Option C: ECS/Fargate (Scalable)
```yaml
# task-definition.json
{
  "family": "arke-ocr-service",
  "containerDefinitions": [{
    "name": "api",
    "image": "arke-ocr-service:latest",
    "cpu": 2048,
    "memory": 4096,
    "portMappings": [{"containerPort": 3000}],
    "environment": [
      {"name": "DEEPINFRA_API_KEY", "value": "xxx"}
    ]
  }]
}
```

## Key Design Decisions

- **Python FastAPI**: Fast, async, easy to integrate with ML libraries
- **DeepInfra first**: Proven quality from LOCAL_TEST.md experiment
- **Dual endpoints**: Separation of concerns (OCR vs summarization)
- **Private service**: Not exposed to internet, orchestrator-only
- **Flexible backends**: Easy to swap OCR/LLM providers
- **Complete responses**: Include costs, tokens, timing for transparency

## Cost Comparison

### DeepInfra (API)
- **OCR**: ~$0.00023 per image (from LOCAL_TEST.md)
- **LLM**: ~$0.00002 per description
- **Total**: ~$0.00025 per image (with description)
- **Scale**: $2.80 per 10K images

### Local GPU (Llama 3.1 8B + PaddleOCR)
- **Hardware**: g5.xlarge EC2 (~$1/hour = $730/month)
- **Capacity**: ~5K images/hour
- **Break-even**: ~3M images/month
- **Pros**: No per-request cost, data privacy, customizable
- **Cons**: Higher fixed cost, maintenance overhead

**Recommendation**: Start with DeepInfra, switch to local GPU if volume > 1M images/month.

## Open Questions

- Multi-language OCR support needed?
- Should we cache OCR results (dedupe by image hash)?
- GPU instance sizing for local inference?
- Fallback strategy if API is down?
- Rate limiting per orchestrator batch?
