#!/usr/bin/env bash
# Launcher for the contracts CLI (emergent-contract-coding substrate).
# Override with CONTRACTS_CLI if the skill lives elsewhere.
set -euo pipefail
CLI="${CONTRACTS_CLI:-$HOME/.pi/agent/git/github.com/vhallac/lopsided-skills/skills/emergent-contract-coding/scripts/contracts-cli.py}"
exec python3 "$CLI" "$@"
