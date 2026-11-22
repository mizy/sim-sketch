export interface GpuPipelines {
  grid: GPURenderPipeline;
  /** 不透明内容写深度，靠 painter depth 解决跨 fill/stroke 的先后。 */
  strokeOpaque: GPURenderPipeline;
  fillOpaque: GPURenderPipeline;
  /** 半透明内容按 painter 顺序绘制，但不能写深度，否则会遮住更早的填充。 */
  strokeTranslucent: GPURenderPipeline;
  fillTranslucent: GPURenderPipeline;
  reference: GPURenderPipeline;
  composite: GPURenderPipeline;
}

const gridShader = `
struct FrameUniform {
  viewport: vec4f,
  grid: vec4f,
  background: vec4f,
  dot: vec4f,
}

@group(0) @binding(0) var<uniform> frame: FrameUniform;

fn corner(index: u32) -> vec2f {
  return vec2f(f32(index & 1u), f32(index >> 1u));
}

struct GridOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn gridVertex(@builtin(vertex_index) index: u32) -> GridOut {
  let uv = corner(index);
  return GridOut(vec4f(uv * vec2f(2, -2) + vec2f(-1, 1), 0, 1), uv);
}

@fragment fn gridFragment(input: GridOut) -> @location(0) vec4f {
  let spacing = max(frame.grid.x, 1.0);
  let radius = max(frame.grid.y, 0.1);
  let p = frame.viewport.xy + input.uv * frame.viewport.zw;
  let offset = p - frame.grid.zw;
  let tile = offset - floor(offset / spacing + 0.5) * spacing;
  let distance = length(tile);
  let aa = max(length(fwidth(p)) * 0.5, 0.4);
  let dot = 1.0 - smoothstep(radius - aa, radius + aa, distance);
  let grid = mix(frame.background.rgb, frame.dot.rgb, dot);
  return vec4f(grid, 1);
}
`;

const strokeShader = `
@group(0) @binding(0) var<uniform> viewport: vec4f;

fn corner(index: u32) -> vec2f {
  return vec2f(f32(index & 1u), f32(index >> 1u));
}

fn clip(point: vec2f) -> vec4f {
  let uv = (point - viewport.xy) / viewport.zw;
  return vec4f(uv * vec2f(2, -2) + vec2f(-1, 1), 0, 1);
}

struct StrokeOut {
  @builtin(position) position: vec4f,
  @location(0) point: vec2f,
  @location(1) @interpolate(flat) geom: vec4f,
  @location(2) @interpolate(flat) style: vec4f,
  @location(3) @interpolate(flat) color: vec4f,
  @location(4) @interpolate(flat) dash: vec2f,
  @location(5) @interpolate(flat) depth: f32,
}

@vertex fn strokeVertex(
  @builtin(vertex_index) index: u32,
  @location(0) geom: vec4f,
  @location(1) style: vec4f,
  @location(2) color: vec4f,
  @location(3) dash: vec2f,
  @location(4) depth: f32
) -> StrokeOut {
  let ellipse = style.y > 0.5;
  let margin = vec2f(style.x * 0.5 + 2.0);
  let lower = select(min(geom.xy, geom.zw), geom.xy - geom.zw, ellipse) - margin;
  let upper = select(max(geom.xy, geom.zw), geom.xy + geom.zw, ellipse) + margin;
  let point = mix(lower, upper, corner(index));
  var output = clip(point);
  output.z = depth;
  return StrokeOut(output, point, geom, style, color, dash, depth);
}

@fragment fn strokeFragment(input: StrokeOut) -> @location(0) vec4f {
  let a = input.geom.xy;
  let b = input.geom.zw;
  let delta = input.point - a;
  let segment = b - a;
  let along = clamp(dot(delta, segment) / max(dot(segment, segment), 0.0001), 0.0, 1.0);
  let distanceToLine = length(delta - segment * along);

  let radii = max(b, vec2f(0.1));
  let scaled = delta / radii;
  let g = length(scaled);
  let normal = length(scaled / radii) / max(g, 0.001);
  let ellipseDistance = (g - 1.0) / max(normal, 0.0001);
  let ellipse = input.style.y > 0.5;
  let distanceToStroke = select(distanceToLine, abs(ellipseDistance), ellipse);

  let halfWidth = input.style.x * 0.5;
  let aa = max(fwidth(distanceToStroke) * 0.5, 0.35);
  var stroke = 1.0 - smoothstep(halfWidth - aa, halfWidth + aa, distanceToStroke);
  if input.style.w > 0.5 && input.dash.x > 0.0 {
    var arc = along * length(segment);
    if ellipse {
      let angle = atan2(scaled.y + 0.00001, scaled.x);
      arc = (angle + 3.14159265) * sqrt((radii.x * radii.x + radii.y * radii.y) * 0.5);
    }
    let period = input.dash.x + input.dash.y;
    stroke *= select(0.0, 1.0, fract(arc / period) * period < input.dash.x);
  }
  let fill = select(input.style.z * (1.0 - smoothstep(-aa, aa, ellipseDistance)), 0.0, !ellipse);
  let alpha = stroke * input.color.a + fill * (1.0 - stroke);
  // 描边实例的四边形覆盖整个 AABB；透明片元必须 discard，否则会写深度并遮住
  // 后续/更早的填充与半透明图元。
  if (alpha < 0.002) { discard; }
  return vec4f(input.color.rgb * alpha, alpha);
}
`;

