import {readFileSync} from 'node:fs';
import {expect, test} from '@playwright/test';
import type {Page} from '@playwright/test';

interface ExportShape {
  id: string;
  type: string;
  a?: [number, number];
  b?: [number, number];
  color: string;
  strokeWidth: number;
  layerId: string;
}

interface ExportMark {
  id: string;
  shape: string;
  a?: [number, number];
  b?: [number, number];
  kind: string;
  width?: number;
  layerId: string;
}

interface ExportProject {
  shapes: ExportShape[];
  marks: ExportMark[];
}

async function openEmptySketch(page: Page): Promise<void> {
  // 键盘粘贴走 Clipboard API；测试环境显式授权，才能覆盖真实 Ctrl/⌘+V 路径。
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'],
    {origin: 'http://127.0.0.1:18766'});
  await page.goto('/?renderer=svg');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#board')).toHaveAttribute('data-renderer', 'svg');
  await page.locator('.menu summary').click();
  await page.locator('#new').click();
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');
}

async function drawRect(page: Page, x: number, y: number): Promise<void> {
  await page.locator('button[data-tool="rect"]').click();
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + x + 130, box.y + y + 90, {steps: 6});
  await page.mouse.up();
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');
}

async function selectShape(page: Page, index: number): Promise<void> {
  await page.locator('button[data-tool="select"]').click();
  const node = page.locator('[data-shape-id]').nth(index);
  const box = await node.boundingBox();
  if (!box) throw new Error('图形没有尺寸');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('#shape-actions')).toBeVisible();
}

async function exportJson(page: Page): Promise<ExportProject> {
  await page.locator('.menu summary').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#export-json').click()
  ]);
  return JSON.parse(readFileSync(await download.path(), 'utf8')) as ExportProject;
}

test('copy/paste offsets shapes, selects them, survives reload and stays movable', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openEmptySketch(page);
  await drawRect(page, 220, 160);
  await selectShape(page, 0);

  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect(page.locator('[data-shape-id]')).toHaveCount(2);
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');
  // 粘贴后自动选中新对象，无需再次点选即可变换。
  await expect(page.locator('#shape-actions')).toBeVisible();
  await expect(page.locator('[data-transform-handle="se"]')).toBeVisible();

  await page.keyboard.press('Control+v');
  await expect(page.locator('[data-shape-id]')).toHaveCount(3);
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');

  const project = await exportJson(page);
  expect(project.shapes).toHaveLength(3);
  const [first, second, third] = project.shapes;
  // 连续粘贴每次固定 +16 模型单位，不会与源对象或上一次结果重合。
  expect(second.a![0] - first.a![0]).toBeCloseTo(16, 3);
  expect(second.a![1] - first.a![1]).toBeCloseTo(16, 3);
  expect(third.a![0] - first.a![0]).toBeCloseTo(32, 3);
  expect(third.a![1] - first.a![1]).toBeCloseTo(32, 3);
  expect(second.id).not.toBe(first.id);
  expect(third.id).not.toBe(second.id);
  // 类型、颜色、线宽与图层原样保留。
  for (const shape of project.shapes) {
    expect(shape.type).toBe(first.type);
    expect(shape.color).toBe(first.color);
    expect(shape.strokeWidth).toBe(first.strokeWidth);
    expect(shape.layerId).toBe(first.layerId);
  }

  // 粘贴后立即拖动仍走现有移动/捕捉入口：只移动，不新建图形。
  const pasted = page.locator('[data-shape-id]').nth(2);
  const box = await pasted.boundingBox();
  if (!box) throw new Error('粘贴后的图形没有尺寸');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 24, {steps: 6});
  await page.mouse.up();
  await expect(page.locator('[data-shape-id]')).toHaveCount(3);
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');

  await page.reload();
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await expect(page.locator('[data-shape-id]')).toHaveCount(3);
  expect(errors).toEqual([]);
});

test('a delayed paste event for the same gesture pastes only once', async ({page}) => {
  await openEmptySketch(page);
  await drawRect(page, 220, 160);
  await selectShape(page, 0);
  await page.keyboard.press('Control+c');

  // 模拟浏览器把 paste 事件推迟到按键兜底之后：兜底已粘贴一次，迟到事件必须让位。
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'v', ctrlKey: true, bubbles: true, cancelable: true}));
    window.setTimeout(() => {
      const data = new DataTransfer();
      data.setData('text/plain', '');
      const event = new Event('paste', {bubbles: true, cancelable: true});
      Object.defineProperty(event, 'clipboardData', {value: data});
      document.dispatchEvent(event);
    }, 350);
  });
  await expect(page.locator('[data-shape-id]')).toHaveCount(2);
  await page.waitForTimeout(450);
  await expect(page.locator('[data-shape-id]')).toHaveCount(2);

  // 一次 Ctrl+V 只对应一条 undo。
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
});

