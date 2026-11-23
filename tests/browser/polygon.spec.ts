import {readFileSync, statSync} from 'node:fs';
import {expect, test} from '@playwright/test';
import type {Download, Page} from '@playwright/test';

interface ScreenPoint {
  x: number;
  y: number;
}

async function triangleSites(page: Page): Promise<{points: ScreenPoint[]; centroid: ScreenPoint}> {
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');
  // 左下角调色板左侧的空白区域：避开示例标注与随工具增宽的底部调色板。
  const points = [
    {x: box.x + box.width * .08, y: box.y + box.height * .70},
    {x: box.x + box.width * .18, y: box.y + box.height * .76},
    {x: box.x + box.width * .12, y: box.y + box.height * .90}
  ];
  const centroid = {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length
  };
  return {points, centroid};
}

async function startPolygon(page: Page, renderer: 'canvas2d' | 'svg' = 'canvas2d'): Promise<void> {
  await page.goto(`/?renderer=${renderer}`);
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#board')).toHaveAttribute('data-renderer', renderer);
  await page.locator('[data-tool="polygon"]').click();
}

async function drawTriangle(page: Page, close: 'first' | 'enter' | 'double'): Promise<ScreenPoint[]> {
  const {points} = await triangleSites(page);
  await page.mouse.click(points[0].x, points[0].y);
  await page.mouse.click(points[1].x, points[1].y);
  if (close === 'first') {
    await page.mouse.click(points[2].x, points[2].y);
    await page.mouse.click(points[0].x, points[0].y);
  } else if (close === 'enter') {
    await page.mouse.click(points[2].x, points[2].y);
    await page.keyboard.press('Enter');
  } else {
    await page.mouse.dblclick(points[2].x, points[2].y);
  }
  return points;
}

async function downloadFromMenu(page: Page, button: string): Promise<Download> {
  await page.locator('.menu summary').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator(button).click()
  ]);
  return download;
}

test('draws a triangle by clicking back to its first vertex, then moves and persists it', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await startPolygon(page);
  const [first, , third] = await drawTriangle(page, 'first');

  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
  await expect(page.locator('#shape-count')).toHaveText('已选 1 个图形');
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');

  await page.locator('[data-tool="select"]').click();
  const {centroid} = await triangleSites(page);
  const before = await page.locator('[data-shape-id] path').first().getAttribute('d');
  expect(before).toContain('Z');

  await page.mouse.move(centroid.x, centroid.y);
  await page.mouse.down();
  await page.mouse.move(centroid.x + 40, centroid.y + 24, {steps: 5});
  await page.mouse.up();
  await expect(page.locator('#shape-count')).toHaveText('已选 1 个图形');
  const moved = await page.locator('[data-shape-id] path').first().getAttribute('d');
  expect(moved).not.toBe(before);
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');

  await page.locator('#undo').click();
  await expect(page.locator('[data-shape-id] path').first()).toHaveAttribute('d', before!);
  await page.locator('#redo').click();
  await expect(page.locator('[data-shape-id] path').first()).toHaveAttribute('d', moved!);

  // 顶点坐标与包围盒都经过一次真实鼠标移动，保证不是只改了 DOM 高亮。
  expect(first.y).toBeLessThan(third.y);
  await page.reload();
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('closes with Enter and rejects a draft with fewer than three vertices', async ({page}) => {
  await startPolygon(page);
  const {points} = await triangleSites(page);
  await page.mouse.click(points[0].x, points[0].y);
  await page.mouse.click(points[1].x, points[1].y);
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-shape-id]')).toHaveCount(0);
  await expect(page.locator('#notice')).toHaveText('多边形至少需要 3 个顶点。');

  await page.mouse.click(points[0].x, points[0].y);
  await page.mouse.click(points[1].x, points[1].y);
  await page.mouse.click(points[2].x, points[2].y);
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
  await expect(page.locator('#notice')).toHaveText('');
});

test('double-click closes, Escape discards, and duplicate vertices are refused', async ({page}) => {
  await startPolygon(page);
  const {points} = await triangleSites(page);
  await page.mouse.click(points[0].x, points[0].y);
  await page.mouse.click(points[0].x, points[0].y);
  await expect(page.locator('#notice')).toHaveText('该位置已有顶点，请换一个位置。');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-shape-id]')).toHaveCount(0);
  await expect(page.locator('#notice')).toHaveText('已取消未闭合的多边形。');

  await page.mouse.click(points[0].x, points[0].y);
  await page.mouse.click(points[1].x, points[1].y);
  await page.mouse.dblclick(points[2].x, points[2].y);
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
});

test('shows temporary edges and snap markers while the polygon is open', async ({page}) => {
  await startPolygon(page, 'svg');
  const {points} = await triangleSites(page);
  await page.mouse.click(points[0].x, points[0].y);
  await page.mouse.move(points[1].x, points[1].y, {steps: 3});

  // 草稿还没提交：没有命中代理，但几何层已有临时折线，顶点/指针通过 RenderScene.snap 显示。
  await expect(page.locator('[data-shape-id]')).toHaveCount(0);
  expect(await page.locator('#board [data-render-geometry] g[data-layer-id] path').evaluateAll(nodes =>
    nodes.some(node => /^M[^Z]+$/.test(node.getAttribute('d') ?? '')))).toBe(true);
  expect(await page.locator('#board [data-render-geometry] > g circle').count()).toBeGreaterThan(0);
});

test('polygon renders through the SVG backend and exports SVG, PNG and JSON', async ({page}) => {
  await startPolygon(page, 'svg');
  await drawTriangle(page, 'enter');
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
  // SVG 后端保留真实几何层；命中代理与几何使用同一个 shapePath。
  await expect(page.locator('[data-shape-id] path').first()).toHaveAttribute('d', /Z$/);
  expect(await page.locator('#board [data-render-geometry] path').evaluateAll(nodes =>
    nodes.some(node => node.getAttribute('d')?.endsWith('Z')))).toBe(true);

  const svgDownload = await downloadFromMenu(page, '#export-svg');
  expect(svgDownload.suggestedFilename()).toBe('sim-sketch.svg');
  const svg = readFileSync(await svgDownload.path(), 'utf8');
  expect(svg).toContain('data-shape-id');
  expect(svg).toMatch(/<path[^>]+d="M[^"]+Z"/);

  const pngDownload = await downloadFromMenu(page, '#export-png');
  expect(pngDownload.suggestedFilename()).toBe('sim-sketch.png');
  expect(statSync(await pngDownload.path()).size).toBeGreaterThan(1000);

  const jsonDownload = await downloadFromMenu(page, '#export-json');
  expect(jsonDownload.suggestedFilename()).toBe('sim-sketch.json');
  const exported = JSON.parse(readFileSync(await jsonDownload.path(), 'utf8'));
  expect(exported.version).toBe(1);
  expect(exported.shapes).toHaveLength(1);
  expect(exported.shapes[0].type).toBe('path');
  expect(exported.shapes[0].polygons).toHaveLength(1);
  expect(exported.shapes[0].polygons[0][0]).toHaveLength(3);
  expect(exported.shapes[0].origin).toHaveLength(2);
});
