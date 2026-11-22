//! Shared 2D primitives for the boolean kernel.

use std::f64::consts::PI;

pub type Point = [f64; 2];
pub type Ring = Vec<Point>;
pub type Polygon = Vec<Ring>;
pub type MultiPolygon = Vec<Polygon>;

pub(crate) const EPS: f64 = 1e-9;
pub(crate) const SAMPLE_EPS: f64 = 1e-6;
pub(crate) const KEY_SCALE: f64 = 1e9;
pub(crate) const TAU: f64 = PI * 2.0;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Key(pub i64, pub i64);

pub(crate) fn point_key(point: Point) -> Key {
  Key(
    (point[0] * KEY_SCALE).round() as i64,
    (point[1] * KEY_SCALE).round() as i64,
  )
}

pub(crate) fn sub(a: Point, b: Point) -> Point {
  [a[0] - b[0], a[1] - b[1]]
}

pub(crate) fn cross(a: Point, b: Point) -> f64 {
  a[0] * b[1] - a[1] * b[0]
}

pub(crate) fn distance(a: Point, b: Point) -> f64 {
  ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()
}

pub(crate) fn length(vector: Point) -> f64 {
  (vector[0] * vector[0] + vector[1] * vector[1]).sqrt()
}

pub(crate) fn lerp(a: Point, b: Point, t: f64) -> Point {
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

pub(crate) fn project(a: Point, b: Point, point: Point) -> f64 {
  let direction = sub(b, a);
  let length_squared = direction[0] * direction[0] + direction[1] * direction[1];
  if length_squared <= EPS {
    return 0.0;
  }
  let relative = sub(point, a);
  ((relative[0] * direction[0] + relative[1] * direction[1]) / length_squared).clamp(0.0, 1.0)
}

pub(crate) fn normalize_angle(value: f64) -> f64 {
  value.rem_euclid(TAU)
}

pub(crate) fn ring_area(ring: &[Point]) -> f64 {
  if ring.len() < 3 {
    return 0.0;
  }
  let mut total = 0.0;
  for index in 0..ring.len() {
    let a = ring[index];
    let b = ring[(index + 1) % ring.len()];
    total += a[0] * b[1] - b[0] * a[1];
  }
  total * 0.5
}

pub(crate) fn point_in_ring(ring: &[Point], point: Point) -> bool {
  let mut inside = false;
  if ring.len() < 2 {
    return false;
  }
  for index in 0..ring.len() {
    let a = ring[index];
    let b = ring[(index + 1) % ring.len()];
    if (a[1] > point[1]) != (b[1] > point[1]) {
      let x = a[0] + (point[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
      if point[0] < x {
        inside = !inside;
      }
    }
  }
  inside
}