test('plain-text and image clipboard contents never paste the old canvas copy', async ({page}) => {
  await openEmptySketch(page);
  await drawRect(page, 220, 160);
  await selectShape(page, 0);
  await page.keyboard.press('Control+c');

  const plainTextPrevented = await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', 'hello from another app');
    const event = new Event('paste', {bubbles: true, cancelable: true});
    Object.defineProperty(event, 'clipboardData', {value: data});
    document.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(plainTextPrevented).toBe(false);
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);

  const imagePrevented = await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'paste.png', {type: 'image/png'}));
    const event = new Event('paste', {bubbles: true, cancelable: true});
    Object.defineProperty(event, 'clipboardData', {value: data});
    document.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(imagePrevented).toBe(false);
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
});

test('a real image/png clipboard keeps native paste and never revives the canvas memory copy', async ({page}) => {
  await openEmptySketch(page);
  await drawRect(page, 220, 160);
  await selectShape(page, 0);
  await page.keyboard.press('Control+c');

  // 写入真实 image/png ClipboardItem：Chromium 的 readText() 会对它 resolve 空串，
  // 这正是“空剪贴板”误判的复现路径。
  const types = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 4;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2d context unavailable');
    context.fillStyle = '#ff0000';
    context.fillRect(0, 0, 4, 4);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(value => value ? resolve(value) : reject(new Error('png encode failed')), 'image/png');
    });
    await navigator.clipboard.write([new ClipboardItem({'image/png': blob})]);
    const items = await navigator.clipboard.read();
    return items.flatMap(item => item.types);
  });
  expect(types).toContain('image/png');

  await page.evaluate(() => {
    interface PasteProbe {prevented: boolean | null}
    (window as typeof window & {__pasteProbe?: PasteProbe}).__pasteProbe = {prevented: null};
    document.addEventListener('paste', event => {
      (window as typeof window & {__pasteProbe?: PasteProbe}).__pasteProbe!.prevented = event.defaultPrevented;
    });
  });
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(600);
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
  const probe = await page.evaluate(() =>
    (window as typeof window & {__pasteProbe?: {prevented: boolean | null}}).__pasteProbe);
  // 真实 paste 事件若到达，必须保持原生默认行为；即使无事件也不能凭空粘贴旧对象。
  if (probe?.prevented !== null) expect(probe?.prevented).toBe(false);
});

test('external plain text copied after a canvas copy wins over the old memory copy', async ({page}) => {
  await openEmptySketch(page);
  await drawRect(page, 220, 160);
  await selectShape(page, 0);
  await page.keyboard.press('Control+c');

  // 另一个应用刚覆盖了系统剪贴板：Ctrl+V 必须尊重普通文本，不得粘贴旧画布对象。
  await page.evaluate(async () => {
    await navigator.clipboard.writeText('hello from another app');
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'v', ctrlKey: true, bubbles: true}));
  });
  await page.waitForTimeout(100);
  const prevented = await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', 'hello from another app');
    const event = new Event('paste', {bubbles: true, cancelable: true});
    Object.defineProperty(event, 'clipboardData', {value: data});
    document.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(false);
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
});

test('an older system payload never overwrites the latest in-memory copy', async ({page}) => {
  await openEmptySketch(page);
  await drawRect(page, 200, 150);
  await drawRect(page, 420, 300);
  await selectShape(page, 0);
  await page.keyboard.press('Control+c');
  await selectShape(page, 1);
  await page.keyboard.press('Control+c');

  const before = await exportJson(page);
  const latest = before.shapes[1];
  await page.evaluate(() => {
    const payload = {
      format: 'sim-sketch/clipboard', version: 1, copiedAt: Date.now() - 10_000, nonce: 'stale',
      shapes: [{id: 'stale', type: 'rect', layerId: 'layer-default', color: '#2e4f77', strokeWidth: 2.4,
        a: [1, 1], b: [11, 11]}],
      marks: []
    };
    const data = new DataTransfer();
    data.setData('text/plain', JSON.stringify(payload));
    const event = new Event('paste', {bubbles: true, cancelable: true});
    Object.defineProperty(event, 'clipboardData', {value: data});
    document.dispatchEvent(event);
  });

  const after = await exportJson(page);
  expect(after.shapes).toHaveLength(3);
  expect(after.shapes[2].a![0]).toBeCloseTo(latest.a![0] + 16, 3);
  expect(after.shapes[2].a![1]).toBeCloseTo(latest.a![1] + 16, 3);
});

