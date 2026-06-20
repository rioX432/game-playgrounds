#!/usr/bin/env bash
# Log tool failure patterns for harness improvement
# Called as PostToolUseFailure hook
#
# Records tool failure details to logs/failures/ for later analysis.
# Human reviews these logs and promotes patterns to rules/*.md

set -euo pipefail

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null || echo "unknown")
ERROR=$(echo "$INPUT" | jq -r '.error // .reason // "unknown"' 2>/dev/null || echo "unknown")
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}' 2>/dev/null || echo "{}")
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Create logs directory if needed
LOG_DIR="logs/failures"
mkdir -p "$LOG_DIR"

# Write failure log
LOG_FILE="$LOG_DIR/$(date +%Y-%m-%d).jsonl"
echo "{\"timestamp\":\"$TIMESTAMP\",\"tool\":\"$TOOL_NAME\",\"error\":\"$ERROR\",\"input\":$TOOL_INPUT}" >> "$LOG_FILE"

exit 0
