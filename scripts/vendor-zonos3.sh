#!/usr/bin/env bash
# Builds the ZONOS3 in-browser engine (servers/web of a ZONOS3-Mini checkout) into vendor/zonos3/ and copies the model
# files it loads into models/ (about 1.6 GB).
# Usage: scripts/vendor-zonos3.sh [path/to/ZONOS3]   (default: ../ZONOS3 next to this extension)
# Needs `pnpm install` at the ZONOS3 root. The models come from that checkout's own export (servers/web/public/models,
# `pnpm --dir servers/web export`) when it has them, otherwise from the web/ folder of hf://Zyphra/ZONOS3-Mini (needs
# the `hf` CLI); MODELS_FROM=hf forces the download.
# Run it again after ZONOS3 changes, then reload the extension.
set -euo pipefail

EXT="$(cd "$(dirname "$0")/.." && pwd)"
ZONOS="$(cd "${1:-$EXT/../ZONOS3}" && pwd)"
WEB="$ZONOS/servers/web"
MODELS="$WEB/public/models"
# Every directory the engine fetches at startup. It skips the optional ones (companions, laci, edit, aligner) only on an
# HTTP 404, and a missing file inside an extension is a network error instead, so they are copied too.
DIRS=(backbone zac voices companions laci edit aligner)

[ -f "$WEB/vite.config.ts" ] || { echo "$ZONOS has no servers/web: pass the path of a ZONOS3-Mini checkout" >&2; exit 1; }

src="$MODELS"
for d in "${DIRS[@]}"; do [ -d "$MODELS/$d" ] || src=; done
if [ "${MODELS_FROM:-}" = hf ] || [ -z "$src" ]; then
  command -v hf >/dev/null || { echo "need the Hugging Face CLI (hf) to download the models: pip install -U huggingface_hub" >&2; exit 1; }
  includes=()
  for d in "${DIRS[@]}"; do includes+=(--include "web/$d/*"); done
  echo "downloading the web models from hf://Zyphra/ZONOS3-Mini…"
  src="$(hf download Zyphra/ZONOS3-Mini "${includes[@]}" -q)/web"
fi
echo "models from $src"

# Only the engine bundle is needed: `vite build` skips the package's type checks of ZONOS3's own sources and tests.
pnpm --dir "$WEB" exec vite build
mkdir -p "$EXT/vendor/zonos3" "$EXT/models"
rsync -a --delete "$WEB/dist/" "$EXT/vendor/zonos3/"
filters=()
for d in "${DIRS[@]}"; do filters+=(--include="/$d/***"); done
# -L: the Hugging Face cache links its files to blobs.
rsync -aL --delete-excluded "${filters[@]}" --exclude='*' "$src/" "$EXT/models/"
du -sh "$EXT/vendor/zonos3" "$EXT/models"