test('a newer system payload from another tab wins even when its copiedAt looks older', async ({page}) => {
  await openEmptySketch(page);
  await drawRect(page, 200, 150);
  await drawRect(page, 420, 300);
  await selectShape(page, 0);
  await page.keyboard.press('Control+c');
  await selectShape(page, 1);
  await page.keyboard.press('Control+c');

  // Tab2 在更早时间复制、却延迟到本页复制之后才写入系统剪贴板：
  // copiedAt 跨标签页没有可比性，本页必须接受系统剪贴板的当前内容。
  await page.evaluate(() => {
    const payload = {
      format: 'sim-sketch/clipboard', version: 1, copiedAt: Date.now() - 10_000,
      nonce: 'other-tab-copy', sessionId: 'other-tab',
      shapes: [{id: 'other', type: 'rect', layerId: 'layer-default', color: '#2e4f77', strokeWidth: 2.4,
        a: [700, 120], b: [740, 150]}],
      marks: []
    };
    const data = new DataTransfer();
    data.setData('text/plain', JSON.stringify(payload));
    const event = new Event('paste', {bubbles: true, cancelable: true});
    Object.defineProperty(event, 'clipboardData', {value: data});
    document.dispatchEvent(event);
  });

  const after = await exportJson(page);
  expect(after.shapes).toHaveLength(3);
  expect(after.shapes[2].a![0]).toBeCloseTo(716, 3);
  expect(after.shapes[2].a![1]).toBeCloseTo(136, 3);
});

test('zero-size external rect is expanded and immediately transformable', async ({page}) => {
  await openEmptySketch(page);
  await page.locator('button[data-tool="select"]').click();
  await page.evaluate(() => {
    const payload = {
      format: 'sim-sketch/clipboard', version: 1,
      shapes: [{id: 'flat', type: 'rect', layerId: 'layer-default', color: '#2e4f77', strokeWidth: 2.4,
        a: [200, 160], b: [200, 160]}],
      marks: []
    };
    const data = new DataTransfer();
    data.setData('text/plain', JSON.stringify(payload));
    const event = new Event('paste', {bubbles: true, cancelable: true});
    Object.defineProperty(event, 'clipboardData', {value: data});
    document.dispatchEvent(event);
  });
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
  await expect(page.locator('#shape-actions')).toBeVisible();
  // 4×4 对象的多个 24px 命中圈会重叠；先拖最后绘制的 w 手柄加宽，再拖 n 手柄加高。
  for (const [handleName, dx, dy] of [['w', -60, 0], ['n', 0, -40]] as const) {
    const handle = await page.locator(`[data-transform-handle="${handleName}"]`).boundingBox();
    if (!handle) throw new Error(`零尺寸矩形粘贴后没有 ${handleName} 手柄`);
    const x = handle.x + handle.width / 2;
    const y = handle.y + handle.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, {steps: 6});
    await page.mouse.up();
    await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');
  }

  const project = await exportJson(page);
  const shape = project.shapes[0];
  if (shape.type !== 'rect' || !shape.a || !shape.b) throw new Error('导出的矩形几何缺失');
  expect(Math.abs(shape.b[0] - shape.a[0])).toBeGreaterThan(4);
  expect(Math.abs(shape.b[1] - shape.a[1])).toBeGreaterThan(4);
});

test('missing Clipboard API falls back to the in-tab copy with an explicit notice', async ({page}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {value: undefined, configurable: true});
  });
  await openEmptySketch(page);
  await drawRect(page, 220, 160);
  await selectShape(page, 0);

  await page.keyboard.press('Control+c');
  await expect(page.locator('#notice')).toContainText('系统剪贴板不可用');
  await expect(page.locator('#notice')).toContainText('本标签页内保留副本');
});

