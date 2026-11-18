import {markGeometry, paper, referenceCanvas} from './board.js';

function rgb(color) {
  const value = Number.parseInt(color.slice(1), 16);
  return [value >> 16, (value >> 8) & 255, value & 255];
}

const shader = `
const boardSize = vec2f(960, 600);
@group(1) @binding(0) var<uniform> viewport: vec4f;

fn corner(index: u32) -> vec2f {
  return vec2f(f32(index & 1u), f32(index >> 1u));
}

fn clip(uv: vec2f) -> vec4f {
  return vec4f(uv * vec2f(2, -2) + vec2f(-1, 1), 0, 1);
}

struct BackVertex {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@group(0) @binding(0) var referenceSampler: sampler;
@group(0) @binding(1) var referenceImage: texture_2d<f32>;

@vertex fn backVertex(@builtin(vertex_index) index: u32) -> BackVertex {
  let uv = corner(index);
  return BackVertex(clip(uv), uv);
}

@fragment fn backFragment(input: BackVertex) -> @location(0) vec4f {
  let p = viewport.xy + input.uv * viewport.zw;
  let offset = p - vec2f(1.4);
  let tile = offset - floor(offset / 24.0 + 0.5) * 24.0;
  let distance = length(tile);
  let aa = max(length(fwidth(p)) * 0.5, 0.4);
  let dot = 1.0 - smoothstep(1.25 - aa, 1.25 + aa, distance);
  let grid = mix(vec3f(${rgb(paper.background)}), vec3f(${rgb(paper.dot)}), dot) / 255.0;
  let referenceUv = p / boardSize;
  let sampled = textureSample(referenceImage, referenceSampler, referenceUv);
  let inside = all(referenceUv >= vec2f(0)) && all(referenceUv <= vec2f(1));
  let reference = select(vec4f(0), sampled, inside);
  return vec4f(reference.rgb + grid * (1.0 - reference.a), 1);
}

struct MarkVertex {
  @builtin(position) position: vec4f,
  @location(0) point: vec2f,
  @location(1) @interpolate(flat) geometry: vec4f,
  @location(2) @interpolate(flat) style: vec4f,
  @location(3) @interpolate(flat) color: vec3f,
}

@vertex fn markVertex(
  @builtin(vertex_index) index: u32,
  @location(0) geometry: vec4f,
  @location(1) style: vec4f,
  @location(2) color: vec3f
) -> MarkVertex {
  let a = geometry.xy;
  let b = geometry.zw;
  let ellipse = style.y > 0.5;
  let margin = vec2f(style.x * 0.5 + 4.0);
  let lower = select(min(a, b), a - b, ellipse) - margin;
  let upper = select(max(a, b), a + b, ellipse) + margin;
  let point = mix(lower, upper, corner(index));
  return MarkVertex(clip((point - viewport.xy) / viewport.zw), point, geometry, style, color);
}

@fragment fn markFragment(input: MarkVertex) -> @location(0) vec4f {
  let a = input.geometry.xy;
  let b = input.geometry.zw;
  let delta = input.point - a;
  let segment = b - a;
  let along = clamp(dot(delta, segment) / max(dot(segment, segment), 0.001), 0.0, 1.0);
  let distanceToLine = length(delta - segment * along);
  let radii = max(b, vec2f(3));
  let scaled = delta / radii;
  let g = length(scaled);
  let normal = length(scaled / radii) / max(g, 0.001);
  let ellipseDistance = (g - 1.0) / max(normal, 0.0001);
  let ellipse = input.style.y > 0.5;
  let distanceToStroke = select(distanceToLine, abs(ellipseDistance), ellipse);
  let halfWidth = input.style.x * 0.5;
  let aa = max(fwidth(distanceToStroke) * 0.5, 0.35);
  var stroke = 1.0 - smoothstep(halfWidth - aa, halfWidth + aa, distanceToStroke);
  if input.style.w > 0.5 {
    let angle = atan2(scaled.y + 0.00001, scaled.x);
    let arc = (angle + 3.14159265) * sqrt((radii.x * radii.x + radii.y * radii.y) * 0.5);
    stroke *= select(0.0, 1.0, fract(arc / 14.0) < 9.0 / 14.0);
  }
  let fill = input.style.z * (1.0 - smoothstep(-aa, aa, ellipseDistance));
  return vec4f(input.color, stroke + fill * (1.0 - stroke));
}
`;

const instanceFloats = 11;

function packMarks(marks, temporary, selection) {
  const instances = [];
  const pack = (mark, selected) => {
    const style = markGeometry(mark, selected);
    if (!style.width) return;
    const color = rgb(style.color).map(value => value / 255);
    if (style.center) {
      instances.push(...style.center, ...style.radii, style.width, 1, style.fill, Number(style.dashed), ...color);
      return;
    }
    const {points} = style;
    if (mark.shape === 'arrow') {
      const [a, b, left, , right] = points;
      for (const [from, to] of [[a, b], [b, left], [b, right]]) {
        instances.push(...from, ...to, style.width, 0, 0, 0, ...color);
      }
      return;
    }
    for (let index = 0; index < Math.max(1, points.length - 1); index++) {
      const from = points[index];
      const to = points[index + 1] ?? from;
      instances.push(...from, ...to, style.width, 0, 0, 0, ...color);
    }
  };
  for (const mark of marks) pack(mark, mark.id === selection);
  if (temporary) pack(temporary, false);
  return new Float32Array(instances);
}

