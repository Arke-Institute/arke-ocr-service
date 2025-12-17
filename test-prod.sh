#!/bin/bash
#
# Production integration test for OCR Service
#
# This test:
# 1. Uploads a ref JSON to R2 staging (production)
# 2. Creates a test entity in IPFS
# 3. Calls the deployed OCR service
# 4. Polls for completion
# 5. Verifies entity was updated with OCR text
#
# Usage: ./test-prod.sh

set -e

# Config
OCR_SERVICE="https://arke-ocr-service.nick-chimicles-professional.workers.dev"
IPFS_API="https://api.arke.institute"
R2_BUCKET="arke-staging"
BATCH_ID="ocr_test_$(date +%s)"
CHUNK_ID="0"

# Test image - Declaration of Independence (has readable text)
TEST_IMAGE_URL="https://upload.wikimedia.org/wikipedia/commons/thumb/8/8e/Declaration_independence.jpg/800px-Declaration_independence.jpg"

echo "=============================================="
echo "OCR Service Production Integration Test"
echo "=============================================="
echo "Service: $OCR_SERVICE"
echo "Batch ID: $BATCH_ID"
echo ""

# Check service health
echo "1. Checking OCR service health..."
HEALTH=$(curl -s "$OCR_SERVICE/health")
echo "   $HEALTH"
if ! echo "$HEALTH" | jq -e '.status == "ok"' > /dev/null 2>&1; then
  echo "   ERROR: Service not healthy"
  exit 1
fi
echo "   ✓ Service is healthy"

# Create test entity
echo ""
echo "2. Creating test entity..."
METADATA='{"name":"OCR Production Test","ts":"'"$(date -Iseconds)"'","test":true}'
METADATA_CID=$(curl -s -X POST "$IPFS_API/upload" \
  -F "file=@-;filename=metadata.json" <<< "$METADATA" | jq -r '.[0].cid')
echo "   Metadata CID: $METADATA_CID"

ENTITY_RESPONSE=$(curl -s -X POST "$IPFS_API/entities" \
  -H "Content-Type: application/json" \
  -H "X-Arke-Network: test" \
  -d '{
    "type": "PI",
    "components": {"metadata.json": "'"$METADATA_CID"'"},
    "label": "OCR Production Test Entity",
    "note": "Automated OCR integration test"
  }')

PI=$(echo "$ENTITY_RESPONSE" | jq -r '.id')
TIP=$(echo "$ENTITY_RESPONSE" | jq -r '.tip')
VER=$(echo "$ENTITY_RESPONSE" | jq -r '.ver')

if [ "$PI" = "null" ] || [ -z "$PI" ]; then
  echo "   ERROR: Failed to create entity"
  echo "   Response: $ENTITY_RESPONSE"
  exit 1
fi

echo "   Entity PI: $PI"
echo "   Tip: $TIP"
echo "   Version: $VER"

# Create ref JSON
echo ""
echo "3. Creating and uploading ref to R2 staging..."
REF_FILENAME="test-ocr-image.jpg.ref.json"
STAGING_KEY="test/$BATCH_ID/$REF_FILENAME"

REF_JSON='{
  "url": "'"$TEST_IMAGE_URL"'",
  "type": "image/jpeg",
  "filename": "declaration-of-independence.jpg"
}'

# Save ref JSON to temp file
echo "$REF_JSON" > /tmp/ocr-test-ref.json
echo "   Ref JSON: $REF_JSON"
echo "   Staging key: $STAGING_KEY"

# Upload to R2 using wrangler
echo "   Uploading to R2..."
cd "$(dirname "$0")"
npx wrangler r2 object put "$R2_BUCKET/$STAGING_KEY" --file=/tmp/ocr-test-ref.json --remote 2>&1 | head -5
echo "   ✓ Uploaded to R2"

# Also upload ref to IPFS and add to entity
echo ""
echo "4. Adding ref component to entity..."
REF_CID=$(curl -s -X POST "$IPFS_API/upload" \
  -F "file=@-;filename=$REF_FILENAME" <<< "$REF_JSON" | jq -r '.[0].cid')
echo "   Initial ref CID: $REF_CID"

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

if [ "$NEW_TIP" = "null" ] || [ -z "$NEW_TIP" ]; then
  echo "   ERROR: Failed to append version"
  echo "   Response: $APPEND_RESPONSE"
  exit 1
fi

echo "   Updated to v$NEW_VER"
echo "   New tip: $NEW_TIP"

# Call OCR service
echo ""
echo "5. Calling OCR service..."
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

echo "   Request payload:"
echo "$PROCESS_REQUEST" | jq .

