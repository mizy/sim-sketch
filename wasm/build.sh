#!/bin/sh
# Build the geometry kernel for wasm32-unknown-unknown and copy the artifact
# next to the TS facade.
#
# wasm-pack is intentionally not required: this crate exposes a raw C ABI and
# has no wasm-bindgen glue. On the current machine `wasm-pack` is an x86_64
# binary without Rosetta, so it cannot execute; cargo is the supported path.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"

if command -v wasm-pack >/dev/null 2>&1; then
  if ! wasm-pack --version >/dev/null 2>&1; then
    echo "wasm-pack is present but not executable here (x86_64 binary, no Rosetta); using cargo build." >&2
  fi
fi

cargo build --target wasm32-unknown-unknown --release
mkdir -p pkg
cp target/wasm32-unknown-unknown/release/sim_sketch_geometry.wasm pkg/sim_sketch_geometry.wasm
echo "Wrote wasm/pkg/sim_sketch_geometry.wasm ($(wc -c < pkg/sim_sketch_geometry.wasm) bytes)"
