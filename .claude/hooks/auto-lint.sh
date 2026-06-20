#!/usr/bin/env bash
# Auto-lint: runs the project's linter on saved files
# Called as PostToolUse hook for Write/Edit events
#
# The hook receives tool input as JSON on stdin.
# Extract the file path and run the appropriate linter.

set -euo pipefail

# Read tool input from stdin
INPUT=$(cat)

# Extract file path from tool result
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.filePath // empty' 2>/dev/null || true)

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Get file extension
EXT="${FILE_PATH##*.}"

# Run appropriate linter based on file type
case "$EXT" in
  kt|kts)
    if command -v ktlint &>/dev/null; then
      ktlint --format "$FILE_PATH" 2>/dev/null || true
    fi
    ;;
  swift)
    if command -v swiftformat &>/dev/null; then
      swiftformat "$FILE_PATH" 2>/dev/null || true
    fi
    ;;
  js|jsx|ts|tsx|mjs|cjs)
    # Try project-local eslint first, then global
    if [ -f "node_modules/.bin/eslint" ]; then
      node_modules/.bin/eslint --fix "$FILE_PATH" 2>/dev/null || true
    elif command -v eslint &>/dev/null; then
      eslint --fix "$FILE_PATH" 2>/dev/null || true
    fi
    ;;
  py)
    if command -v ruff &>/dev/null; then
      ruff format "$FILE_PATH" 2>/dev/null || true
      ruff check --fix "$FILE_PATH" 2>/dev/null || true
    elif command -v black &>/dev/null; then
      black "$FILE_PATH" 2>/dev/null || true
    fi
    ;;
  json)
    if command -v jq &>/dev/null; then
      TMP=$(mktemp)
      jq . "$FILE_PATH" > "$TMP" 2>/dev/null && mv "$TMP" "$FILE_PATH" || rm -f "$TMP"
    fi
    ;;
esac
