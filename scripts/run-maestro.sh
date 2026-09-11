#!/usr/bin/env bash
set -euo pipefail

exec node scripts/run-maestro-report.mjs "${1:-smoke}"
