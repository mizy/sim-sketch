//! Stateless curve-editing primitives: intersections, trim, extend, offset,
//! and fillet. Every function takes plain polylines and returns plain polylines
//! so the kernel stays independent from product entities and rendering.

use crate::math::{cross, distance, lerp, sub, Ring, EPS, TAU};

#[derive(Clone, Copy)]
pub(crate) struct Intersection {
  pub(crate) point: [f64; 2],
  pub(crate) a_segment: usize,
  pub(crate) b_segment: usize,
  pub(crate) t: f64,
  pub(crate) u: f64,
}

pub(crate) fn intersections(a: &[f64], b: &[f64]) -> Vec<Intersection> {
  let mut output = Vec::new();
  let a_len = a.len() / 4;
  let b_len = b.len() / 4;
  for i in 0..a_len {
    let a0 = [a[i * 4], a[i * 4 + 1]];
    let a1 = [a[i * 4 + 2], a[i * 4 + 3]];
    for j in 0..b_len {
      let b0 = [b[j * 4], b[j * 4 + 1]];
      let b1 = [b[j * 4 + 2], b[j * 4 + 3]];
      segment_hits(a0, a1, b0, b1, i, j, &mut output);
    }
  }
  output.sort_by(|left, right| {
    left
      .a_segment
      .cmp(&right.a_segment)
      .then_with(|| {
        left
          .t
          .partial_cmp(&right.t)
          .unwrap_or(std::cmp::Ordering::Equal)
      })
      .then_with(|| left.b_segment.cmp(&right.b_segment))
  });
  output
}

fn segment_hits(
  a0: [f64; 2],
  a1: [f64; 2],
  b0: [f64; 2],
  b1: [f64; 2],
  i: usize,
  j: usize,
  output: &mut Vec<Intersection>,
) {
  let r = sub(a1, a0);
  let s = sub(b1, b0);
  let r_len = (r[0] * r[0] + r[1] * r[1]).sqrt();
  let s_len = (s[0] * s[0] + s[1] * s[1]).sqrt();
  if r_len <= EPS || s_len <= EPS {
    return;
  }
  let denominator = cross(r, s);
  if denominator.abs() <= EPS * r_len * s_len {
    let offset = sub(b0, a0);
    if cross(offset, r).abs()
      > EPS * r_len * (1.0 + (offset[0] * offset[0] + offset[1] * offset[1]).sqrt())
    {
      return;
    }
    let axis = if r[0].abs() >= r[1].abs() { 0 } else { 1 };
    if r[axis].abs() <= EPS {
      return;
    }
    let mut t0 = (b0[axis] - a0[axis]) / r[axis];
    let mut t1 = (b1[axis] - a0[axis]) / r[axis];
    if t0 > t1 {
      std::mem::swap(&mut t0, &mut t1);
    }
    let lower = t0.max(0.0);
    let upper = t1.min(1.0);
    if lower > upper + EPS {
      return;
    }
    for t in [lower, upper] {
      let t = t.clamp(0.0, 1.0);
      let point = lerp(a0, a1, t);
      let u = project_param(b0, b1, point);
      push_unique(
        output,
        Intersection {
          point,
          a_segment: i,
          b_segment: j,
          t,
          u,
        },
      );
    }
    return;
  }
  let t = cross(sub(b0, a0), s) / denominator;
  let u = cross(sub(b0, a0), r) / denominator;
  if t < -EPS || t > 1.0 + EPS || u < -EPS || u > 1.0 + EPS {
    return;
  }
  let t = t.clamp(0.0, 1.0);
  let u = u.clamp(0.0, 1.0);
  let point = lerp(a0, a1, t);
  push_unique(
    output,
    Intersection {
      point,
      a_segment: i,
      b_segment: j,
      t,
      u,
    },
  );
}

fn push_unique(output: &mut Vec<Intersection>, hit: Intersection) {
  if output.iter().any(|existing| {
    existing.a_segment == hit.a_segment
      && existing.b_segment == hit.b_segment
      && (existing.point[0] - hit.point[0]).abs() <= EPS
      && (existing.point[1] - hit.point[1]).abs() <= EPS
  }) {
    return;
  }
  output.push(hit);
}

fn project_param(a: [f64; 2], b: [f64; 2], point: [f64; 2]) -> f64 {
  let direction = sub(b, a);
  let length_squared = direction[0] * direction[0] + direction[1] * direction[1];
  if length_squared <= EPS {
    return 0.0;
  }
  let relative = sub(point, a);
  ((relative[0] * direction[0] + relative[1] * direction[1]) / length_squared).clamp(0.0, 1.0)
}

