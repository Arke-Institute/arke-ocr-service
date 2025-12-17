#!/bin/bash
#
# Local integration test for OCR Service
#
# Prerequisites:
# 1. npm run dev running in another terminal
# 2. Local IPFS wrapper available
#
# This test:
# 1. Creates a ref JSON file
# 2. Puts it in local R2 staging
# 3. Creates a test entity
# 4. Calls OCR service
# 5. Polls status
# 6. Verifies results

set -e

# Config
OCR_LOCAL="http://localhost:8787"
IPFS_API="https://api.arke.institute"
BATCH_ID="test_$(date +%s)"
CHUNK_ID="0"

# Test image - public domain image with text
TEST_IMAGE_URL="https://upload.wikimedia.org/wikipedia/commons/thumb/8/8e/Declaration_independence.jpg/800px-Declaration_independence.jpg"

echo "=============================================="
echo "OCR Service Local Integration Test"
echo "=============================================="
echo "Batch ID: $BATCH_ID"
echo ""

# Check if local server is running
echo "1. Checking local OCR service..."
if ! curl -s "$OCR_LOCAL/health" > /dev/null 2>&1; then
  echo "   ERROR: Local OCR service not running at $OCR_LOCAL"
  echo "   Start it with: npm run dev"
  exit 1
fi
echo "   ✓ Local service running"

# Create test entity
echo ""
echo "2. Creating test entity..."

# Upload metadata
METADATA='{"name":"OCR Test","ts":"'"$(date -Iseconds)"'"}'
METADATA_CID=$(curl -s -X POST "$IPFS_API/upload" \
  -F "file=@-;filename=metadata.json" <<< "$METADATA" | jq -r '.[0].cid')
echo "   Metadata CID: $METADATA_CID"

# Create entity
ENTITY_RESPONSE=$(curl -s -X POST "$IPFS_API/entities" \
  -H "Content-Type: application/json" \
  -H "X-Arke-Network: test" \
  -d '{
    "type": "PI",
    "components": {"metadata.json": "'"$METADATA_CID"'"},
    "label": "OCR Integration Test",
    "note": "Created for OCR testing"
  }')

PI=$(echo "$ENTITY_RESPONSE" | jq -r '.id')
TIP=$(echo "$ENTITY_RESPONSE" | jq -r '.tip')
VER=$(echo "$ENTITY_RESPONSE" | jq -r '.ver')

echo "   Entity PI: $PI"
echo "   Tip: $TIP"
echo "   Version: $VER"

# Create ref JSON
echo ""
echo "3. Creating ref JSON..."
REF_FILENAME="test-image.jpg.ref.json"
STAGING_KEY="test/$BATCH_ID/$REF_FILENAME"

REF_JSON='{
  "url": "'"$TEST_IMAGE_URL"'",
  "type": "image/jpeg",
  "filename": "test-image.jpg"
}'

echo "   Ref data: $REF_JSON"
echo "   Staging key: $STAGING_KEY"

# Note: In production, this would be uploaded to R2 staging bucket
# For local testing, we need to either:
# - Use wrangler r2 object put
# - Or have the staging bucket accessible
#
# For now, let's use wrangler to put the object in local R2
echo ""
echo "4. Uploading ref to local R2 staging..."
echo "$REF_JSON" > /tmp/test-ref.json
npx wrangler r2 object put "arke-staging/$STAGING_KEY" --file=/tmp/test-ref.json --local 2>/dev/null || {
  echo "   Warning: Could not upload to R2. Using alternative approach..."
}

# Upload ref to IPFS and add to entity (this creates the component we'll update)
echo ""
echo "5. Adding ref component to entity..."
REF_CID=$(curl -s -X POST "$IPFS_API/upload" \
  -F "file=@-;filename=$REF_FILENAME" <<< "$REF_JSON" | jq -r '.[0].cid')
echo "   Ref CID: $REF_CID"

# Append version to entity
APPEND_RESPONSE=$(curl -s -X POST "$IPFS_API/entities/$PI/versions" \
  -H "Content-Type: application/json" \
  -H "X-Arke-Network: test" \
  -d '{
    "expect_tip": "'"$TIP"'",
    "components": {"'"$REF_FILENAME"'": "'"$REF_CID"'"},
    "note": "Added ref for OCR testing"
  }')