test('two copies in the same millisecond keep the newest payload', async ({page}) => {
  await openEmptySketch(page);
  await drawRect(page, 200, 150);
  await drawRect(page, 420, 300);

  await page.evaluate(() => {
    const w = window as typeof window & {__writes?: string[]; __realNow?: () => number};
    w.__writes = [];
    const clipboard = navigator.clipboard;
    const write = clipboard.writeText.bind(clipboard);
    clipboard.writeText = async (text: string) => {
      w.__writes!.push(text);
      return write(text);
    };
    // 旧实现只比较 copiedAt：同一毫秒复制 A/B 时两份时间戳相等，旧 A 会覆盖 B。
    w.__realNow = Date.now;
    Date.now = () => 1_700_000_000_000;
  });

  await selectShape(page, 0);
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & {__writes?: string[]}).__writes!.length)).toBe(1);
  const firstPayload = await page.evaluate(() =>
    (window as typeof window & {__writes?: string[]}).__writes![0]);

  await selectShape(page, 1);
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & {__writes?: string[]}).__writes!.length)).toBe(2);

  const before = await exportJson(page);
  const latest = before.shapes[1];
  await page.evaluate(payload => {
    const data = new DataTransfer();
    data.setData('text/plain', payload);
    const event = new Event('paste', {bubbles: true, cancelable: true});
    Object.defineProperty(event, 'clipboardData', {value: data});
    document.dispatchEvent(event);
  }, firstPayload);

  const after = await exportJson(page);
  expect(after.shapes).toHaveLength(3);
  // 系统剪贴板里是更旧的 A，必须被单调时间戳识别为过期，粘贴内存里的 B。
  expect(after.shapes[2].a![0]).toBeCloseTo(latest.a![0] + 16, 3);
  expect(after.shapes[2].a![1]).toBeCloseTo(latest.a![1] + 16, 3);
});

test('Escape inside the layer name input keeps the canvas selection', async ({page}) => {
  await openEmptySketch(page);
  await drawRect(page, 220, 160);
  await selectShape(page, 0);

  await page.locator('#toggle-layers').click();
  const name = page.locator('#layer-list input[aria-label="图层名称"]').first();
  await name.focus();
  await name.press('Escape');

  await expect(page.locator('#shape-actions')).toBeVisible();
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
});

test('a different external clipboard payload resets the consecutive paste offset', async ({page}) => {
  await openEmptySketch(page);
  await drawRect(page, 220, 160);
  await selectShape(page, 0);
  await page.keyboard.press('Control+c');

  const pasteExternal = (id: string, x: number, y: number) => page.evaluate(({id, x, y}) => {
    const payload = {
      format: 'sim-sketch/clipboard', version: 1,
      shapes: [{id, type: 'rect', layerId: 'layer-default', color: '#2e4f77', strokeWidth: 2.4,
        a: [x, y], b: [x + 40, y + 30]}],
      marks: []
    };
    const data = new DataTransfer();
    data.setData('text/plain', JSON.stringify(payload));
    const event = new Event('paste', {bubbles: true, cancelable: true});
    Object.defineProperty(event, 'clipboardData', {value: data});
    document.dispatchEvent(event);
  }, {id, x, y});

  await pasteExternal('external-1', 400, 120);
  await expect(page.locator('[data-shape-id]')).toHaveCount(2);
  await pasteExternal('external-2', 600, 120);
  await expect(page.locator('[data-shape-id]')).toHaveCount(3);

  const project = await exportJson(page);
  expect(project.shapes[1].a![0]).toBeCloseTo(416, 3);
  expect(project.shapes[2].a![0]).toBeCloseTo(616, 3);
});

test('copy/paste duplicates an annotation with the same style and a fixed offset', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openEmptySketch(page);
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');

  await page.locator('button[data-tool="region"]').click();
  await page.mouse.move(box.x + 240, box.y + 180);
  await page.mouse.down();
  await page.mouse.move(box.x + 380, box.y + 290, {steps: 6});
  await page.mouse.up();
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');

  await page.locator('button[data-tool="select"]').click();
  await page.mouse.click(box.x + 310, box.y + 235);
  await expect(page.locator('#selection-actions')).toBeVisible();

  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');
  await expect(page.locator('[data-id]')).toHaveCount(2);
  await expect(page.locator('#selection-actions')).toBeVisible();

  const project = await exportJson(page);
  expect(project.marks).toHaveLength(2);
  const [first, second] = project.marks;
  expect(second.shape).toBe(first.shape);
  expect(second.kind).toBe(first.kind);
  expect(second.width).toBe(first.width);
  expect(second.layerId).toBe(first.layerId);
  expect(second.a![0] - first.a![0]).toBeCloseTo(16, 3);
  expect(second.a![1] - first.a![1]).toBeCloseTo(16, 3);
  expect(second.id).not.toBe(first.id);
  expect(errors).toEqual([]);
});