const fillShader = `
@group(0) @binding(0) var<uniform> viewport: vec4f;

struct FillOut {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) color: vec4f,
}

@vertex fn fillVertex(
  @location(0) point: vec2f,
  @location(1) color: vec4f,
  @location(2) depth: f32
) -> FillOut {
  let uv = (point - viewport.xy) / viewport.zw;
  return FillOut(vec4f(uv * vec2f(2, -2) + vec2f(-1, 1), depth, 1), color);
}

@fragment fn fillFragment(input: FillOut) -> @location(0) vec4f {
  // 透明度为 0 的填充不应占用深度，避免遮住之后的半透明图元。
  if (input.color.a < 0.002) { discard; }
  return input.color;
}
`;

const referenceShader = `
@group(0) @binding(0) var<uniform> viewport: vec4f;
@group(0) @binding(1) var referenceSampler: sampler;
@group(0) @binding(2) var referenceImage: texture_2d<f32>;

fn corner(index: u32) -> vec2f {
  return vec2f(f32(index & 1u), f32(index >> 1u));
}

struct ReferenceOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn referenceVertex(@builtin(vertex_index) index: u32) -> ReferenceOut {
  let uv = corner(index);
  let point = uv * vec2f(960, 600);
  let clip = (point - viewport.xy) / viewport.zw;
  return ReferenceOut(vec4f(clip * vec2f(2, -2) + vec2f(-1, 1), 0, 1), uv);
}

@fragment fn referenceFragment(input: ReferenceOut) -> @location(0) vec4f {
  return textureSample(referenceImage, referenceSampler, input.uv);
}
`;

const compositeShader = `
@group(0) @binding(0) var compositeSampler: sampler;
@group(0) @binding(1) var compositeImage: texture_2d<f32>;

fn corner(index: u32) -> vec2f {
  return vec2f(f32(index & 1u), f32(index >> 1u));
}

struct CompositeOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) opacity: f32,
}

@vertex fn compositeVertex(
  @builtin(vertex_index) index: u32,
  @location(0) opacity: vec4f
) -> CompositeOut {
  let uv = corner(index);
  return CompositeOut(vec4f(uv * vec2f(2, -2) + vec2f(-1, 1), 0, 1), uv, opacity.x);
}

@fragment fn compositeFragment(input: CompositeOut) -> @location(0) vec4f {
  return textureSample(compositeImage, compositeSampler, input.uv) * input.opacity;
}
`;