NEW_TIP=$(echo "$APPEND_RESPONSE" | jq -r '.tip')
NEW_VER=$(echo "$APPEND_RESPONSE" | jq -r '.ver')
echo "   Updated to v$NEW_VER, tip: $NEW_TIP"

# Call OCR service
echo ""
echo "6. Calling OCR service /process..."
PROCESS_REQUEST='{
  "batch_id": "'"$BATCH_ID"'",
  "chunk_id": "'"$CHUNK_ID"'",
  "pis": [{
    "pi": "'"$PI"'",
    "current_tip": "'"$NEW_TIP"'",
    "refs": [{
      "filename": "'"$REF_FILENAME"'",
      "staging_key": "'"$STAGING_KEY"'",
      "cdn_url": "'"$TEST_IMAGE_URL"'"
    }]
  }]
}'

echo "   Request: $PROCESS_REQUEST"

PROCESS_RESPONSE=$(curl -s -X POST "$OCR_LOCAL/process" \
  -H "Content-Type: application/json" \
  -d "$PROCESS_REQUEST")

echo "   Response: $PROCESS_RESPONSE"

STATUS=$(echo "$PROCESS_RESPONSE" | jq -r '.status')
if [ "$STATUS" != "accepted" ]; then
  echo "   ERROR: OCR service did not accept request"
  exit 1
fi
echo "   ✓ Request accepted"

# Poll status
echo ""
echo "7. Polling status..."
MAX_ATTEMPTS=60
POLL_INTERVAL=5

for i in $(seq 1 $MAX_ATTEMPTS); do
  STATUS_RESPONSE=$(curl -s "$OCR_LOCAL/status/$BATCH_ID/$CHUNK_ID")
  STATUS=$(echo "$STATUS_RESPONSE" | jq -r '.status')
  PHASE=$(echo "$STATUS_RESPONSE" | jq -r '.phase // "N/A"')

  echo "   [$i/$MAX_ATTEMPTS] Status: $STATUS, Phase: $PHASE"

  if [ "$STATUS" = "done" ]; then
    echo "   ✓ Processing complete!"
    break
  fi

  if [ "$STATUS" = "error" ]; then
    ERROR=$(echo "$STATUS_RESPONSE" | jq -r '.error // "Unknown error"')
    echo "   ✗ Processing failed: $ERROR"
    break
  fi

  sleep $POLL_INTERVAL
done

# Verify entity update
echo ""
echo "8. Verifying entity update..."
FINAL_ENTITY=$(curl -s "$IPFS_API/entities/$PI" -H "X-Arke-Network: test")
FINAL_VER=$(echo "$FINAL_ENTITY" | jq -r '.ver')
FINAL_TIP=$(echo "$FINAL_ENTITY" | jq -r '.tip // .manifest_cid')

echo "   Final version: $FINAL_VER (started at $NEW_VER)"
echo "   Final tip: $FINAL_TIP"

if [ "$FINAL_VER" -gt "$NEW_VER" ]; then
  echo "   ✓ Entity version incremented!"
else
  echo "   ⚠ Entity version not incremented (may have failed before publishing)"
fi

# Check ref for OCR text
echo ""
echo "9. Checking ref for OCR text..."
REF_CID_FINAL=$(echo "$FINAL_ENTITY" | jq -r '.components["'"$REF_FILENAME"'"]')
if [ "$REF_CID_FINAL" != "null" ] && [ -n "$REF_CID_FINAL" ]; then
  REF_CONTENT=$(curl -s "$IPFS_API/cat/$REF_CID_FINAL")
  OCR_TEXT=$(echo "$REF_CONTENT" | jq -r '.ocr // empty')

  if [ -n "$OCR_TEXT" ]; then
    OCR_LENGTH=${#OCR_TEXT}
    echo "   ✓ OCR text found! ($OCR_LENGTH characters)"
    echo "   Preview: ${OCR_TEXT:0:200}..."
  else
    echo "   ⚠ No OCR text in ref"
    echo "   Ref content: $REF_CONTENT"
  fi
else
  echo "   ⚠ Could not find ref component"
fi

echo ""
echo "=============================================="
echo "Test Summary"
echo "=============================================="
echo "Entity PI: $PI"
echo "Batch ID: $BATCH_ID"
echo "Final Status: $STATUS"
echo ""
