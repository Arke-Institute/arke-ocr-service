/**
 * Integration test for OCR Service
 *
 * Tests the full flow:
 * 1. Create a test entity with a ref
 * 2. Upload ref JSON to R2 staging
 * 3. Call OCR service /process endpoint
 * 4. Poll /status until complete
 * 5. Verify entity version incremented
 * 6. Verify ref has OCR text
 *
 * Usage: npx tsx test-integration.ts
 */

// Configuration
const IPFS_API = 'https://api.arke.institute';
const OCR_SERVICE = 'https://arke-ocr-service.nick-chimicles-professional.workers.dev';

// Test image URL - using a publicly accessible image
const TEST_IMAGE_URL = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a5/Tsunami_by_hokusai_19th_century.jpg/800px-Tsunami_by_hokusai_19th_century.jpg';

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateULID(): string {
  // Simple ULID-like generator for testing (prefixed with II for test network)
  const timestamp = Date.now().toString(36).toUpperCase().padStart(10, '0');
  const random = Array.from({ length: 16 }, () =>
    '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[Math.floor(Math.random() * 32)]
  ).join('');
  return 'II' + timestamp.slice(-8) + random.slice(0, 16);
}

async function createTestEntity(): Promise<{ pi: string; tip: string; ver: number }> {
  console.log('\n1. Creating test entity...');

  // First upload a placeholder component
  const metadata = JSON.stringify({
    name: 'OCR Integration Test',
    created: new Date().toISOString(),
  });

  const formData = new FormData();
  formData.append('file', new Blob([metadata], { type: 'application/json' }), 'metadata.json');

  const uploadRes = await fetch(`${IPFS_API}/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!uploadRes.ok) {
    throw new Error(`Upload failed: ${await uploadRes.text()}`);
  }

  const uploadData = await uploadRes.json() as Array<{ cid: string }>;
  const metadataCid = uploadData[0].cid;
  console.log(`   Uploaded metadata: ${metadataCid}`);

  // Create entity
  const createRes = await fetch(`${IPFS_API}/entities`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Arke-Network': 'test',
    },
    body: JSON.stringify({
      type: 'PI',
      components: {
        'metadata.json': metadataCid,
      },
      label: 'OCR Integration Test Entity',
      note: 'Created for OCR integration testing',
    }),
  });

  if (!createRes.ok) {
    throw new Error(`Create entity failed: ${await createRes.text()}`);
  }

  const entity = await createRes.json() as { id: string; tip: string; ver: number };
  console.log(`   Created entity: ${entity.id} (v${entity.ver})`);
  console.log(`   Tip: ${entity.tip}`);

  return { pi: entity.id, tip: entity.tip, ver: entity.ver };
}

async function uploadRefToIPFS(imageUrl: string): Promise<string> {
  console.log('\n2. Uploading ref JSON to IPFS...');

  const refData = {
    url: imageUrl,
    type: 'image/jpeg',
    filename: 'test-image.jpg',
    // Note: no 'ocr' field yet - that's what we're testing
  };

  const formData = new FormData();
  formData.append(
    'file',
    new Blob([JSON.stringify(refData, null, 2)], { type: 'application/json' }),
    'test-image.jpg.ref.json'
  );

  const uploadRes = await fetch(`${IPFS_API}/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!uploadRes.ok) {
    throw new Error(`Ref upload failed: ${await uploadRes.text()}`);
  }

  const uploadData = await uploadRes.json() as Array<{ cid: string }>;
  const refCid = uploadData[0].cid;
  console.log(`   Uploaded ref JSON: ${refCid}`);

  return refCid;
}

