 DeepInfra API Overview

  Both services use the OpenAI-compatible chat completions endpoint at
   DeepInfra. This means they use the OpenAI Python SDK but point it
  to DeepInfra's base URL.

  Common Setup

  from openai import OpenAI

  client = OpenAI(
      api_key=api_key,
      base_url="https://api.deepinfra.com/v1/openai"
  )

  ---
  1. olmOCR-2 (OCR Service)

  Model: allenai/olmOCR-2Location: lib/ocr.py:31

  Input Format

  The OCR API accepts images in two ways:

  A. Base64-encoded local files:

  # Encode image to base64
  base64_image = base64.b64encode(image_file.read()).decode('utf-8')

  # Create data URL with MIME type
  data_url = f"data:{mime_type};base64,{base64_image}"

  # API call
  response = client.chat.completions.create(
      model="allenai/olmOCR-2",
      messages=[{
          "role": "user",
          "content": [
              {
                  "type": "image_url",
                  "image_url": {"url": data_url}
              },
              {
                  "type": "text",
                  "text": "Extract all text from this image."
              }
          ]
      }],
      max_tokens=4096,
      temperature=0.0
  )

  B. Direct image URLs:

  response = client.chat.completions.create(
      model="allenai/olmOCR-2",
      messages=[{
          "role": "user",
          "content": [
              {
                  "type": "image_url",
                  "image_url": {"url":
  "https://example.com/image.jpg"}
              },
              {
                  "type": "text",
                  "text": "Extract all text from this image."
              }
          ]
      }],
      max_tokens=4096,
      temperature=0.0
  )

  Output Format (lib/ocr.py:134-142)

  {
      'text': str,                # Extracted text from image
      'tokens': int,              # Total tokens used
      'prompt_tokens': int,       # Input tokens (image + prompt)
      'completion_tokens': int,   # Output tokens (text generated)
      'cost_usd': float,          # Estimated cost
      'model': str,               # Model name returned
      'image_path': str          # Source image path
  }

  Pricing:
  - Input: $0.03 per 1M tokens
  - Output: $0.14 per 1M tokens