export async function createGpuBoard(canvas, onStatus) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const context = canvas.getContext('webgpu');
  if (!context) {
    device.destroy();
    return null;
  }
  const format = navigator.gpu.getPreferredCanvasFormat();
  const module = device.createShaderModule({code: shader});
  const blend = {
    color: {srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha'},
    alpha: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha'}
  };
  let background;
  let marksPipeline;
  try {
    [background, marksPipeline] = await Promise.all([
      device.createRenderPipelineAsync({layout: 'auto', primitive: {topology: 'triangle-strip'},
        vertex: {module, entryPoint: 'backVertex'}, fragment: {module, entryPoint: 'backFragment', targets: [{format}]}}),
      device.createRenderPipelineAsync({layout: 'auto', primitive: {topology: 'triangle-strip'},
        vertex: {module, entryPoint: 'markVertex', buffers: [{
          arrayStride: instanceFloats * 4, stepMode: 'instance', attributes: [
            {shaderLocation: 0, offset: 0, format: 'float32x4'},
            {shaderLocation: 1, offset: 16, format: 'float32x4'},
            {shaderLocation: 2, offset: 32, format: 'float32x3'}
          ]
        }]}, fragment: {module, entryPoint: 'markFragment', targets: [{format, blend}]}})
    ]);
    context.configure({device, format});
  } catch (error) {
    device.destroy();
    throw error;
  }

  let frame = 0;
  let pending;
  let disposed = false;
  let picture;
  let requestedReference;
  let texture;
  let buffer;
  const viewBuffer = device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
  const backgroundView = device.createBindGroup({layout: background.getBindGroupLayout(1), entries: [{binding: 0, resource: {buffer: viewBuffer}}]});
  const marksView = device.createBindGroup({layout: marksPipeline.getBindGroupLayout(1), entries: [{binding: 0, resource: {buffer: viewBuffer}}]});
  const sampler = device.createSampler({magFilter: 'linear', minFilter: 'linear'});
  const observer = new ResizeObserver(schedule);

  function stop(error) {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    texture?.destroy();
    buffer?.destroy();
    viewBuffer.destroy();
    context.unconfigure();
    device.destroy();
    onStatus('SVG 兼容模式');
    console.warn('WebGPU 画板已回退至 SVG。', error);
  }

  device.addEventListener('uncapturederror', event => {
    event.preventDefault();
    stop(event.error);
  });
  device.lost.then(info => stop(info.message || info.reason));
  observer.observe(canvas);

  function schedule() {
    if (!frame && !disposed) frame = requestAnimationFrame(render);
  }

  function render() {
    frame = 0;
    if (!pending || !picture || pending.project.reference !== picture.reference) return;
    try {
      const {width, height} = canvas.getBoundingClientRect();
      const max = device.limits.maxTextureDimension2D;
      const scale = Math.min(devicePixelRatio, max / Math.max(width, height));
      const frameWidth = Math.max(1, Math.round(width * scale));
      const frameHeight = Math.max(1, Math.round(height * scale));
      if (canvas.width !== frameWidth) canvas.width = frameWidth;
      if (canvas.height !== frameHeight) canvas.height = frameHeight;
      const view = canvas.nextElementSibling.viewBox.baseVal;
      device.queue.writeBuffer(viewBuffer, 0, new Float32Array([view.x, view.y, view.width, view.height]));
      const instances = packMarks(pending.project.marks, pending.temporary, pending.selected);
      if (instances.length) {
        if (!buffer || buffer.size < instances.byteLength) {
          buffer?.destroy();
          buffer = device.createBuffer({size: Math.max(4096, 2 ** Math.ceil(Math.log2(instances.byteLength))),
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST});
        }
        device.queue.writeBuffer(buffer, 0, instances);
      }
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({colorAttachments: [{
        view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1]
      }]});
      pass.setPipeline(background);
      pass.setBindGroup(0, picture.bindGroup);
      pass.setBindGroup(1, backgroundView);
      pass.draw(4);
      if (instances.length) {
        pass.setPipeline(marksPipeline);
        pass.setBindGroup(1, marksView);
        pass.setVertexBuffer(0, buffer);
        pass.draw(4, instances.length / instanceFloats);
      }
      pass.end();
      device.queue.submit([encoder.finish()]);
      onStatus('WebGPU');
    } catch (error) {
      stop(error);
    }
  }

  async function loadReference(reference) {
    try {
      const source = await referenceCanvas(reference);
      if (disposed || requestedReference !== reference) return;
      const size = [source.width, source.height];
      const nextTexture = device.createTexture({size, format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT});
      texture?.destroy();
      texture = nextTexture;
      device.queue.copyExternalImageToTexture({source}, {texture, premultipliedAlpha: true}, size);
      picture = {reference, bindGroup: device.createBindGroup({layout: background.getBindGroupLayout(0), entries: [
        {binding: 0, resource: sampler}, {binding: 1, resource: texture.createView()}
      ]})};
      schedule();
    } catch (error) {
      if (requestedReference === reference) stop(error);
    }
  }

  return function paint(project, temporary, selected) {
    if (disposed) return;
    pending = {project, temporary, selected};
    if (requestedReference !== project.reference) {
      requestedReference = project.reference;
      onStatus('WebGPU 准备中');
      if (picture?.reference !== project.reference) void loadReference(project.reference);
    }
    schedule();
  };
}
