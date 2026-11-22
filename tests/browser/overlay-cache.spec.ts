import {expect, test} from '@playwright/test';

test('mark overlay reuses 2000 cached nodes between paints', async ({page}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const moduleUrl: string = '/board.ts';
    const {drawOverlay} = await import(/* @vite-ignore */ moduleUrl);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    document.body.append(svg);
    const layer = {id: 'layer', name: '图层 1', opacity: 1};
    const marks = Array.from({length: 2000}, (_, index) => ({
      id: `mark-${index}`, shape: 'text', kind: 'note', label: `标注 ${index}`,
      value: null, unit: '', direction: '', question: '', confirmed: false,
      source: 'manual', layerId: layer.id, a: [index % 100 * 4, Math.floor(index / 100) * 4]
    }));
    const project = {reference: null, layers: [layer], marks, shapes: []};
    drawOverlay(svg, project as never, {hitProxies: false});
    const first = [...svg.querySelectorAll('[data-mark-overlay] [data-id]')];
    drawOverlay(svg, project as never, {hitProxies: false});
    const second = [...svg.querySelectorAll('[data-mark-overlay] [data-id]')];
    svg.remove();
    return {count: second.length, reused: first.length === second.length &&
      first.every((node, index) => node === second[index])};
  });
  expect(result.count).toBe(2000);
  expect(result.reused).toBe(true);
});
