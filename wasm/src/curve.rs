//! Curve flattening and polygon triangulation.
//!
//! Both operations are pure functions over points: no DOM, no caches, no
//! product state. The TS facade decides segment counts so the kernel output can
//! stay byte-for-byte compatible with the legacy TypeScript samplers.

use crate::math::{cross, distance, sub, MultiPolygon, Point, Ring, EPS, TAU};

const TRI_EPS: f64 = 1e-12;
const MAX_SEGMENTS: usize = 4096;

pub(crate) fn circle(center: Point, radius: f64, segments: f64) -> Ring {
  let radius = radius.abs();
  if !radius.is_finite() || radius <= EPS {
    return Vec::new();
  }
  let count = segment_count(segments, 3);
  (0..count)
    .map(|index| {
      let angle = index as f64 / count as f64 * TAU;
      [
        center[0] + radius * angle.cos(),
        center[1] + radius * angle.sin(),
      ]
    })
    .collect()
}

/// Flatten an arc defined by three points: start, a point on the arc, end.
pub(crate) fn arc_through(a: Point, through: Point, b: Point, segments: f64) -> Ring {
  let Some(circle) = circumcircle(a, through, b) else {
    return vec![a, b];
  };
  let (center, radius) = circle;
  let start = (a[1] - center[1]).atan2(a[0] - center[0]);
  let middle = (through[1] - center[1]).atan2(through[0] - center[0]);
  let end = (b[1] - center[1]).atan2(b[0] - center[0]);
  let clockwise_sweep = normalize(end - start);
  let clockwise_through = normalize(middle - start);
  let (span, direction) = if clockwise_through <= clockwise_sweep + EPS {
    (clockwise_sweep, 1.0)
  } else {
    (normalize(start - end), -1.0)
  };
  let count = segment_count(segments, 1);
  (0..=count)
    .map(|index| {
      let angle = start + span * index as f64 / count as f64 * direction;
      [
        center[0] + radius * angle.cos(),
        center[1] + radius * angle.sin(),
      ]
    })
    .collect()
}

/// Adaptive cubic Bézier flattening. Recursion depth is bounded so pathological
/// control points cannot blow the stack.
pub(crate) fn cubic_bezier(p0: Point, c1: Point, c2: Point, p1: Point, tolerance: f64) -> Ring {
  let tolerance = if tolerance.is_finite() && tolerance > 0.0 {
    tolerance
  } else {
    0.25
  };
  let mut points = vec![p0];
  flatten_cubic(p0, c1, c2, p1, tolerance, 0, &mut points);
  points.push(p1);
  dedupe(&mut points);
  points
}

fn flatten_cubic(
  p0: Point,
  c1: Point,
  c2: Point,
  p1: Point,
  tolerance: f64,
  depth: u32,
  out: &mut Ring,
) {
  if depth >= 24 || flat_enough(p0, c1, c2, p1, tolerance) {
    return;
  }
  let p01 = midpoint(p0, c1);
  let p12 = midpoint(c1, c2);
  let p23 = midpoint(c2, p1);
  let p012 = midpoint(p01, p12);
  let p123 = midpoint(p12, p23);
  let mid = midpoint(p012, p123);
  flatten_cubic(p0, p01, p012, mid, tolerance, depth + 1, out);
  out.push(mid);
  flatten_cubic(mid, p123, p23, p1, tolerance, depth + 1, out);
}

fn flat_enough(p0: Point, c1: Point, c2: Point, p1: Point, tolerance: f64) -> bool {
  let chord = distance(p0, p1).max(EPS);
  let d1 = distance_to_line(p0, p1, c1);
  let d2 = distance_to_line(p0, p1, c2);
  (d1 + d2) * 0.5 <= tolerance && chord > 2.0 * tolerance || chord <= tolerance
}

fn distance_to_line(a: Point, b: Point, point: Point) -> f64 {
  let direction = sub(b, a);
  let length = (direction[0] * direction[0] + direction[1] * direction[1]).sqrt();
  if length <= EPS {
    return distance(a, point);
  }
  (cross(direction, sub(point, a)) / length).abs()
}

fn midpoint(a: Point, b: Point) -> Point {
  [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5]
}