pub(crate) fn trim(
  points: &[(f64, f64)],
  boundary: &[(f64, f64)],
  keep_start: bool,
) -> (bool, Ring) {
  let parsed = parse(points);
  let boundary = parse(boundary);
  if parsed.len() < 2 || boundary.len() < 2 {
    return (false, parsed);
  }
  let a = segments(&parsed);
  let b = segments(&boundary);
  let hits = intersections(&a, &b);
  if hits.is_empty() {
    return (false, parsed);
  }
  let lengths = cumulative(&parsed);
  let mut chosen: Option<(f64, Intersection)> = None;
  for hit in hits {
    let parameter =
      lengths[hit.a_segment] + hit.t * distance(parsed[hit.a_segment], parsed[hit.a_segment + 1]);
    let better = match chosen {
      Some((current, _)) => {
        if keep_start {
          parameter < current
        } else {
          parameter > current
        }
      }
      None => true,
    };
    if better {
      chosen = Some((parameter, hit));
    }
  }
  let Some((_, hit)) = chosen else {
    return (false, parsed);
  };
  let point = hit.point;
  let trimmed = if keep_start {
    let mut result = parsed[..=hit.a_segment].to_vec();
    push_point(&mut result, point);
    result
  } else {
    let mut result = vec![point];
    result.extend_from_slice(&parsed[hit.a_segment + 1..]);
    dedupe(&mut result);
    result
  };
  let changed = trimmed.len() != parsed.len()
    || distance(trimmed[0], parsed[0]) > EPS
    || distance(*trimmed.last().unwrap(), *parsed.last().unwrap()) > EPS;
  (changed, trimmed)
}

pub(crate) fn extend(
  points: &[(f64, f64)],
  boundary: &[(f64, f64)],
  extend_start: bool,
  max_distance: f64,
) -> (bool, Ring) {
  let parsed = parse(points);
  let boundary = parse(boundary);
  if parsed.len() < 2 {
    return (false, parsed);
  }
  let origin = if extend_start {
    parsed[0]
  } else {
    *parsed.last().unwrap()
  };
  let neighbor = if extend_start {
    parsed[1]
  } else {
    parsed[parsed.len() - 2]
  };
  let direction = normalize(sub(origin, neighbor));
  if direction == [0.0, 0.0] {
    return (false, parsed);
  }

  let mut nearest: Option<(f64, [f64; 2])> = None;
  for index in 0..boundary.len().saturating_sub(1) {
    let c = boundary[index];
    let d = boundary[index + 1];
    let s = sub(d, c);
    let denominator = cross(direction, s);
    if denominator.abs() <= EPS {
      continue;
    }
    let offset = sub(c, origin);
    let ray = cross(offset, s) / denominator;
    let edge = cross(offset, direction) / denominator;
    if ray < -EPS || edge < -EPS || edge > 1.0 + EPS {
      continue;
    }
    if nearest.map_or(true, |(current, _)| ray < current) {
      nearest = Some((
        ray,
        [
          origin[0] + direction[0] * ray,
          origin[1] + direction[1] * ray,
        ],
      ));
    }
  }

  let mut result = parsed;
  let mut changed = false;
  if let Some((ray, point)) = nearest {
    if ray > EPS {
      if extend_start {
        result.insert(0, point);
      } else {
        result.push(point);
      }
      changed = distance(point, origin) > EPS;
    }
  } else if max_distance.is_finite() && max_distance > EPS {
    let point = [
      origin[0] + direction[0] * max_distance,
      origin[1] + direction[1] * max_distance,
    ];
    if extend_start {
      result.insert(0, point);
    } else {
      result.push(point);
    }
    changed = true;
  }
  (changed, result)
}

