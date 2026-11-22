//! Stateless geometry kernel for SimSketch.
//!
//! The module deliberately exposes a raw `extern "C"` ABI instead of wasm-bindgen
//! glue so the artifact can be produced with `cargo build --target
//! wasm32-unknown-unknown` on any machine that has the Rust target installed.
//! See `wasm/README.md` for why this checkout cannot run `wasm-pack`.

mod arrangement;
mod boolean;
mod curve;
mod edit;
mod math;
mod rings;

use boolean::boolean;
use math::{MultiPolygon, Point};

pub const ABI_VERSION: u32 = 2;

#[no_mangle]
pub extern "C" fn kernel_abi_version() -> u32 {
  ABI_VERSION
}

/// Allocate `len` f64 slots and hand ownership to the caller.
#[no_mangle]
pub extern "C" fn alloc_f64(len: usize) -> *mut f64 {
  // Box<[f64]> has an exact length, so the JS side can release it with only
  // (ptr, len) without knowing a capacity.
  let buffer = vec![0.0f64; len].into_boxed_slice();
  Box::into_raw(buffer) as *mut f64
}

/// Reclaim a buffer created by [`alloc_f64`] or returned from [`boolean_rings`].
#[no_mangle]
pub extern "C" fn dealloc_f64(ptr: *mut f64, len: usize) {
  if ptr.is_null() || len == 0 {
    return;
  }
  unsafe {
    let slice = std::ptr::slice_from_raw_parts_mut(ptr, len);
    drop(Box::from_raw(slice));
  }
}

/// Run a boolean operation over the encoded shape list.
///
/// ABI: `op` is `0 = union`, `1 = intersect`, `2 = subtract`.
/// Input/output encoding is the flat f64 layout described in `wasm/README.md`.
/// The return value packs `(len << 32) | ptr`; callers must release it with
/// [`dealloc_f64`].
#[no_mangle]
pub extern "C" fn boolean_rings(operation: u32, ptr: *const f64, len: usize) -> u64 {
  if ptr.is_null() || len == 0 {
    return pack(Vec::new());
  }
  let input = unsafe { std::slice::from_raw_parts(ptr, len) };
  let shapes = match decode(input) {
    Some(shapes) => shapes,
    None => return pack(Vec::new()),
  };
  pack(encode(&boolean(operation, &shapes)))
}

/// Second geometry entry point: curve flattening, triangulation, and curve
/// editing. Op codes and payloads are documented in `wasm/README.md`.
///
/// The separate export keeps the hot boolean path byte-compatible while new
/// capabilities share one stable request/response envelope.
#[no_mangle]
pub extern "C" fn geometry_op(operation: u32, ptr: *const f64, len: usize) -> u64 {
  if ptr.is_null() || len == 0 {
    return pack(Vec::new());
  }
  let input = unsafe { std::slice::from_raw_parts(ptr, len) };
  let output = match operation {
    0 => tessellate(input),
    1 => flatten_circle(input),
    2 => flatten_arc(input),
    3 => flatten_cubic(input),
    4 => segment_intersections(input),
    5 => trim_polyline(input),
    6 => extend_polyline(input),
    7 => offset_polyline(input),
    8 => fillet_polyline(input),
    _ => Vec::new(),
  };
  pack(output)
}

fn decode(data: &[f64]) -> Option<Vec<MultiPolygon>> {
  let mut cursor = Cursor { data, index: 0 };
  let shape_count = cursor.count()?;
  let mut shapes = Vec::with_capacity(shape_count);
  for _ in 0..shape_count {
    let polygon_count = cursor.count()?;
    let mut shape = Vec::with_capacity(polygon_count);
    for _ in 0..polygon_count {
      let ring_count = cursor.count()?;
      let mut polygon = Vec::with_capacity(ring_count);
      for _ in 0..ring_count {
        let point_count = cursor.count()?;
        let mut ring = Vec::with_capacity(point_count);
        for _ in 0..point_count {
          let x = cursor.number()?;
          let y = cursor.number()?;
          ring.push([x, y] as Point);
        }
        if ring.len() >= 3 {
          polygon.push(ring);
        }
      }
      if !polygon.is_empty() {
        shape.push(polygon);
      }
    }
    shapes.push(shape);
  }
  Some(shapes)
}