test('Ctrl+X, Ctrl+D and undo/redo keep a single history entry per action', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openEmptySketch(page);
  await drawRect(page, 240, 170);
  await selectShape(page, 0);

  await page.keyboard.press('Control+d');
  await expect(page.locator('[data-shape-id]')).toHaveCount(2);
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');
  const duplicated = await exportJson(page);
  // 原地复制不偏移，几何完全一致。
  expect(duplicated.shapes[1].a).toEqual(duplicated.shapes[0].a);

  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
  // undo 会清空选择（既有行为）；重新选中后再剪切。
  await selectShape(page, 0);

  await page.keyboard.press('Control+x');
  await expect(page.locator('[data-shape-id]')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('[data-shape-id]')).toHaveCount(0);

  await page.keyboard.press('Control+v');
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
  await expect(page.locator('#shape-actions')).toBeVisible();
  expect(errors).toEqual([]);
});

test('paste while another layer is active lands on the active target layer', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openEmptySketch(page);
  await drawRect(page, 220, 160);
  await selectShape(page, 0);
  await page.keyboard.press('Control+c');

  await page.locator('#toggle-layers').click();
  await page.locator('#add-layer').click();
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');
  await page.keyboard.press('Control+v');
  await expect(page.locator('[data-shape-id]')).toHaveCount(2);
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');

  const project = await exportJson(page);
  expect(project.shapes).toHaveLength(2);
  // 产品口径：粘贴落到当前活动图层，而不是复制时所在的源图层。
  expect(project.shapes[1].layerId).not.toBe(project.shapes[0].layerId);
  expect(errors).toEqual([]);
});

test('Ctrl+Z inside a layer-name input never undoes canvas history', async ({page}) => {
  await openEmptySketch(page);
  await drawRect(page, 220, 160);
  await selectShape(page, 0);
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect(page.locator('[data-shape-id]')).toHaveCount(2);

  await page.locator('#toggle-layers').click();
  await page.locator('#layer-list input').first().focus();
  await page.keyboard.press('Control+z');
  // 原生文本撤销可以发生，但画布的历史不能被回退。
  await expect(page.locator('[data-shape-id]')).toHaveCount(2);
});

test('paste falls back to the active layer after the source layer is deleted', async ({page}) => {
  await openEmptySketch(page);
  await drawRect(page, 220, 160);
  await selectShape(page, 0);
  await page.keyboard.press('Control+c');

  await page.locator('#toggle-layers').click();
  await page.locator('#add-layer').click();
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');
  // 聚焦最底层的源图层后删除；对象会迁入相邻图层，但内存剪贴板仍指向旧 layer id。
  await page.locator('#layer-list input').last().focus();
  await page.locator('#delete-layer').click();
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');

  await page.keyboard.press('Control+v');
  await expect(page.locator('[data-shape-id]')).toHaveCount(2);
  const project = await exportJson(page);
  expect(project.shapes[1].layerId).toBe(project.shapes[0].layerId);
});

test('native copy/paste inside text controls is never hijacked by the canvas', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openEmptySketch(page);
  await drawRect(page, 220, 160);
  await selectShape(page, 0);

  await page.evaluate(() => {
    const area = document.createElement('textarea');
    area.id = 'clipboard-probe';
    area.value = 'native text';
    document.body.append(area);
    area.focus();
    area.select();
  });
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
  await expect(page.locator('#shape-actions')).toBeVisible();
  const probe = await page.evaluate(() => ({
    active: (document.activeElement as HTMLElement | null)?.id ?? '',
    value: document.querySelector<HTMLTextAreaElement>('#clipboard-probe')?.value ?? ''
  }));
  expect(probe.active).toBe('clipboard-probe');
  // 粘贴发生在输入框内部，不产生新的画布对象。
  expect(probe.value).toContain('native text');

  // 图层名输入框同样保留原生行为。
  await page.locator('#toggle-layers').click();
  const layerName = page.locator('#layer-list input').first();
  await layerName.focus();
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('clipboard read denial falls back to the in-memory copy with an explicit notice', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openEmptySketch(page);
  await drawRect(page, 220, 160);
  await selectShape(page, 0);
  await page.keyboard.press('Control+c');

  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'readText', {
      configurable: true,
      value: () => Promise.reject(new DOMException('denied', 'NotAllowedError'))
    });
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'v', ctrlKey: true, bubbles: true, cancelable: true}));
  });
  await expect(page.locator('[data-shape-id]')).toHaveCount(2);
  await expect(page.locator('#notice')).toContainText('剪贴板不可用，已在本标签页内粘贴');
  expect(errors).toEqual([]);
});