const premultiplied: GPUBlendState = {
  color: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add'},
  alpha: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add'}
};

function depthState(write: boolean): GPUDepthStencilState {
  return {format: 'depth24plus', depthWriteEnabled: write, depthCompare: 'less'};
}

export function createPipelines(device: GPUDevice, format: GPUTextureFormat): GpuPipelines {
  const grid = device.createShaderModule({code: gridShader});
  const stroke = device.createShaderModule({code: strokeShader});
  const fill = device.createShaderModule({code: fillShader});
  const reference = device.createShaderModule({code: referenceShader});
  const composite = device.createShaderModule({code: compositeShader});

  const strokePipeline = (writeDepth: boolean): GPURenderPipeline => device.createRenderPipeline({
    layout: 'auto',
    vertex: {module: stroke, entryPoint: 'strokeVertex', buffers: [{
      arrayStride: 15 * 4,
      stepMode: 'instance',
      attributes: [
        {shaderLocation: 0, offset: 0, format: 'float32x4'},
        {shaderLocation: 1, offset: 16, format: 'float32x4'},
        {shaderLocation: 2, offset: 32, format: 'float32x4'},
        {shaderLocation: 3, offset: 48, format: 'float32x2'},
        {shaderLocation: 4, offset: 56, format: 'float32'}
      ]
    }]},
    fragment: {module: stroke, entryPoint: 'strokeFragment', targets: [{format, blend: premultiplied}]},
    primitive: {topology: 'triangle-strip'},
    depthStencil: depthState(writeDepth)
  });
  const fillPipeline = (writeDepth: boolean): GPURenderPipeline => device.createRenderPipeline({
    layout: 'auto',
    vertex: {module: fill, entryPoint: 'fillVertex', buffers: [{
      arrayStride: 7 * 4,
      stepMode: 'vertex',
      attributes: [
        {shaderLocation: 0, offset: 0, format: 'float32x2'},
        {shaderLocation: 1, offset: 8, format: 'float32x4'},
        {shaderLocation: 2, offset: 24, format: 'float32'}
      ]
    }]},
    fragment: {module: fill, entryPoint: 'fillFragment', targets: [{format, blend: premultiplied}]},
    primitive: {topology: 'triangle-list'},
    depthStencil: depthState(writeDepth)
  });

  return {
    grid: device.createRenderPipeline({
      layout: 'auto',
      vertex: {module: grid, entryPoint: 'gridVertex'},
      fragment: {module: grid, entryPoint: 'gridFragment', targets: [{format}]},
      primitive: {topology: 'triangle-strip'}
    }),
    strokeOpaque: strokePipeline(true),
    fillOpaque: fillPipeline(true),
    strokeTranslucent: strokePipeline(false),
    fillTranslucent: fillPipeline(false),
    reference: device.createRenderPipeline({
      layout: 'auto',
      vertex: {module: reference, entryPoint: 'referenceVertex'},
      fragment: {module: reference, entryPoint: 'referenceFragment', targets: [{format, blend: premultiplied}]},
      primitive: {topology: 'triangle-strip'},
      // 参考图绘制在图层最底层，不参与深度写入；但必须声明与 layer pass 相同的深度附件状态。
      depthStencil: {format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always'}
    }),
    composite: device.createRenderPipeline({
      layout: 'auto',
      vertex: {module: composite, entryPoint: 'compositeVertex', buffers: [{
        arrayStride: 4 * 4, stepMode: 'instance', attributes: [{shaderLocation: 0, offset: 0, format: 'float32x4'}]
      }]},
      fragment: {module: composite, entryPoint: 'compositeFragment', targets: [{format, blend: premultiplied}]},
      primitive: {topology: 'triangle-strip'}
    })
  };
}