PROCESS_RESPONSE=$(curl -s -X POST "$OCR_SERVICE/process" \
  -H "Content-Type: application/json" \
  -d "$PROCESS_REQUEST")

echo "   Response:"
echo "$PROCESS_RESPONSE" | jq .

STATUS=$(echo "$PROCESS_RESPONSE" | jq -r '.status')
if [ "$STATUS" != "accepted" ]; then
  echo "   ERROR: Request not accepted"
  exit 1
fi
echo "   ✓ Request accepted"

# Poll status
echo ""
echo "6. Polling for completion..."
MAX_ATTEMPTS=60
POLL_INTERVAL=5
FINAL_STATUS="unknown"

for i in $(seq 1 $MAX_ATTEMPTS); do
  sleep $POLL_INTERVAL

  STATUS_RESPONSE=$(curl -s "$OCR_SERVICE/status/$BATCH_ID/$CHUNK_ID")
  FINAL_STATUS=$(echo "$STATUS_RESPONSE" | jq -r '.status')
  PHASE=$(echo "$STATUS_RESPONSE" | jq -r '.phase // "N/A"')
  COMPLETED=$(echo "$STATUS_RESPONSE" | jq -r '.progress.completed // 0')
  TOTAL=$(echo "$STATUS_RESPONSE" | jq -r '.progress.total_refs // 0')
  FAILED=$(echo "$STATUS_RESPONSE" | jq -r '.progress.failed // 0')

  echo "   [$i/$MAX_ATTEMPTS] Status: $FINAL_STATUS | Phase: $PHASE | Progress: $COMPLETED/$TOTAL (failed: $FAILED)"

  if [ "$FINAL_STATUS" = "done" ]; then
    echo "   ✓ Processing complete!"
    break
  fi

  if [ "$FINAL_STATUS" = "error" ]; then
    ERROR=$(echo "$STATUS_RESPONSE" | jq -r '.error // "Unknown"')
    echo "   ✗ Processing failed: $ERROR"
    echo "   Full response: $STATUS_RESPONSE"
    break
  fi
done

# Verify results
echo ""
echo "7. Verifying results..."

# Get final entity state
FINAL_ENTITY=$(curl -s "$IPFS_API/entities/$PI" -H "X-Arke-Network: test")
FINAL_VER=$(echo "$FINAL_ENTITY" | jq -r '.ver')
FINAL_TIP=$(echo "$FINAL_ENTITY" | jq -r '.manifest_cid // .tip')

echo "   Final entity version: $FINAL_VER (was: $NEW_VER)"
echo "   Final tip: $FINAL_TIP"

if [ "$FINAL_VER" -gt "$NEW_VER" ]; then
  echo "   ✓ Entity version incremented!"

  # Check ref content
  FINAL_REF_CID=$(echo "$FINAL_ENTITY" | jq -r '.components["'"$REF_FILENAME"'"]')
  echo "   Final ref CID: $FINAL_REF_CID"

  if [ "$FINAL_REF_CID" != "null" ] && [ -n "$FINAL_REF_CID" ]; then
    REF_CONTENT=$(curl -s "$IPFS_API/cat/$FINAL_REF_CID")
    OCR_TEXT=$(echo "$REF_CONTENT" | jq -r '.ocr // empty')

    if [ -n "$OCR_TEXT" ]; then
      OCR_LENGTH=${#OCR_TEXT}
      echo "   ✓ OCR text found! ($OCR_LENGTH characters)"
      echo ""
      echo "   === OCR Text Preview ==="
      echo "${OCR_TEXT:0:500}"
      echo "   ========================"
    else
      echo "   ⚠ No OCR text found in ref"
      echo "   Ref content: $(echo "$REF_CONTENT" | jq .)"
    fi
  fi
else
  echo "   ⚠ Entity version not incremented"
fi

# Cleanup - delete test ref from R2
echo ""
echo "8. Cleaning up R2 staging..."
npx wrangler r2 object delete "$R2_BUCKET/$STAGING_KEY" --remote 2>&1 | head -2 || true
echo "   ✓ Cleanup complete"

echo ""
echo "=============================================="
echo "Test Summary"
echo "=============================================="
echo "Entity PI: $PI"
echo "Batch ID: $BATCH_ID"
echo "Final Status: $FINAL_STATUS"
echo "Entity Version: $NEW_VER -> $FINAL_VER"
echo ""

if [ "$FINAL_STATUS" = "done" ] && [ "$FINAL_VER" -gt "$NEW_VER" ]; then
  echo "✓ TEST PASSED"
  exit 0
else
  echo "✗ TEST FAILED"
  exit 1
fi