pub(crate) fn offset(
  points: &[(f64, f64)],
  amount: f64,
  closed: bool,
  round: bool,
  miter_limit: f64,
) -> Ring {
  let mut parsed = parse(points);
  if amount.abs() <= EPS || parsed.len() < 2 {
    return parsed;
  }
  if closed && parsed.len() > 2 {
    if ring_area(&parsed) < 0.0 {
      parsed.reverse();
    }
    parsed.push(parsed[0]);
  }
  let signed = if closed { -amount } else { amount };
  let limit = if miter_limit.is_finite() && miter_limit >= 1.0 {
    miter_limit
  } else {
    4.0
  };
  let mut result = Vec::new();
  if !closed {
    let first_direction = direction(parsed[0], parsed[1]);
    result.push(add(parsed[0], scale(left_normal(first_direction), signed)));
  }
  let start = if closed { 0 } else { 1 };
  let end = if closed {
    parsed.len() - 1
  } else {
    parsed.len() - 1
  };
  for index in start..end {
    let previous_index = if index == 0 {
      parsed.len() - 2
    } else {
      index - 1
    };
    let previous = parsed[previous_index];
    let vertex = parsed[index];
    let next = parsed[index + 1];
    result.extend(join(previous, vertex, next, signed, round, limit));
  }
  if !closed {
    let last = parsed.len() - 1;
    let last_direction = direction(parsed[last - 1], parsed[last]);
    result.push(add(
      parsed[last],
      scale(left_normal(last_direction), signed),
    ));
  } else {
    // The cyclic loop repeats the first vertex's join at the seam.
    if let (Some(first), Some(last)) = (result.first().copied(), result.last().copied()) {
      if distance(first, last) <= EPS {
        result.pop();
      }
    }
  }
  dedupe(&mut result);
  result
}

fn join(
  previous: [f64; 2],
  vertex: [f64; 2],
  next: [f64; 2],
  signed: f64,
  round: bool,
  limit: f64,
) -> Vec<[f64; 2]> {
  let incoming = direction(previous, vertex);
  let outgoing = direction(vertex, next);
  if incoming == [0.0, 0.0] || outgoing == [0.0, 0.0] {
    return Vec::new();
  }
  let start = add(vertex, scale(left_normal(incoming), signed));
  let finish = add(vertex, scale(left_normal(outgoing), signed));
  if round {
    return round_join(vertex, start, finish, signed.abs());
  }
  let denominator = cross(incoming, outgoing);
  if denominator.abs() <= EPS {
    return vec![start];
  }
  let line_start = add(previous, scale(left_normal(incoming), signed));
  let line_next = add(vertex, scale(left_normal(outgoing), signed));
  let t = cross(sub(line_next, line_start), outgoing) / denominator;
  let miter = add(line_start, scale(incoming, t));
  if distance(miter, vertex) <= limit * signed.abs() + EPS {
    vec![miter]
  } else {
    vec![start, finish]
  }
}

fn round_join(vertex: [f64; 2], start: [f64; 2], finish: [f64; 2], radius: f64) -> Vec<[f64; 2]> {
  let start_angle = (start[1] - vertex[1]).atan2(start[0] - vertex[0]);
  let finish_angle = (finish[1] - vertex[1]).atan2(finish[0] - vertex[0]);
  let cross_sign = cross(sub(start, vertex), sub(finish, vertex));
  let mut delta = (finish_angle - start_angle).rem_euclid(TAU);
  if delta > std::f64::consts::PI {
    delta -= TAU;
  }
  if cross_sign.abs() > EPS && cross_sign.signum() != delta.signum() {
    delta = -delta;
  }
  let count = ((delta.abs() / (std::f64::consts::PI / 18.0)).ceil() as usize).clamp(2, 64);
  (0..=count)
    .map(|index| {
      let angle = start_angle + delta * index as f64 / count as f64;
      [
        vertex[0] + radius * angle.cos(),
        vertex[1] + radius * angle.sin(),
      ]
    })
    .collect()
}

pub(crate) fn fillet(
  points: &[(f64, f64)],
  radius: f64,
  corner: Option<usize>,
  segments: f64,
  closed: bool,
) -> Ring {
  let parsed = parse(points);
  if radius <= EPS || parsed.len() < 3 {
    return parsed;
  }
  let requested_segments = if segments.is_finite() && segments >= 2.0 {
    segments as usize
  } else {
    0
  };
  let mut result = Vec::with_capacity(parsed.len() * 4);
  if closed && parsed.len() > 2 {
    for index in 0..parsed.len() {
      let previous = parsed[(index + parsed.len() - 1) % parsed.len()];
      let next = parsed[(index + 1) % parsed.len()];
      let selected = corner.map_or(true, |target| target == index);
      if selected {
        let arc = fillet_corner(previous, parsed[index], next, radius, requested_segments);
        if arc.is_empty() {
          result.push(parsed[index]);
        } else {
          result.extend(arc);
        }
      } else {
        result.push(parsed[index]);
      }
    }
    dedupe(&mut result);
    if result.len() > 1 && distance(result[0], *result.last().unwrap()) <= EPS {
      result.pop();
    }
    return result;
  }
  result.push(parsed[0]);
  for index in 1..parsed.len() - 1 {
    let selected = corner.map_or(true, |target| target == index);
    if selected {
      let arc = fillet_corner(
        parsed[index - 1],
        parsed[index],
        parsed[index + 1],
        radius,
        requested_segments,
      );
      if arc.is_empty() {
        result.push(parsed[index]);
      } else {
        result.extend(arc);
      }
    } else {
      result.push(parsed[index]);
    }
  }
  result.push(parsed[parsed.len() - 1]);
  dedupe(&mut result);
  result
}