fn encode(polygons: &MultiPolygon) -> Vec<f64> {
  let mut output = Vec::new();
  output.push(polygons.len() as f64);
  for polygon in polygons {
    output.push(polygon.len() as f64);
    for ring in polygon {
      output.push(ring.len() as f64);
      for point in ring {
        output.push(point[0]);
        output.push(point[1]);
      }
    }
  }
  output
}

fn pack(buffer: Vec<f64>) -> u64 {
  let boxed = buffer.into_boxed_slice();
  let len = boxed.len() as u32;
  let ptr = Box::into_raw(boxed) as *mut f64 as u32;
  ((len as u64) << 32) | ptr as u64
}

struct Cursor<'a> {
  data: &'a [f64],
  index: usize,
}

impl Cursor<'_> {
  fn number(&mut self) -> Option<f64> {
    let value = *self.data.get(self.index)?;
    self.index += 1;
    value.is_finite().then_some(value)
  }

  fn count(&mut self) -> Option<usize> {
    let value = self.number()?;
    if value < 0.0 || value.fract() != 0.0 || value > 1_000_000.0 {
      return None;
    }
    Some(value as usize)
  }

  fn point(&mut self) -> Option<Point> {
    let x = self.number()?;
    let y = self.number()?;
    Some([x, y])
  }

  fn points(&mut self) -> Option<Vec<Point>> {
    let count = self.count()?;
    if count > self.data.len() / 2 {
      return None;
    }
    let mut points = Vec::with_capacity(count);
    for _ in 0..count {
      points.push(self.point()?);
    }
    Some(points)
  }

  fn encoded_points(&mut self) -> Option<Vec<f64>> {
    let count = self.count()?;
    if count > self.data.len() / 4 {
      return None;
    }
    let mut points = Vec::with_capacity(count * 4);
    for _ in 0..count * 4 {
      points.push(self.number()?);
    }
    Some(points)
  }
}

fn tessellate(data: &[f64]) -> Vec<f64> {
  let Some(shapes) = decode(data) else {
    return Vec::new();
  };
  let polygons = shapes.into_iter().next().unwrap_or_default();
  let (positions, indices) = curve::triangulate(&polygons);
  let mut output = Vec::with_capacity(1 + positions.len() * 2 + 1 + indices.len());
  output.push(positions.len() as f64);
  for point in positions {
    output.push(point[0]);
    output.push(point[1]);
  }
  output.push(indices.len() as f64);
  for index in indices {
    output.push(index as f64);
  }
  output
}

fn flatten_circle(data: &[f64]) -> Vec<f64> {
  let mut cursor = Cursor { data, index: 0 };
  let Some(center) = cursor.point() else {
    return Vec::new();
  };
  let Some(radius) = cursor.number() else {
    return Vec::new();
  };
  let segments = cursor.number().unwrap_or(32.0);
  encode_ring(&curve::circle(center, radius, segments))
}

fn flatten_arc(data: &[f64]) -> Vec<f64> {
  let mut cursor = Cursor { data, index: 0 };
  let Some(start) = cursor.point() else {
    return Vec::new();
  };
  let Some(through) = cursor.point() else {
    return Vec::new();
  };
  let Some(end) = cursor.point() else {
    return Vec::new();
  };
  let segments = cursor.number().unwrap_or(24.0);
  encode_ring(&curve::arc_through(start, through, end, segments))
}

fn flatten_cubic(data: &[f64]) -> Vec<f64> {
  let mut cursor = Cursor { data, index: 0 };
  let Some(p0) = cursor.point() else {
    return Vec::new();
  };
  let Some(c1) = cursor.point() else {
    return Vec::new();
  };
  let Some(c2) = cursor.point() else {
    return Vec::new();
  };
  let Some(p1) = cursor.point() else {
    return Vec::new();
  };
  let tolerance = cursor.number().unwrap_or(0.25);
  encode_ring(&curve::cubic_bezier(p0, c1, c2, p1, tolerance))
}

fn segment_intersections(data: &[f64]) -> Vec<f64> {
  let mut cursor = Cursor { data, index: 0 };
  let Some(a) = cursor.encoded_points() else {
    return Vec::new();
  };
  let Some(b) = cursor.encoded_points() else {
    return Vec::new();
  };
  let hits = edit::intersections(&a, &b);
  let mut output = Vec::with_capacity(1 + hits.len() * 6);
  output.push(hits.len() as f64);
  for hit in hits {
    output.push(hit.point[0]);
    output.push(hit.point[1]);
    output.push(hit.a_segment as f64);
    output.push(hit.b_segment as f64);
    output.push(hit.t);
    output.push(hit.u);
  }
  output
}

