import { IPFSUploadResult, IPFSAppendVersionResult } from '../types';

/**
 * Client for the Arke IPFS Wrapper API
 *
 * Uses service binding to communicate with arke-ipfs-api worker.
 */
export class IPFSWrapperClient {
  constructor(private fetcher: Fetcher) {}

  /**
   * Determine network from PI prefix
   * Test network PIs start with 'II'
   */
  private getNetworkHeader(pi: string): Record<string, string> {
    if (pi.startsWith('II')) {
      return { 'X-Arke-Network': 'test' };
    }
    return {};
  }

  /**
   * Upload content to IPFS and get back a CID
   *
   * Uses multipart/form-data as per API spec
   */
  async uploadContent(content: string, filename: string = 'file'): Promise<string> {
    // Create form data
    const formData = new FormData();
    const blob = new Blob([content], { type: 'application/json' });
    formData.append('file', blob, filename);

    const response = await this.fetcher.fetch('https://api/upload', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`IPFS upload failed (${response.status}): ${error}`);
    }

    const results: IPFSUploadResult[] = await response.json();
    if (!results || results.length === 0) {
      throw new Error('IPFS upload returned no results');
    }

    return results[0].cid;
  }

  /**
   * Append a new version to an entity with CAS protection
   *
   * @param pi - Entity identifier
   * @param expectTip - Current tip CID (for CAS)
   * @param components - Map of filename -> CID to update
   * @param note - Optional change description
   */
  async appendVersion(
    pi: string,
    expectTip: string,
    components: Record<string, string>,
    note?: string
  ): Promise<IPFSAppendVersionResult> {
    const body: {
      expect_tip: string;
      components: Record<string, string>;
      note?: string;
    } = {
      expect_tip: expectTip,
      components,
    };

    if (note) {
      body.note = note;
    }

    const response = await this.fetcher.fetch(`https://api/entities/${pi}/versions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.getNetworkHeader(pi),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();

      // Check for CAS failure
      if (response.status === 409) {
        throw new CASFailureError(`CAS failure for ${pi}: ${error}`);
      }

      throw new Error(`IPFS append version failed (${response.status}): ${error}`);
    }

    return await response.json();
  }

  /**
   * Get current entity tip (for refreshing after CAS failure)
   */
  async getEntityTip(pi: string): Promise<string> {
    const response = await this.fetcher.fetch(`https://api/resolve/${pi}`, {
      method: 'GET',
      headers: this.getNetworkHeader(pi),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`IPFS resolve failed (${response.status}): ${error}`);
    }

    const result: { pi: string; tip: string } = await response.json();
    return result.tip;
  }

  /**
   * Append version with automatic CAS retry
   *
   * If CAS fails, fetches fresh tip and retries up to maxRetries times.
   */
  async appendVersionWithRetry(
    pi: string,
    initialTip: string,
    components: Record<string, string>,
    note?: string,
    maxRetries: number = 3
  ): Promise<IPFSAppendVersionResult> {
    let currentTip = initialTip;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.appendVersion(pi, currentTip, components, note);
      } catch (error: any) {
        lastError = error;

        if (error instanceof CASFailureError) {
          console.log(`[IPFS] CAS failure for ${pi}, fetching fresh tip (attempt ${attempt + 1}/${maxRetries})`);

          // Fetch fresh tip and retry
          try {
            currentTip = await this.getEntityTip(pi);
          } catch (tipError: any) {
            throw new Error(`Failed to get fresh tip after CAS failure: ${tipError.message}`);
          }

          // Wait a bit before retrying
          await sleep(100 * (attempt + 1));
          continue;
        }

        // Non-CAS error, don't retry
        throw error;
      }
    }

    throw lastError || new Error('appendVersionWithRetry failed after all retries');
  }
}

/**
 * Error thrown when CAS (Compare-And-Swap) fails
 */
export class CASFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CASFailureError';
  }
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
