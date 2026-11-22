//! Even-odd planar-boolean kernel.
//!
//! Strategy: build the planar arrangement of both operands (split every edge at
//! all intersections), keep the arrangement segments that separate result-inside
//! from result-outside, then stitch directed edges into rings. Stitching keeps
//! the result interior on the left, so outer rings come out counter-clockwise
//! and holes clockwise.
//!
//! This is intentionally a self-contained implementation: the project has no
//! network access to add a `geo`/`i_overlay` dependency, and the kernel must stay
//! small enough for the Wasm budget.

use crate::arrangement::{build_arrangement, collect_segments, select_edges, split_segments};
use crate::math::MultiPolygon;
use crate::rings::stitch_rings;

#[derive(Clone, Copy)]
pub(crate) enum Operation {
  Union,
  Intersect,
  Subtract,
}

impl Operation {
  fn from_code(code: u32) -> Self {
    match code {
      1 => Self::Intersect,
      2 => Self::Subtract,
      _ => Self::Union,
    }
  }

  pub(crate) fn contains(self, inside_a: bool, inside_b: bool) -> bool {
    match self {
      Self::Union => inside_a || inside_b,
      Self::Intersect => inside_a && inside_b,
      Self::Subtract => inside_a && !inside_b,
    }
  }
}

/// Execute a left-fold boolean over N operands, matching the TS/polygon-clipping
/// `union(first, ...rest)` / `intersection(first, ...rest)` /
/// `difference(first, ...rest)` semantics.
pub fn boolean(operation: u32, shapes: &[MultiPolygon]) -> MultiPolygon {
  let op = Operation::from_code(operation);
  let mut iter = shapes.iter();
  let Some(first) = iter.next() else {
    return Vec::new();
  };
  let mut result = first.clone();
  for next in iter {
    if result.is_empty() {
      // Intersection/subtraction with an empty accumulator stays empty; union
      // continues with the remaining operand.
      if matches!(op, Operation::Union) {
        result = next.clone();
      }
      continue;
    }
    result = binary(op, &result, next);
  }
  result
}

fn binary(op: Operation, a: &MultiPolygon, b: &MultiPolygon) -> MultiPolygon {
  let mut segments = collect_segments(a);
  segments.extend(collect_segments(b));
  if segments.is_empty() {
    return Vec::new();
  }
  split_segments(&mut segments);
  let arrangement = build_arrangement(&segments);
  let directed = select_edges(op, a, b, &arrangement);
  stitch_rings(&directed, &arrangement.nodes)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::math::{ring_area, MultiPolygon};

  fn rect(x1: f64, y1: f64, x2: f64, y2: f64) -> MultiPolygon {
    vec![vec![vec![[x1, y1], [x2, y1], [x2, y2], [x1, y2]]]]
  }

  #[test]
  fn union_overlapping_rectangles() {
    let output = boolean(0, &[rect(0.0, 0.0, 10.0, 10.0), rect(5.0, 0.0, 15.0, 10.0)]);
    assert_eq!(output.len(), 1);
    assert_eq!(output[0].len(), 1);
    assert!((ring_area(&output[0][0]).abs() - 150.0).abs() < 1e-9);
  }

  #[test]
  fn intersect_overlapping_rectangles() {
    let output = boolean(1, &[rect(0.0, 0.0, 10.0, 10.0), rect(5.0, 5.0, 15.0, 15.0)]);
    assert_eq!(output.len(), 1);
    assert!((ring_area(&output[0][0]).abs() - 25.0).abs() < 1e-9);
  }
}
