/**
 * Context Fetcher for OCR Service
 *
 * Fetches entity from IPFS and extracts refs that need OCR processing.
 */

import { IPFSWrapperClient } from '../services/ipfs-client';
import { RefData } from '../types';

export interface RefContext {
  filename: string;
  cdn_url: string;
  cid: string;
  ref_data: RefData;
}

export interface PIContext {
  pi: string;
  refs: RefContext[];
}

/**
 * Fetch context for a single PI
 *
 * Gets the entity from IPFS, finds all .ref.json components,
 * downloads each ref JSON to get the CDN URL.
 */
export async function fetchPIContext(
  ipfs: IPFSWrapperClient,
  pi: string
): Promise<PIContext> {
  // Get entity from IPFS
  const entity = await ipfs.getEntity(pi);

  // Find all .ref.json components
  const refComponents = Object.entries(entity.components).filter(([filename]) =>
    filename.endsWith('.ref.json')
  );

  if (refComponents.length === 0) {
    console.log(`[ContextFetcher] No refs found for ${pi}`);
    return { pi, refs: [] };
  }

  console.log(`[ContextFetcher] Found ${refComponents.length} refs for ${pi}`);

  // Download each ref JSON to get the CDN URL
  const refs: RefContext[] = [];

  for (const [filename, cid] of refComponents) {
    try {
      const refData = await ipfs.downloadJSON<RefData>(cid);

      // The ref data should have a 'url' field with the CDN URL
      if (!refData.url) {
        console.warn(`[ContextFetcher] Ref ${filename} has no URL, skipping`);
        continue;
      }

      refs.push({
        filename,
        cdn_url: refData.url,
        cid,
        ref_data: refData,
      });
    } catch (error) {
      console.error(`[ContextFetcher] Failed to fetch ref ${filename}:`, error);
      // Skip this ref but continue with others
    }
  }

  console.log(`[ContextFetcher] Successfully fetched ${refs.length} refs for ${pi}`);

  return { pi, refs };
}

/**
 * Fetch context for multiple PIs
 */
export async function fetchAllPIContexts(
  ipfs: IPFSWrapperClient,
  pis: string[]
): Promise<PIContext[]> {
  const results: PIContext[] = [];

  for (const pi of pis) {
    try {
      const context = await fetchPIContext(ipfs, pi);
      results.push(context);
    } catch (error) {
      console.error(`[ContextFetcher] Failed to fetch context for ${pi}:`, error);
      // Return empty context for this PI
      results.push({ pi, refs: [] });
    }
  }

  return results;
}
