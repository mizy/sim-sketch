//! Stitch selected arrangement edges into rings and group them into components.

use crate::math::{
  length, normalize_angle, point_in_ring, ring_area, sub, MultiPolygon, Point, Ring, EPS,
  SAMPLE_EPS, TAU,
};

pub(crate) fn stitch_rings(directed: &[(usize, usize)], nodes: &[Point]) -> MultiPolygon {
  let mut outgoing: Vec<Vec<usize>> = vec![Vec::new(); nodes.len()];
  for (index, &(from, _)) in directed.iter().enumerate() {
    outgoing[from].push(index);
  }
  let mut used = vec![false; directed.len()];
  let mut rings = Vec::new();

  for start in 0..directed.len() {
    if used[start] {
      continue;
    }
    let start_node = directed[start].0;
    let mut current = start;
    let mut ring: Ring = Vec::new();
    let mut closed = false;
    for _ in 0..=directed.len() {
      if used[current] {
        break;
      }
      used[current] = true;
      let (from, to) = directed[current];
      ring.push(nodes[from]);
      if to == start_node {
        closed = true;
        break;
      }
      let Some(next) = next_edge(current, to, directed, &outgoing, &used, nodes) else {
        break;
      };
      current = next;
    }
    if closed && ring.len() >= 3 {
      let area = ring_area(&ring);
      if area.abs() > 1e-9 {
        rings.push(ring);
      }
    }
  }

  group_rings(rings)
}

fn next_edge(
  current: usize,
  node: usize,
  directed: &[(usize, usize)],
  outgoing: &[Vec<usize>],
  used: &[bool],
  nodes: &[Point],
) -> Option<usize> {
  let (from, to) = directed[current];
  let incoming = edge_angle(from, to, nodes);
  // Walking the face on the left: the next edge is the first one clockwise
  // from the reverse of the incoming direction.
  let twin = normalize_angle(incoming + std::f64::consts::PI);
  let mut best: Option<(usize, f64)> = None;
  for &candidate in &outgoing[node] {
    if used[candidate] {
      continue;
    }
    let (candidate_from, candidate_to) = directed[candidate];
    let out_angle = edge_angle(candidate_from, candidate_to, nodes);
    let mut clockwise = (twin - out_angle).rem_euclid(TAU);
    if clockwise <= 1e-9 {
      clockwise += TAU;
    }
    if best.map_or(true, |(_, best_cw)| clockwise < best_cw) {
      best = Some((candidate, clockwise));
    }
  }
  best.map(|(candidate, _)| candidate)
}

fn edge_angle(from: usize, to: usize, nodes: &[Point]) -> f64 {
  let a = nodes[from];
  let b = nodes[to];
  (b[1] - a[1]).atan2(b[0] - a[0])
}

fn group_rings(rings: Vec<Ring>) -> MultiPolygon {
  if rings.is_empty() {
    return Vec::new();
  }
  // 代表点取环内部样本，避免 ring[0] 落在边界/切点时 containment 判断翻转。
  let samples: Vec<Point> = rings.iter().map(|ring| ring_sample(ring)).collect();
  let depths: Vec<usize> = rings
    .iter()
    .enumerate()
    .map(|(index, _)| {
      rings
        .iter()
        .enumerate()
        .filter(|(other, candidate)| *other != index && point_in_ring(candidate, samples[index]))
        .count()
    })
    .collect();

  let mut outers: Vec<Ring> = Vec::new();
  let mut holes: Vec<(usize, Ring)> = Vec::new();
  for (index, ring) in rings.into_iter().enumerate() {
    if depths[index] % 2 == 1 {
      holes.push((index, orient(ring, false)));
    } else {
      outers.push(orient(ring, true));
    }
  }
  let mut polygons: Vec<crate::math::Polygon> =
    outers.iter().map(|ring| vec![ring.clone()]).collect();
  let outer_areas: Vec<f64> = outers.iter().map(|ring| ring_area(ring).abs()).collect();

  for (index, hole) in holes {
    let sample = samples[index];
    // owner 是 outers 的位置索引，不能拿原始 ring 索引去索引 outer_areas。
    let mut owner: Option<usize> = None;
    for (position, ring) in outers.iter().enumerate() {
      if !point_in_ring(ring, sample) {
        continue;
      }
      let better = owner.map_or(true, |current| outer_areas[current] > outer_areas[position]);
      if better {
        owner = Some(position);
      }
    }
    match owner {
      Some(position) => polygons[position].push(hole),
      None => polygons.push(vec![orient(hole, true)]),
    }
  }

  polygons.retain(|polygon| polygon[0].len() >= 3 && ring_area(&polygon[0]).abs() > 1e-9);
  polygons
}

fn ring_sample(ring: &Ring) -> Point {
  let area = ring_area(ring);
  let a = ring[0];
  let b = ring[1 % ring.len()];
  let midpoint = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
  let delta = sub(b, a);
  let segment_length = length(delta);
  if segment_length <= EPS {
    return midpoint;
  }
  let offset = SAMPLE_EPS.min(segment_length * 0.25);
  let sign = if area >= 0.0 { 1.0 } else { -1.0 };
  [
    midpoint[0] - delta[1] / segment_length * offset * sign,
    midpoint[1] + delta[0] / segment_length * offset * sign,
  ]
}

fn orient(mut ring: Ring, counter_clockwise: bool) -> Ring {
  let positive = ring_area(&ring) > 0.0;
  if positive != counter_clockwise {
    ring.reverse();
  }
  ring
}

#[cfg(test)]
mod tests {
  use super::*;

  fn square(cx: f64, cy: f64, half: f64) -> Ring {
    vec![
      [cx - half, cy - half],
      [cx + half, cy - half],
      [cx + half, cy + half],
      [cx - half, cy + half],
    ]
  }

  #[test]
  fn hole_before_outers_uses_outer_positions_not_ring_indices() {
    let hole = square(0.0, 0.0, 3.0);
    let first = square(0.0, 0.0, 10.0);
    let second = square(100.0, 0.0, 10.0);
    let result = group_rings(vec![hole, first, second]);
    assert_eq!(result.len(), 2);
    let with_hole = result
      .iter()
      .find(|polygon| point_in_ring(&polygon[0], [0.0, 0.0]))
      .expect("origin belongs to the first outer");
    assert_eq!(
      with_hole.len(),
      2,
      "hole must attach to its containing outer"
    );
    let other = result
      .iter()
      .find(|polygon| point_in_ring(&polygon[0], [100.0, 0.0]))
      .expect("second outer must survive");
    assert_eq!(other.len(), 1);
  }

  #[test]
  fn hole_owner_uses_an_interior_sample() {
    let outer = square(0.0, 0.0, 10.0);
    // hole 的 ring[0] 恰好落在 outer 的边上；内部样本仍必须判定为被包含。
    let hole = vec![[-10.0, 5.0], [-5.0, 5.0], [-5.0, 7.0], [-10.0, 7.0]];
    let result = group_rings(vec![outer, hole]);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].len(), 2);
  }
}
