#!/usr/bin/env bash
# Block access to sensitive files: .env, secrets, SSH keys, credentials
# Called as PreToolUse hook for Read and Edit events
#
# Exit code 2 = block the tool call with a message
# The hook receives tool input as JSON on stdin.

set -euo pipefail

INPUT=$(cat)

# Extract the file path from tool input (Read uses file_path, Edit uses file_path)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.filePath // empty' 2>/dev/null || true)

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Patterns to block (case-insensitive matching on the file path)
BLOCKED_PATTERNS=(
  "\.env$"
  "\.env\."
  "/\.env$"
  "secret"
  "credential"
  "/\.ssh/"
  "id_rsa"
  "id_ed25519"
  "\.pem$"
  "\.key$"
  "\.p12$"
  "\.keystore$"
  "\.jks$"
  "service.account\.json"
  "google-services\.json"
  "GoogleService-Info\.plist"
)

for PATTERN in "${BLOCKED_PATTERNS[@]}"; do
  if echo "$FILE_PATH" | grep -iqE "$PATTERN"; then
    echo "BLOCKED: Access to sensitive file detected. Pattern: '$PATTERN', File: $FILE_PATH"
    exit 2
  fi
done

exit 0
