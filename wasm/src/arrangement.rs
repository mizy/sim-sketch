//! Planar arrangement: split every input edge at all intersections, then keep
//! the undirected edges that separate result-inside from result-outside.

use std::collections::BTreeMap;

use crate::boolean::Operation;
use crate::math::{
  cross, distance, length, lerp, point_key, project, sub, Key, MultiPolygon, Point, EPS, SAMPLE_EPS,
};

#[derive(Clone)]
pub(crate) struct Segment {
  a: Point,
  b: Point,
  cuts: Vec<(f64, Point)>,
}

pub(crate) struct Arrangement {
  pub(crate) nodes: Vec<Point>,
  pub(crate) edges: Vec<(usize, usize)>,
}

pub(crate) fn collect_segments(shapes: &MultiPolygon) -> Vec<Segment> {
  let mut segments = Vec::new();
  for polygon in shapes {
    for ring in polygon {
      if ring.len() < 2 {
        continue;
      }
      for index in 0..ring.len() {
        let a = ring[index];
        let b = ring[(index + 1) % ring.len()];
        if distance(a, b) > EPS {
          segments.push(Segment {
            a,
            b,
            cuts: vec![(0.0, a), (1.0, b)],
          });
        }
      }
    }
  }
  segments
}

pub(crate) fn split_segments(segments: &mut [Segment]) {
  for i in 0..segments.len() {
    for j in (i + 1)..segments.len() {
      intersect_pair(segments, i, j);
    }
  }
}

fn intersect_pair(segments: &mut [Segment], i: usize, j: usize) {
  let a = segments[i].a;
  let b = segments[i].b;
  let c = segments[j].a;
  let d = segments[j].b;
  let r = sub(b, a);
  let s = sub(d, c);
  let r_len = length(r);
  let s_len = length(s);
  if r_len <= EPS || s_len <= EPS {
    return;
  }

  let denominator = cross(r, s);
  if denominator.abs() <= EPS * r_len * s_len {
    let offset = sub(c, a);
    if cross(offset, r).abs() > EPS * r_len * (1.0 + length(offset)) {
      return;
    }
    // Collinear overlap: split both segments at the overlap endpoints.
    let axis = if r[0].abs() >= r[1].abs() { 0 } else { 1 };
    if r[axis].abs() <= EPS {
      return;
    }
    let t0 = (c[axis] - a[axis]) / r[axis];
    let t1 = (d[axis] - a[axis]) / r[axis];
    let lower = t0.min(t1).max(0.0);
    let upper = t0.max(t1).min(1.0);
    if lower > upper + EPS {
      return;
    }
    let p0 = lerp(a, b, lower);
    let p1 = lerp(a, b, upper);
    push_cut(segments, i, lower, p0);
    push_cut(segments, i, upper, p1);
    push_cut(segments, j, project(c, d, p0), p0);
    push_cut(segments, j, project(c, d, p1), p1);
    return;
  }

  let t = cross(sub(c, a), s) / denominator;
  let u = cross(sub(c, a), r) / denominator;
  if t < -EPS || t > 1.0 + EPS || u < -EPS || u > 1.0 + EPS {
    return;
  }
  let t = t.clamp(0.0, 1.0);
  let u = u.clamp(0.0, 1.0);
  let point = lerp(a, b, t);
  push_cut(segments, i, t, point);
  push_cut(segments, j, u, point);
}

fn push_cut(segments: &mut [Segment], index: usize, t: f64, point: Point) {
  if !t.is_finite() {
    return;
  }
  let cuts = &mut segments[index].cuts;
  if cuts
    .iter()
    .any(|(existing, _)| (*existing - t).abs() <= EPS)
  {
    return;
  }
  cuts.push((t, point));
}

pub(crate) fn build_arrangement(segments: &[Segment]) -> Arrangement {
  let mut nodes: Vec<Point> = Vec::new();
  let mut node_index: BTreeMap<Key, usize> = BTreeMap::new();
  let mut edge_keys: BTreeMap<(usize, usize), ()> = BTreeMap::new();

  for segment in segments {
    let mut cuts = segment.cuts.clone();
    cuts.sort_by(|left, right| {
      left
        .0
        .partial_cmp(&right.0)
        .unwrap_or(std::cmp::Ordering::Equal)
    });
    for pair in cuts.windows(2) {
      let (t0, p0) = pair[0];
      let (t1, p1) = pair[1];
      if t1 - t0 <= EPS {
        continue;
      }
      let key0 = point_key(p0);
      let key1 = point_key(p1);
      if key0 == key1 {
        continue;
      }
      let i0 = register(p0, &mut nodes, &mut node_index);
      let i1 = register(p1, &mut nodes, &mut node_index);
      let edge = if i0 < i1 { (i0, i1) } else { (i1, i0) };
      edge_keys.insert(edge, ());
    }
  }

  Arrangement {
    nodes,
    edges: edge_keys.into_keys().collect(),
  }
}

fn register(point: Point, nodes: &mut Vec<Point>, node_index: &mut BTreeMap<Key, usize>) -> usize {
  let key = point_key(point);
  if let Some(&index) = node_index.get(&key) {
    return index;
  }
  let index = nodes.len();
  nodes.push(point);
  node_index.insert(key, index);
  index
}

pub(crate) fn select_edges(
  op: Operation,
  a: &MultiPolygon,
  b: &MultiPolygon,
  arrangement: &Arrangement,
) -> Vec<(usize, usize)> {
  let mut directed = Vec::new();
  for &(i, j) in &arrangement.edges {
    let a_point = arrangement.nodes[i];
    let b_point = arrangement.nodes[j];
    let delta = sub(b_point, a_point);
    let segment_length = length(delta);
    if segment_length <= EPS {
      continue;
    }
    let midpoint = [
      (a_point[0] + b_point[0]) * 0.5,
      (a_point[1] + b_point[1]) * 0.5,
    ];
    let offset = SAMPLE_EPS.min(segment_length * 0.25);
    let normal = [
      -delta[1] / segment_length * offset,
      delta[0] / segment_length * offset,
    ];
    let left = [midpoint[0] + normal[0], midpoint[1] + normal[1]];
    let right = [midpoint[0] - normal[0], midpoint[1] - normal[1]];
    let inside_left = op.contains(contains(a, left), contains(b, left));
    let inside_right = op.contains(contains(a, right), contains(b, right));
    if inside_left == inside_right {
      continue;
    }
    if inside_left {
      directed.push((i, j));
    } else {
      directed.push((j, i));
    }
  }
  directed
}

fn contains(shapes: &MultiPolygon, point: Point) -> bool {
  let mut inside = false;
  for polygon in shapes {
    for ring in polygon {
      if ring.len() < 2 {
        continue;
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
    }
  }
  inside
}
