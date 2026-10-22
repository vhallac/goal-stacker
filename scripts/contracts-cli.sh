#!/usr/bin/env bash
# Launcher for the contracts CLI (emergent-contract-coding substrate).
# Runs via uv ephemeral deps (tree-sitter) so TypeScript sources are
# extracted — matching the AGENTS.md directive. Override with CONTRACTS_CLI.
set -euo pipefail
CLI="${CONTRACTS_CLI:-$HOME/.pi/agent/git/github.com/vhallac/lopsided-skills/skills/emergent-contract-coding/scripts/contracts-cli.py}"
exec uv run --with tree-sitter --with tree-sitter-typescript python "$CLI" "$@"