fn trim_polyline(data: &[f64]) -> Vec<f64> {
  let mut cursor = Cursor { data, index: 0 };
  let Some(points) = cursor.points() else {
    return Vec::new();
  };
  let Some(boundary) = cursor.points() else {
    return Vec::new();
  };
  let keep_start = cursor.number().unwrap_or(1.0) >= 0.5;
  let (changed, result) = edit::trim(&tuples(&points), &tuples(&boundary), keep_start);
  encode_status(changed, &result)
}

fn extend_polyline(data: &[f64]) -> Vec<f64> {
  let mut cursor = Cursor { data, index: 0 };
  let Some(points) = cursor.points() else {
    return Vec::new();
  };
  let Some(boundary) = cursor.points() else {
    return Vec::new();
  };
  let extend_start = cursor.number().unwrap_or(1.0) < 0.5;
  let max_distance = cursor.number().unwrap_or(0.0);
  let (changed, result) = edit::extend(
    &tuples(&points),
    &tuples(&boundary),
    extend_start,
    max_distance,
  );
  encode_status(changed, &result)
}

fn offset_polyline(data: &[f64]) -> Vec<f64> {
  let mut cursor = Cursor { data, index: 0 };
  let Some(points) = cursor.points() else {
    return Vec::new();
  };
  let distance = cursor.number().unwrap_or(0.0);
  let closed = cursor.number().unwrap_or(0.0) >= 0.5;
  let round = cursor.number().unwrap_or(0.0) >= 0.5;
  let miter_limit = cursor.number().unwrap_or(4.0);
  encode_ring(&edit::offset(
    &tuples(&points),
    distance,
    closed,
    round,
    miter_limit,
  ))
}

fn fillet_polyline(data: &[f64]) -> Vec<f64> {
  let mut cursor = Cursor { data, index: 0 };
  let Some(points) = cursor.points() else {
    return Vec::new();
  };
  let radius = cursor.number().unwrap_or(0.0);
  let corner = cursor.number().unwrap_or(-1.0);
  let segments = cursor.number().unwrap_or(0.0);
  let closed = cursor.number().unwrap_or(0.0) >= 0.5;
  let corner = if corner < 0.0 {
    None
  } else {
    Some(corner as usize)
  };
  encode_ring(&edit::fillet(
    &tuples(&points),
    radius,
    corner,
    segments,
    closed,
  ))
}

fn tuples(points: &[Point]) -> Vec<(f64, f64)> {
  points.iter().map(|point| (point[0], point[1])).collect()
}

fn encode_ring(points: &[Point]) -> Vec<f64> {
  let mut output = Vec::with_capacity(1 + points.len() * 2);
  output.push(points.len() as f64);
  for point in points {
    output.push(point[0]);
    output.push(point[1]);
  }
  output
}

fn encode_status(changed: bool, points: &[Point]) -> Vec<f64> {
  let mut output = vec![if changed { 1.0 } else { 0.0 }, points.len() as f64];
  for point in points {
    output.push(point[0]);
    output.push(point[1]);
  }
  output
}

#[cfg(test)]
mod edit_tests {
  use crate::edit::{fillet, offset, trim};
  use crate::math::{distance, ring_area};

  #[test]
  fn trim_keeps_the_requested_side() {
    let (changed, kept) = trim(&[(0.0, 0.0), (10.0, 0.0)], &[(5.0, -1.0), (5.0, 1.0)], true);
    assert!(changed);
    assert_eq!(kept.len(), 2);
    assert!((kept[1][0] - 5.0).abs() < 1e-9);
  }

  #[test]
  fn offset_miter_keeps_square_area() {
    let square = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)];
    let grown = offset(&square, 2.0, true, false, 4.0);
    assert!((ring_area(&grown).abs() - 196.0).abs() < 1e-9);
  }

  #[test]
  fn fillet_replaces_a_corner_with_an_arc() {
    let rounded = fillet(
      &[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)],
      2.0,
      None,
      8.0,
      false,
    );
    assert!(rounded.len() > 3);
    assert!((distance(rounded[1], [8.0, 0.0])).abs() < 1e-9);
    assert!((distance(*rounded.last().unwrap(), [10.0, 10.0])).abs() < 1e-9);
  }
}