fn circumcircle(a: Point, b: Point, c: Point) -> Option<(Point, f64)> {
  let divisor = 2.0 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if divisor.abs() <= 1e-9 {
    return None;
  }
  let a2 = a[0] * a[0] + a[1] * a[1];
  let b2 = b[0] * b[0] + b[1] * b[1];
  let c2 = c[0] * c[0] + c[1] * c[1];
  let center: Point = [
    (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / divisor,
    (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / divisor,
  ];
  let radius = distance(a, center);
  (radius.is_finite() && radius > 0.5).then_some((center, radius))
}

fn normalize(value: f64) -> f64 {
  value.rem_euclid(TAU)
}

fn segment_count(value: f64, minimum: usize) -> usize {
  if !value.is_finite() || value < 1.0 {
    return minimum;
  }
  (value.round() as usize).clamp(minimum, MAX_SEGMENTS)
}

fn dedupe(points: &mut Ring) {
  let mut index = 1;
  while index < points.len() {
    if distance(points[index - 1], points[index]) <= EPS {
      points.remove(index);
    } else {
      index += 1;
    }
  }
}

/// Triangulate a MultiPolygon (outer ring + holes) into positions/indices.
///
/// Uses an even-odd scanline instead of hole bridging + ear clipping. Bridging
/// two holes into one weakly-simple ring made ear clipping emit overlapping
/// triangles (and could fill a hole); the scanline pairs edge intersections in
/// every vertical slab, matching Canvas2D/SVG `evenodd` semantics directly.
pub(crate) fn triangulate(polygons: &MultiPolygon) -> (Vec<Point>, Vec<u32>) {
  let mut positions = Vec::new();
  let mut indices = Vec::new();
  for polygon in polygons {
    let rings: Vec<Ring> = polygon
      .iter()
      .map(|ring| clean_ring(ring))
      .filter(|ring| ring.len() >= 3)
      .collect();
    if rings.is_empty() {
      continue;
    }
    let base = positions.len() as u32;
    let (vertices, triangles) = scanline_triangulate(&rings);
    positions.extend(vertices);
    indices.extend(triangles.into_iter().map(|index| base + index));
  }
  (positions, indices)
}

/// Split the polygon into vertical slabs at every vertex x, then fill each
/// slab's even-odd y-spans with two triangles per trapezoid.
fn scanline_triangulate(rings: &[Ring]) -> (Vec<Point>, Vec<u32>) {
  let edges: Vec<(Point, Point)> = rings
    .iter()
    .flat_map(|ring| {
      (0..ring.len()).map(move |index| (ring[index], ring[(index + 1) % ring.len()]))
    })
    .collect();
  let mut slabs: Vec<f64> = rings.iter().flatten().map(|point| point[0]).collect();
  slabs.sort_by(|left, right| left.total_cmp(right));
  slabs.dedup_by(|left, right| (*left - *right).abs() <= EPS);

  let mut positions = Vec::new();
  let mut indices = Vec::new();
  for pair in slabs.windows(2) {
    let (left, right) = (pair[0], pair[1]);
    if right - left <= EPS {
      continue;
    }
    let middle = (left + right) * 0.5;
    let mut hits: Vec<(f64, usize)> = Vec::new();
    for (index, &(a, b)) in edges.iter().enumerate() {
      let (lower, upper) = if a[0] <= b[0] {
        (a[0], b[0])
      } else {
        (b[0], a[0])
      };
      // Vertical edges only touch slab borders; horizontals are the span edges.
      if middle <= lower || middle >= upper {
        continue;
      }
      let t = (middle - a[0]) / (b[0] - a[0]);
      hits.push((a[1] + (b[1] - a[1]) * t, index));
    }
    hits.sort_by(|left, right| left.0.total_cmp(&right.0));
    for span in hits.chunks_exact(2) {
      if span[1].0 - span[0].0 <= TRI_EPS {
        continue;
      }
      let lower = edges[span[0].1];
      let upper = edges[span[1].1];
      let quad = [
        [left, edge_y(lower, left)],
        [right, edge_y(lower, right)],
        [right, edge_y(upper, right)],
        [left, edge_y(upper, left)],
      ];
      let area = cross(sub(quad[1], quad[0]), sub(quad[2], quad[0]))
        + cross(sub(quad[2], quad[0]), sub(quad[3], quad[0]));
      if area.abs() <= TRI_EPS {
        continue;
      }
      let start = positions.len() as u32;
      positions.extend_from_slice(&quad);
      indices.extend_from_slice(&[start, start + 1, start + 2, start, start + 2, start + 3]);
    }
  }
  (positions, indices)
}

fn edge_y(edge: (Point, Point), x: f64) -> f64 {
  let (a, b) = edge;
  let delta = b[0] - a[0];
  if delta.abs() <= EPS {
    return a[1];
  }
  a[1] + (b[1] - a[1]) * (x - a[0]) / delta
}

fn clean_ring(ring: &[Point]) -> Ring {
  let mut out: Ring = Vec::with_capacity(ring.len());
  for &point in ring {
    if !point[0].is_finite() || !point[1].is_finite() {
      continue;
    }
    if out.last().map_or(true, |last| distance(*last, point) > EPS) {
      out.push(point);
    }
  }
  if out.len() > 1 && distance(out[0], *out.last().unwrap()) <= EPS {
    out.pop();
  }
  loop {
    if out.len() < 3 {
      break;
    }
    let mut removed = false;
    for index in 0..out.len() {
      let previous = out[(index + out.len() - 1) % out.len()];
      let current = out[index];
      let next = out[(index + 1) % out.len()];
      let scale = distance(previous, current) * distance(current, next);
      if cross(sub(current, previous), sub(next, current)).abs() <= TRI_EPS * (1.0 + scale) {
        out.remove(index);
        removed = true;
        break;
      }
    }
    if !removed {
      break;
    }
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::math::ring_area;

  fn triangle_area(positions: &[Point], indices: &[u32]) -> f64 {
    indices
      .chunks(3)
      .map(|triangle| {
        let a = positions[triangle[0] as usize];
        let b = positions[triangle[1] as usize];
        let c = positions[triangle[2] as usize];
        ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) * 0.5
      })
      .sum::<f64>()
      .abs()
  }

  #[test]
  fn triangulates_square_with_hole() {
    let polygon = vec![
      vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]],
      vec![[3.0, 3.0], [3.0, 7.0], [7.0, 7.0], [7.0, 3.0]],
    ];
    let (positions, indices) = triangulate(&vec![polygon]);
    let expected = 100.0 - 16.0;
    assert!((triangle_area(&positions, &indices) - expected).abs() < 1e-9);
  }

  fn covered(positions: &[Point], indices: &[u32], point: Point) -> bool {
    let mut inside = false;
    for triangle in indices.chunks(3) {
      let [a, b, c] = [
        positions[triangle[0] as usize],
        positions[triangle[1] as usize],
        positions[triangle[2] as usize],
      ];
      let edge = |from: Point, to: Point| cross(sub(to, from), sub(point, from));
      let (ab, bc, ca) = (edge(a, b), edge(b, c), edge(c, a));
      if (ab >= 0.0 && bc >= 0.0 && ca >= 0.0) || (ab <= 0.0 && bc <= 0.0 && ca <= 0.0) {
        inside = !inside;
      }
    }
    inside
  }

  #[test]
  fn triangulates_two_holes_without_filling_them() {
    // Review regression: bridging two holes used to pick an invalid bridge,
    // producing triangles outside the outer ring and filling the second hole.
    let polygon = vec![
      vec![[0.0, 0.0], [80.0, 0.0], [80.0, 53.0], [0.0, 53.0]],
      vec![[8.0, 3.0], [23.0, 3.0], [23.0, 9.0], [8.0, 9.0]],
      vec![[18.0, 32.0], [33.0, 32.0], [33.0, 44.0], [18.0, 44.0]],
    ];
    let (positions, indices) = triangulate(&vec![polygon]);
    let area = triangle_area(&positions, &indices);
    assert!((area - 3970.0).abs() < 1e-6, "area = {area}");
    assert!(
      !covered(&positions, &indices, [25.0, 35.0]),
      "second hole must stay empty"
    );
    assert!(
      !covered(&positions, &indices, [15.0, 6.0]),
      "first hole must stay empty"
    );
    assert!(
      covered(&positions, &indices, [15.0, 35.0]),
      "solid area must be filled"
    );
    assert!(
      covered(&positions, &indices, [70.0, 45.0]),
      "outer area must be filled"
    );
  }

  #[test]
  fn circle_and_arc_keep_endpoints() {
    let points = circle([0.0, 0.0], 10.0, 32.0);
    assert_eq!(points.len(), 32);
    assert!((ring_area(&points).abs() - std::f64::consts::PI * 100.0).abs() < 3.0);
    let arc = arc_through([10.0, 0.0], [0.0, 10.0], [-10.0, 0.0], 16.0);
    assert_eq!(arc.len(), 17);
    assert!((distance(arc[0], [10.0, 0.0])).abs() < 1e-9);
    assert!((distance(*arc.last().unwrap(), [-10.0, 0.0])).abs() < 1e-9);
  }
}