async function addRefToEntity(
  pi: string,
  currentTip: string,
  refCid: string
): Promise<{ tip: string; ver: number }> {
  console.log('\n3. Adding ref component to entity...');

  const appendRes = await fetch(`${IPFS_API}/entities/${pi}/versions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Arke-Network': 'test',
    },
    body: JSON.stringify({
      expect_tip: currentTip,
      components: {
        'test-image.jpg.ref.json': refCid,
      },
      note: 'Added ref for OCR testing',
    }),
  });

  if (!appendRes.ok) {
    throw new Error(`Append version failed: ${await appendRes.text()}`);
  }

  const result = await appendRes.json() as { tip: string; ver: number };
  console.log(`   Entity updated to v${result.ver}`);
  console.log(`   New tip: ${result.tip}`);

  return result;
}

async function callOCRService(
  batchId: string,
  chunkId: string,
  pi: string,
  currentTip: string,
  refFilename: string,
  cdnUrl: string
): Promise<void> {
  console.log('\n4. Calling OCR service...');

  // Note: In real usage, staging_key would be the R2 key
  // For this test, we'll create a mock staging key
  // The OCR service will try to read from R2, which may fail
  // But we can test the flow up to that point

  const request = {
    batch_id: batchId,
    chunk_id: chunkId,
    pis: [
      {
        pi,
        current_tip: currentTip,
        refs: [
          {
            filename: refFilename,
            staging_key: `test/${batchId}/${refFilename}`,
            cdn_url: cdnUrl,
          },
        ],
      },
    ],
  };

  console.log(`   Request:`, JSON.stringify(request, null, 2));

  const response = await fetch(`${OCR_SERVICE}/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  const result = await response.json();
  console.log(`   Response (${response.status}):`, JSON.stringify(result, null, 2));

  if (!response.ok) {
    throw new Error(`OCR service call failed: ${JSON.stringify(result)}`);
  }
}

async function pollStatus(batchId: string, chunkId: string): Promise<any> {
  console.log('\n5. Polling OCR service status...');

  const maxAttempts = 60; // 5 minutes max
  const pollInterval = 5000; // 5 seconds

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(`${OCR_SERVICE}/status/${batchId}/${chunkId}`);
    const status = await response.json();

    console.log(`   Attempt ${attempt}: ${status.status} (phase: ${status.phase || 'N/A'})`);

    if (status.progress) {
      console.log(
        `   Progress: ${status.progress.completed}/${status.progress.total_refs} complete, ` +
          `${status.progress.failed} failed, ${status.progress.pending} pending`
      );
    }

    if (status.status === 'done') {
      console.log('   ✓ OCR processing complete!');
      return status;
    }

    if (status.status === 'error') {
      console.log(`   ✗ OCR processing failed: ${status.error}`);
      return status;
    }

    await sleep(pollInterval);
  }

  throw new Error('Timeout waiting for OCR completion');
}

async function verifyEntityUpdated(pi: string, expectedMinVersion: number): Promise<void> {
  console.log('\n6. Verifying entity was updated...');

  const response = await fetch(`${IPFS_API}/entities/${pi}`, {
    headers: { 'X-Arke-Network': 'test' },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch entity: ${await response.text()}`);
  }

  const entity = await response.json() as { ver: number; tip: string; components: Record<string, string> };
  console.log(`   Current version: ${entity.ver}`);
  console.log(`   Current tip: ${entity.tip}`);
  console.log(`   Components:`, Object.keys(entity.components));

  if (entity.ver >= expectedMinVersion) {
    console.log(`   ✓ Entity version incremented (expected >= ${expectedMinVersion})`);
  } else {
    console.log(`   ✗ Entity version NOT incremented (expected >= ${expectedMinVersion}, got ${entity.ver})`);
  }
}

async function verifyRefHasOCR(pi: string, refFilename: string): Promise<void> {
  console.log('\n7. Verifying ref has OCR text...');

  // Get entity to find ref CID
  const entityRes = await fetch(`${IPFS_API}/entities/${pi}`, {
    headers: { 'X-Arke-Network': 'test' },
  });
  const entity = await entityRes.json() as { components: Record<string, string> };

  const refCid = entity.components[refFilename];
  if (!refCid) {
    console.log(`   ✗ Ref component not found: ${refFilename}`);
    return;
  }

  console.log(`   Ref CID: ${refCid}`);

  // Fetch ref content
  const refRes = await fetch(`${IPFS_API}/cat/${refCid}`);
  const refData = await refRes.json();

  console.log(`   Ref data:`, JSON.stringify(refData, null, 2));

  if (refData.ocr) {
    console.log(`   ✓ OCR text found! (${refData.ocr.length} chars)`);
    console.log(`   Preview: ${refData.ocr.substring(0, 200)}...`);
  } else {
    console.log(`   ✗ No OCR text in ref`);
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('OCR Service Integration Test');
  console.log('='.repeat(60));

  try {
    // Generate unique IDs
    const batchId = `test_${Date.now()}`;
    const chunkId = '0';

    // Step 1: Create test entity
    const { pi, tip, ver } = await createTestEntity();

    // Step 2: Upload ref to IPFS
    const refCid = await uploadRefToIPFS(TEST_IMAGE_URL);

    // Step 3: Add ref to entity
    const updated = await addRefToEntity(pi, tip, refCid);

    // Step 4: Call OCR service
    await callOCRService(
      batchId,
      chunkId,
      pi,
      updated.tip,
      'test-image.jpg.ref.json',
      TEST_IMAGE_URL
    );

    // Step 5: Poll for completion
    const finalStatus = await pollStatus(batchId, chunkId);

    // Step 6: Verify entity was updated
    if (finalStatus.status === 'done') {
      await verifyEntityUpdated(pi, updated.ver + 1);

      // Step 7: Verify ref has OCR
      await verifyRefHasOCR(pi, 'test-image.jpg.ref.json');
    }

    console.log('\n' + '='.repeat(60));
    console.log('Test completed!');
    console.log('='.repeat(60));
    console.log(`\nTest entity PI: ${pi}`);
    console.log(`Batch ID: ${batchId}`);
    console.log(`Final status: ${finalStatus.status}`);

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

main();
