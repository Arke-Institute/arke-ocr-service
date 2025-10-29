import OpenAI from 'openai';

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
 */
export async function extractTextFromImage(
  client: OpenAI,
  imageDataUrl: string
): Promise<{ text: string; tokens: number }> {
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
    max_tokens: 4096,
    temperature: 0.0,
  });

  const extractedText = response.choices[0]?.message?.content || '';
  const totalTokens = response.usage?.total_tokens || 0;

  return {
    text: extractedText,
    tokens: totalTokens,
  };
}
