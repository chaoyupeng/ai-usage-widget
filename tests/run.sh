#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
for test in format.js providers.js http.js; do
    gjs -m "$test"
done