test('read denial waits for a delayed real paste instead of pasting the old memory copy', async ({page}) => {
  await openEmptySketch(page);
  await drawRect(page, 220, 160);
  await selectShape(page, 0);
  await page.keyboard.press('Control+c');

  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'readText', {
      configurable: true,
      value: () => Promise.reject(new DOMException('denied', 'NotAllowedError'))
    });
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'v', ctrlKey: true, bubbles: true, cancelable: true}));
    window.setTimeout(() => {
      const payload = {
        format: 'sim-sketch/clipboard', version: 1,
        shapes: [{id: 'external', type: 'rect', layerId: 'layer-default', color: '#2e4f77', strokeWidth: 2.4,
          a: [600, 120], b: [640, 150]}],
        marks: []
      };
      const data = new DataTransfer();
      data.setData('text/plain', JSON.stringify(payload));
      const event = new Event('paste', {bubbles: true, cancelable: true});
      Object.defineProperty(event, 'clipboardData', {value: data});
      document.dispatchEvent(event);
    }, 150);
  });
  await expect(page.locator('[data-shape-id]')).toHaveCount(2);
  // 等过内存回退窗口，确认迟到事件取消回退，而不是先粘贴旧副本再吞掉外部内容。
  await page.waitForTimeout(500);
  await expect(page.locator('[data-shape-id]')).toHaveCount(2);
  const project = await exportJson(page);
  expect(project.shapes[1].a![0]).toBeCloseTo(616, 3);
});

test('malformed SimSketch payload is rejected with a precise notice', async ({page}) => {
  await openEmptySketch(page);
  await drawRect(page, 220, 160);
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', JSON.stringify({
      format: 'sim-sketch/clipboard', version: 1, shapes: [{id: 'bad', type: 'bogus'}], marks: []
    }));
    const event = new Event('paste', {bubbles: true, cancelable: true});
    Object.defineProperty(event, 'clipboardData', {value: data});
    document.dispatchEvent(event);
  });
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
  await expect(page.locator('#notice')).toHaveText('剪贴板内容不是 SimSketch 对象。');
});

test('pasting on the reference layer falls back to the last normal layer and names it', async ({page}) => {
  await page.addInitScript(() => {
    const request = indexedDB.open('sim-sketch', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('projects');
    return new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('projects', 'readwrite');
        tx.objectStore('projects').put({
          reference: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lP6Z4QAAAABJRU5ErkJggg==',
          referenceLayerId: 'layer-reference',
          layers: [
            {id: 'layer-reference', name: '参考图片', opacity: 1},
            {id: 'layer-default', name: '图层 1', opacity: 1}
          ],
          shapes: [],
          marks: []
        }, 'draft');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
  });
  await page.goto('/?renderer=svg');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await drawRect(page, 220, 160);
  await selectShape(page, 0);
  await page.keyboard.press('Control+c');

  await page.locator('#toggle-layers').click();
  await page.locator('#layer-list button[aria-label="选择参考图片"]').click();
  await page.keyboard.press('Control+v');
  await expect(page.locator('[data-shape-id]')).toHaveCount(2);
  await expect(page.locator('#notice')).toContainText('当前图层为参考图层，已粘贴到「图层 1」。');
  const project = await exportJson(page);
  expect(project.shapes[1].layerId).toBe('layer-default');
});


test('Ctrl+C with no selection does not prevent the native copy', async ({page}) => {
  await openEmptySketch(page);
  const prevented = await page.evaluate(() => {
    const event = new KeyboardEvent('keydown', {key: 'c', ctrlKey: true, bubbles: true, cancelable: true});
    document.body.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(false);
  await expect(page.locator('[data-shape-id]')).toHaveCount(0);
});

test('Ctrl+D with no selection is consumed instead of opening the browser bookmark dialog', async ({page}) => {
  await openEmptySketch(page);
  const prevented = await page.evaluate(() => {
    const event = new KeyboardEvent('keydown', {key: 'd', ctrlKey: true, bubbles: true, cancelable: true});
    document.body.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await expect(page.locator('[data-shape-id]')).toHaveCount(0);
});
