/**
 * @entry 迁移报告的实测脚本：2000 图元 1080p、pointermove、Wasm 首屏与回退。
 * 用法：node scripts/perf-probe.mjs（自行启动/关闭 Vite dev server，不接触 daemon）。
 */
import {chromium} from '@playwright/test';
import {createServer} from 'vite';

const PORT = 18767;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SHAPE_COUNT = 2000;

const server = await createServer({
  configFile: 'vite.config.ts',
  root: process.cwd(),
  server: {port: PORT, strictPort: true, host: '127.0.0.1'}
});
await server.listen();

const webgpuBrowser = await chromium.launch({headless: true, args: ['--enable-unsafe-webgpu']});
const fallbackBrowser = await chromium.launch({headless: true});

const seedProject = async page => {
  await page.goto(ORIGIN, {waitUntil: 'domcontentloaded'});
  await page.evaluate(count => new Promise((resolve, reject) => {
    const open = indexedDB.open('sim-sketch', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('projects');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction('projects', 'readwrite');
      transaction.objectStore('projects').put({
        reference: null,
        layers: [{id: 'layer', name: '图层 1', opacity: 1}],
        marks: [],
        // 交互热路径按真实草图里的闭合填充图元压测，而不是只有描边的直线。
        shapes: Array.from({length: count}, (_, index) => ({
          id: `shape-${index}`,
          type: 'rect',
          layerId: 'layer',
          color: '#2e4f77',
          strokeWidth: 2.4,
          a: [20 + (index * 37) % 900, 20 + (index * 53) % 520],
          b: [32 + (index * 37) % 900, 28 + (index * 53) % 520]
        }))
      }, 'draft');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    };
  }), SHAPE_COUNT);
  await page.reload({waitUntil: 'domcontentloaded'});
  await page.waitForFunction(() => !document.querySelector('main')?.inert);
  await page.waitForFunction(() => {
    const renderer = document.querySelector('#board')?.getAttribute('data-renderer');
    return renderer === 'webgpu' || renderer === 'canvas2d' || renderer === 'svg';
  });
  await page.waitForFunction(() => document.querySelector('[data-shape-id]'));
  // 应用自身 WebGPU renderer 可能仍在编译 pipeline/补绘 Wasm 填充；
  // SwiftShader 繁忙时同一页面再请求 adapter 会排队，等稳定后再建压测 renderer。
  await page.waitForTimeout(1000);
};

/**
 * 同一页面只创建一个压测 renderer，顺序跑多个场景。
 * SwiftShader 下 device.destroy() 后立刻重新请求 adapter 会排队超时，因此不能为每个场景重建。
 * selected 表示选中图元数：选中的图元会产生半透明光晕+半透明填充+不透明描边，
 * 用于压测半透明 batch 在 stroke/fill 交替时的 draw 次数增长。
 */
