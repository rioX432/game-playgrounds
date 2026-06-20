#!/usr/bin/env bash
# Block dangerous commands: prevents destructive operations
# Called as PreToolUse hook for Bash events
#
# Exit code 2 = block the tool call with a message
# The hook receives tool input as JSON on stdin.

set -euo pipefail

INPUT=$(cat)

# Extract the command from tool input
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Patterns to block (case-insensitive matching)
BLOCKED_PATTERNS=(
  "rm -rf /"
  "rm -rf ~"
  "rm -rf \."
  "git push.*--force.*main"
  "git push.*--force.*master"
  "git push.*-f.*main"
  "git push.*-f.*master"
  "git reset --hard"
  "git clean -fd"
  "git checkout \."
  "git restore \."
  "drop table"
  "drop database"
  "truncate table"
  ":(){ :|:& };:"
  "mkfs\."
  "dd if="
  "> /dev/sd"
)

for PATTERN in "${BLOCKED_PATTERNS[@]}"; do
  if echo "$COMMAND" | grep -iqE "$PATTERN"; then
    echo "BLOCKED: Dangerous command detected matching pattern '$PATTERN'. Command: $COMMAND"
    exit 2
  fi
done

exit 0