fn fillet_corner(
  previous: [f64; 2],
  vertex: [f64; 2],
  next: [f64; 2],
  radius: f64,
  requested_segments: usize,
) -> Vec<[f64; 2]> {
  let back = normalize(sub(previous, vertex));
  let forward = normalize(sub(next, vertex));
  if back == [0.0, 0.0] || forward == [0.0, 0.0] {
    return Vec::new();
  }
  let dot = (back[0] * forward[0] + back[1] * forward[1]).clamp(-1.0, 1.0);
  let angle = dot.acos();
  if angle <= 1e-6 || (std::f64::consts::PI - angle) <= 1e-6 {
    return Vec::new();
  }
  let tangent = radius / (angle * 0.5).tan();
  let max_tangent = distance(previous, vertex).min(distance(vertex, next)) * 0.49;
  let tangent = tangent.min(max_tangent);
  if tangent <= EPS {
    return Vec::new();
  }
  let effective_radius = tangent * (angle * 0.5).tan();
  let start = add(vertex, scale(back, tangent));
  let finish = add(vertex, scale(forward, tangent));
  let bisector = normalize(add(back, forward));
  if bisector == [0.0, 0.0] {
    return Vec::new();
  }
  let center_distance = effective_radius / (angle * 0.5).sin();
  let center = add(vertex, scale(bisector, center_distance));
  let start_angle = (start[1] - center[1]).atan2(start[0] - center[0]);
  let finish_angle = (finish[1] - center[1]).atan2(finish[0] - center[0]);
  let mut delta = (finish_angle - start_angle).rem_euclid(TAU);
  if delta > std::f64::consts::PI {
    delta -= TAU;
  }
  let auto = ((delta.abs() / (std::f64::consts::PI / 18.0)).ceil() as usize).clamp(2, 64);
  let count = if requested_segments >= 2 {
    requested_segments.clamp(2, 256)
  } else {
    auto
  };
  (0..=count)
    .map(|index| {
      let angle = start_angle + delta * index as f64 / count as f64;
      [
        center[0] + effective_radius * angle.cos(),
        center[1] + effective_radius * angle.sin(),
      ]
    })
    .collect()
}

fn parse(points: &[(f64, f64)]) -> Ring {
  let mut parsed = Vec::with_capacity(points.len());
  for &(x, y) in points {
    if !x.is_finite() || !y.is_finite() {
      continue;
    }
    let point = [x, y];
    if parsed
      .last()
      .map_or(true, |last: &[f64; 2]| distance(*last, point) > EPS)
    {
      parsed.push(point);
    }
  }
  parsed
}

fn segments(points: &[[f64; 2]]) -> Vec<f64> {
  let mut output = Vec::new();
  for pair in points.windows(2) {
    output.extend_from_slice(&[pair[0][0], pair[0][1], pair[1][0], pair[1][1]]);
  }
  output
}

fn cumulative(points: &[[f64; 2]]) -> Vec<f64> {
  let mut total = vec![0.0];
  for pair in points.windows(2) {
    total.push(total.last().copied().unwrap_or(0.0) + distance(pair[0], pair[1]));
  }
  total
}

fn direction(a: [f64; 2], b: [f64; 2]) -> [f64; 2] {
  normalize(sub(b, a))
}

fn normalize(vector: [f64; 2]) -> [f64; 2] {
  let length = (vector[0] * vector[0] + vector[1] * vector[1]).sqrt();
  if length <= EPS {
    [0.0, 0.0]
  } else {
    [vector[0] / length, vector[1] / length]
  }
}

fn left_normal(direction: [f64; 2]) -> [f64; 2] {
  [-direction[1], direction[0]]
}

fn add(a: [f64; 2], b: [f64; 2]) -> [f64; 2] {
  [a[0] + b[0], a[1] + b[1]]
}

fn scale(vector: [f64; 2], factor: f64) -> [f64; 2] {
  [vector[0] * factor, vector[1] * factor]
}

fn ring_area(ring: &[[f64; 2]]) -> f64 {
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

fn push_point(points: &mut Ring, point: [f64; 2]) {
  if points
    .last()
    .map_or(true, |last| distance(*last, point) > EPS)
  {
    points.push(point);
  }
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