const benchRenderer = async (page, backend, scenarios) => page.evaluate(async ({backend, count, scenarios}) => {
  const {buildScene} = await import('/scene.ts');
  const {createWebGpuRenderer} = await import('/webgpu-renderer.ts');
  const {createCanvas2dRenderer} = await import('/canvas2d-renderer.ts');
  const shapes = Array.from({length: count}, (_, index) => ({
    id: `shape-${index}`, type: 'rect', layerId: 'layer', color: '#2e4f77', strokeWidth: 2.4,
    a: [20 + (index * 37) % 900, 20 + (index * 53) % 520],
    b: [32 + (index * 37) % 900, 28 + (index * 53) % 520]
  }));
  const project = {
    reference: null,
    layers: [{id: 'layer', name: '图层 1', opacity: 1}],
    marks: [],
    shapes
  };
  const canvas = document.createElement('canvas');
  canvas.width = 1920;
  canvas.height = 1080;
  canvas.style.cssText = 'position:fixed;left:-2200px;top:0;width:1920px;height:1080px';
  document.body.append(canvas);
  const renderer = backend === 'webgpu'
    ? await createWebGpuRenderer(canvas)
    : createCanvas2dRenderer(canvas);
  renderer.resize(1920, 1080, 1);

  const summarize = values => {
    const sorted = [...values].sort((a, b) => a - b);
    const pick = ratio => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
    return {p50: pick(.5), p95: pick(.95), max: sorted.at(-1),
      mean: values.reduce((sum, value) => sum + value, 0) / values.length};
  };
  const measure = async ({selected, frames}) => {
    const scene = buildScene(project, {viewport: {x: 0, y: 0, width: 960, height: 540,
      cssWidth: 1920, cssHeight: 1080, dpr: 1, pixelsPerWorldUnit: 2}, revision: 1,
      selectedShapes: selected ? shapes.slice(0, selected).map(shape => shape.id) : []});
    for (let index = 0; index < 5; index++) renderer.draw(scene);
    await new Promise(resolve => setTimeout(resolve, 100));
    const intervals = [];
    const draws = [];
    let previous = performance.now();
    await new Promise(resolve => {
      let frame = 0;
      const tick = now => {
        intervals.push(now - previous);
        previous = now;
        const started = performance.now();
        renderer.draw(scene);
        draws.push(performance.now() - started);
        if (++frame < frames) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    return {frameIntervals: summarize(intervals.slice(1)), draws: summarize(draws), count, selected};
  };

  const results = [];
  for (const scenario of scenarios) results.push(await measure(scenario));
  renderer.destroy();
  canvas.remove();
  return results;
}, {backend, count: SHAPE_COUNT, scenarios});

const measurePointerMove = async page => page.evaluate(async () => {
  const board = document.querySelector('#board');
  if (!(board instanceof SVGSVGElement)) throw new Error('缺少 #board');
  // 合成事件没有真实指针，pointer capture 会抛 NotFoundError；只旁路 capture，
  // 其余 pointerdown/move/up 路径与真实交互一致。
  board.setPointerCapture = () => {};
  board.releasePointerCapture = () => {};
  const rect = board.getBoundingClientRect();
  const event = (type, x, y) => new PointerEvent(type, {bubbles: true, cancelable: true, pointerId: 1,
    pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
    clientX: rect.left + x, clientY: rect.top + y});
  document.querySelector('[data-tool="select"]').click();
  const target = document.querySelector('[data-shape-id]');
  if (!(target instanceof SVGGElement)) throw new Error('缺少可拖动的图元命中代理');
  const shapeBox = target.getBoundingClientRect();
  const startX = shapeBox.left + shapeBox.width / 2 - rect.left;
  const startY = shapeBox.top + shapeBox.height / 2 - rect.top;
  target.dispatchEvent(event('pointerdown', startX, startY));
  const durations = [];
  for (let index = 1; index <= 120; index++) {
    const x = startX + index * 3;
    const y = startY + index * 1.5;
    const started = performance.now();
    board.dispatchEvent(event('pointermove', x, y));
    durations.push(performance.now() - started);
  }
  board.dispatchEvent(event('pointerup', startX + 360, startY + 180));
  const sorted = [...durations].sort((a, b) => a - b);
  const pick = ratio => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
  return {p50: pick(.5), p95: pick(.95), max: sorted.at(-1),
    mean: durations.reduce((sum, value) => sum + value, 0) / durations.length,
    shapeNodes: document.querySelectorAll('[data-shape-id]').length};
});

const results = {};

// WebGPU：2000 图元 1080p 连续帧 + 真实 pointermove 路径。
{
  const context = await webgpuBrowser.newContext({viewport: {width: 1920, height: 1080},
    deviceScaleFactor: 1, serviceWorkers: 'block'});
  const page = await context.newPage();
  await seedProject(page);
  const backend = await page.locator('#board').getAttribute('data-renderer');
  results.webgpu = {backend};
  const [frame, selectedFrame] = await benchRenderer(page, 'webgpu',
    [{selected: 0, frames: 180}, {selected: SHAPE_COUNT, frames: 60}]);
  results.webgpu.frame = frame;
  results.webgpu.selectedFrame = selectedFrame;
  results.webgpu.pointermoveMs = await measurePointerMove(page);
  await context.close();
}

// 禁用 WebGPU：默认路径必须自动回退 Canvas2D，核心绘制可用。
{
  const context = await fallbackBrowser.newContext({viewport: {width: 1920, height: 1080},
    deviceScaleFactor: 1, serviceWorkers: 'block'});
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', {configurable: true, value: undefined});
  });
  await seedProject(page);
  const backend = await page.locator('#board').getAttribute('data-renderer');
  const box = await page.locator('#board').boundingBox();
  await page.locator('[data-tool="rect"]').click();
  await page.mouse.move(box.x + 300, box.y + 220);
  await page.mouse.down();
  await page.mouse.move(box.x + 520, box.y + 380, {steps: 6});
  await page.mouse.up();
  const drawn = await page.locator('[data-shape-id]').count();
  const [fallbackFrame] = await benchRenderer(page, 'canvas2d', [{selected: 0, frames: 180}]);
  results.fallback = {backend, drawnShapes: drawn, frame: fallbackFrame};
  await context.close();
}

// Wasm 延迟 1.5s：首屏与交互不应被阻塞。
{
  const context = await webgpuBrowser.newContext({viewport: {width: 1920, height: 1080},
    deviceScaleFactor: 1, serviceWorkers: 'block'});
  const page = await context.newPage();
  let wasmRequests = 0;
  let wasmStartedMs = null;
  const started = Date.now();
  await page.route('**/*.wasm', async route => {
    wasmRequests++;
    wasmStartedMs ??= Date.now() - started;
    await new Promise(resolve => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page.goto(ORIGIN, {waitUntil: 'domcontentloaded'});
  await page.waitForFunction(() => !document.querySelector('main')?.inert);
  const interactiveMs = Date.now() - started;
  const fcpMs = await page.evaluate(() => performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null);
  const box = await page.locator('#board').boundingBox();
  await page.locator('[data-tool="rect"]').click();
  await page.mouse.move(box.x + 260, box.y + 180);
  await page.mouse.down();
  await page.mouse.move(box.x + 380, box.y + 280, {steps: 5});
  await page.mouse.up();
  const drawnBeforeWasm = await page.locator('[data-shape-id]').count();
  const drawnMs = Date.now() - started;
  await page.waitForTimeout(2500);
  results.wasmFirstPaint = {fcpMs, interactiveMs, drawnBeforeWasm, drawnMs, wasmRequests, wasmStartedMs};
  await context.close();
}

await webgpuBrowser.close();
await fallbackBrowser.close();
await server.close();

console.log(JSON.stringify(results, null, 2));
