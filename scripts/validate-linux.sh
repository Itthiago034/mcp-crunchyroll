#!/usr/bin/env bash
set -euo pipefail

TASK_REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$TASK_REPO_ROOT"

if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo 'Instale Node.js 22 (ou >=18) e npm e execute novamente.' >&2
  exit 2
fi
TASK_NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( TASK_NODE_MAJOR < 18 )); then
  echo 'Este projeto exige Node.js >=18; use Node.js 22 ou superior.' >&2
  exit 2
fi

TASK_OUTPUT_DIR="${CRUNCHYROLL_VALIDATION_OUTPUT_DIR:-$TASK_REPO_ROOT/validation-results/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$TASK_OUTPUT_DIR"
TASK_OUTPUT_DIR="$(cd -- "$TASK_OUTPUT_DIR" && pwd)"
echo "Relatórios desta execução: $TASK_OUTPUT_DIR"

npm ci --cache "$TASK_REPO_ROOT/.npm-cache" --no-audit --no-fund
node --import tsx --input-type=module -e '
  import { resolveBrowserExecutable } from "./src/transport/browser-profile.ts";
  console.log("Navegador: " + resolveBrowserExecutable(process.env));
'
npm run typecheck
npm run build

CRUNCHYROLL_LOAD_REPORT_PATH="$TASK_OUTPUT_DIR/local-browser.json" npm run test:browser
CRUNCHYROLL_LIVE_PROBE_REPORT_PATH="$TASK_OUTPUT_DIR/live-browser.json" \
  node --import tsx scripts/probe-live-browser.ts

# Login only through the visible managed browser; no secrets in terminal input.
CRUNCHYROLL_LIVE_REPORT_PATH="$TASK_OUTPUT_DIR/live-mcp.json" npm run validate:live -- --login
echo 'Validação concluída. Feche a janela do navegador gerenciado quando terminar.'
