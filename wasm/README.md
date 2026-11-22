# SimSketch geometry kernel (Rust/Wasm)

Stateless 2D geometry kernel. No DOM, no UI state, no persistence — only
polygon booleans, curve flattening, triangulation, intersections, and curve
editing. The TS facade lives in `kernel.ts` and is the only consumer.

## What lives here

| Module | Responsibility |
| --- | --- |
| `arrangement.rs` / `boolean.rs` / `rings.rs` | Planar arrangement and polygon booleans |
| `curve.rs` | Circle/arc/Bézier flattening and polygon-with-holes triangulation |
| `edit.rs` | Segment intersections, trim, extend, offset, fillet |
| `lib.rs` | Raw ABI, request dispatch, f64 codecs |

## Build

```bash
sh wasm/build.sh
# equivalently:
cd wasm && cargo build --target wasm32-unknown-unknown --release
```

Artifact: `wasm/pkg/sim_sketch_geometry.wasm`.

### Why not wasm-pack here

The target is `wasm32-unknown-unknown`, but this checkout cannot run
`wasm-pack`: the installed `~/.cargo/bin/wasm-pack` is an `x86_64` Mach-O
binary, Rosetta is not installed (`bad CPU type in executable`), and the
machine has no network access to install an arm64 build. The crate also uses a
raw `extern "C"` ABI rather than `wasm-bindgen`, so no JS glue generation is
needed. `cargo build --target wasm32-unknown-unknown --release` produces the
exact artifact `wasm-pack` would compile, and `wasm/build.sh` documents the
fallback.

When an arm64 `wasm-pack` is available, the build step can be swapped in; the
TS facade only depends on the exported ABI below, not on how the artifact was
produced.

## ABI (version 2)

Exports:

| Export | Meaning |
| --- | --- |
| `memory` | linear memory |
| `kernel_abi_version() -> u32` | currently `2` |
| `alloc_f64(len) -> ptr` | allocate f64 slots |
| `dealloc_f64(ptr, len)` | release a buffer |
| `boolean_rings(op, ptr, len) -> u64` | polygon boolean, return packed `(len << 32) \| ptr` |
| `geometry_op(op, ptr, len) -> u64` | curve/editing operations, same packed return |

All buffers are flat `f64`. A packed return where `ptr == 0 || len == 0` means
“empty result”. The caller owns the returned buffer and releases it with
`dealloc_f64`.

### Boolean encoding (`boolean_rings`)

`op`: `0 = union`, `1 = intersect`, `2 = subtract`.

Input and output:

```text
shapeCount
  polygonCount
    ringCount
      pointCount x y x y ...
```

Rings are implicitly closed. Output rings are grouped as
`Polygon = [outer, ...holes]`, outer CCW and holes CW, so the default non-zero
SVG fill rule renders holes correctly. N-ary operations fold left, matching the
legacy `polygon-clipping` call order (the vendored implementation has since
been removed; its metrics are frozen in `tests/boolean-golden.test.ts`).

### `geometry_op` codes

Point lists are encoded as `count x y x y ...`; segment lists as
`count x0 y0 x1 y1 x2 y2 x3 y3 ...`.

| Code | Operation | Input | Output |
| --- | --- | --- | --- |
| 0 | tessellate | Boolean shape encoding with one shape | `vertexCount xy... indexCount i j k...` |
| 1 | circle | `cx cy radius segments` | point list |
| 2 | arc through | `ax ay bx by cx cy segments` | point list |
| 3 | cubic Bézier | `x0 y0 c1x c1y c2x c2y x1 y1 tolerance` | point list |
| 4 | intersections | segment list A + segment list B | `count x y aSeg bSeg t u ...` |
| 5 | trim | point list + boundary list + `keepStart` | `changed count xy...` |
| 6 | extend | point list + boundary list + `extendStart maxDistance` | `changed count xy...` |
| 7 | offset | point list + `distance closed round miterLimit` | point list |
| 8 | fillet | point list + `radius corner segments closed` | point list |

`corner = -1` fillets every corner; otherwise it is a zero-based vertex index.
`segments = 0` uses an adaptive 10° arc step. `maxDistance <= 0` means “only
extend when a boundary hit exists”.

## Algorithm notes

- **Triangulation**: vertical scanline slabs at every vertex x, pairing edge
  intersections by even-odd parity. Multiple holes need no bridging, so they
  cannot produce overlapping ears or fill the wrong hole. Triangles are CCW and
  share the position buffer; positions/indices are deterministic.
- **Flattening**: circle and arc use the segment count supplied by TS so output
  stays compatible with the legacy `circlePoints()` / `arcPoints()` samplers.
  Cubic Bézier uses adaptive de Casteljau subdivision capped at depth 24.
- **Intersections**: pairwise segment tests include endpoint touches and
  collinear overlaps (both overlap endpoints are reported). Zero-length
  segments are ignored.
- **Trim**: keeps the `start` or `end` side of the earliest/latest crossing
  along the first polyline. No crossing means `changed = false` and the input is
  returned unchanged.
- **Extend**: extends the first/last segment along its own direction to the
  nearest boundary hit, or by `maxDistance` when no hit exists.
- **Offset**: miter joins with a configurable limit (fallback bevel) or round
  joins. Positive distance is the left-hand normal for open paths; closed rings
  are normalized to CCW and positive distance grows outward.
- **Fillet**: tangent arc at one or all corners, radius clamped to fit the
  adjacent edges. Collinear corners and zero/non-finite radii are no-ops.
- **Degenerate safety**: non-finite inputs, duplicate points, collinear rings,
  zero-length segments, and empty results are filtered rather than propagated.

## Tests

```bash
cd wasm && cargo test --release
pnpm test        # includes tests/geometry-kernel.test.ts and boolean golden tests
```

`tests/geometry-kernel.test.ts` covers every operation plus degenerate inputs,
boundary touches, collinear overlap, large coordinates, near-parallel rays, and
invalid radii. Rust unit tests cover boolean, hole triangulation, circle/arc
flattening, trim, offset, and fillet invariants.
