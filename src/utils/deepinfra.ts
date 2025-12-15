import OpenAI from 'openai/index.mjs';

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
 * Extracts text from an image using olmOCR-2 model
 * Supports fallback URL for retry on 400 errors (e.g., non-variant assets)
 */
export async function extractTextFromImage(
  client: OpenAI,
  imageDataUrl: string,
  fallbackUrl?: string
): Promise<{ text: string; tokens: number; urlUsed?: string }> {
  try {
    const response = await client.chat.completions.create({
      model: 'allenai/olmOCR-2',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: imageDataUrl },
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
      urlUsed: imageDataUrl,
    };
  } catch (error: any) {
    // Check if this is a 400 error from failed image download (non-variant asset)
    // and we have a fallback URL to try
    if (fallbackUrl &&
        error?.message?.includes('400') &&
        error?.message?.includes('Failed to download')) {

      console.log(`Retrying with fallback URL: ${fallbackUrl}`);

      // Retry with the fallback URL
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
        urlUsed: fallbackUrl,
      };
    }

    // Re-throw if not a fallback-able error or no fallback available
    throw error;
  }
}
