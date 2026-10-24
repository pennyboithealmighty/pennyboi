#!/usr/bin/env bash
# Cloudflare Pages build command for the static site (output dir: site).
# Stamps site/health.json with the deploy commit and rewrites the ?v=DEV
# cache-busting query to that commit, so each deploy serves fresh assets.
set -euo pipefail

COMMIT="${CF_PAGES_COMMIT_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo dev)}"
SHORT="${COMMIT:0:12}"

printf '{"service":"pennyboi-site","commit":"%s","builtAt":"%s"}\n' \
  "$SHORT" "$(date -u +%FT%TZ)" > site/health.json

for f in site/index.html site/scripture.html; do
  sed -i.bak "s/?v=DEV/?v=${SHORT}/g" "$f" && rm -f "$f.bak"
done

echo "built site: commit=${SHORT}, cache-bust v=${SHORT}"
