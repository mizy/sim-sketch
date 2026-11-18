import {newMark, kindLabel} from './project.js';

export async function interpretSketch(settings, image, marks) {
  const {endpoint, model, key} = settings;
  const headers = {'Content-Type': 'application/json'};
  if (key) headers.Authorization = `Bearer ${key}`;
  const response = await fetch(endpoint, {
    method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(90000),
    body: JSON.stringify({
      model,
      messages: [
        {role: 'system', content: `你是仿真草图解释器。解释图中用户手绘自由线、箭头、圈选、旁注、参考图和已有标注。
区分固定约束、力、压力及其他。不根据视角推断模型坐标，不编造受力数值、单位、求解器面 ID。
区分总力和压力或均布载荷，明确写出来。遇到缺失或歧义时给一条可操作的中文问题，例如图中向下对应模型 −Z 还是重力方向。
按区域归纳条件，保持条目精简。只有用户明确写出的方向才写进 direction。
仅返回 JSON，格式为 {"items":[{"markId":null,"kind":"force","label":"右侧上表面 · 总载荷均布","value":500,"unit":"N","direction":"","question":"图中向下对应哪个模型方向？","box":[0.63,0.54,0.16,0.12]}]}。
kind 取 fixed、force、pressure、other、note；未知数值用 null。box 是图像左上 x、y、宽、高，取 0 到 1。
可以关联已有笔画或标注时，markId 使用给定 ID；box 仍应贴合载荷或约束施加区域。避开已经确认的条目。没有可解释的条件时返回空数组。`},
        {role: 'user', content: [
          {type: 'text', text: '已有标注（画板宽 960、高 600）：' + JSON.stringify(marks)},
          {type: 'image_url', image_url: {url: image}}
        ]}
      ]
    })
  });
  if (!response.ok) throw new Error(`模型服务返回 HTTP ${response.status}。`);
  const content = (await response.json()).choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('模型没有返回文字结果。');
  const json = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const {items} = JSON.parse(json);
  if (!Array.isArray(items)) throw new Error('模型返回的标注格式不正确。');
  const result = [];
  for (const item of items.slice(0, 25)) {
    if (!item || !Object.hasOwn(kindLabel, item.kind) || typeof item.label !== 'string' || !item.label.trim()) continue;
    const original = marks.find(mark => mark.id === item.markId);
    if (original?.confirmed) continue;
    let geometry;
    if (Array.isArray(item.box) && item.box.length === 4 && item.box.every(Number.isFinite)) {
      const [x, y, width, height] = item.box;
      if (x >= 0 && y >= 0 && width > 0 && height > 0 && x < 1 && y < 1) {
        geometry = {shape: 'region', a: [x * 960, y * 600],
          b: [Math.min(1, x + width) * 960, Math.min(1, y + height) * 600]};
      }
    }
    if (!geometry && original) {
      const {shape, a, b, points} = original;
      geometry = {shape, a, b, points};
    }
    if (!geometry) continue;
    result.push(newMark(geometry.shape, {
      ...geometry, source: 'ai', kind: item.kind, label: item.label.slice(0, 140),
      value: Number.isFinite(item.value) ? item.value : null,
      unit: typeof item.unit === 'string' ? item.unit.slice(0, 16) : '',
      direction: typeof item.direction === 'string' ? item.direction.slice(0, 80) : '',
      question: typeof item.question === 'string' ? item.question.slice(0, 200) : '',
      relatedMark: original?.id ?? null
    }));
  }
  if (items.length && !result.length && !items.every(item => marks.some(mark => mark.confirmed && mark.id === item?.markId))) {
    throw new Error('模型没有返回能定位到画板的标注，请重试或手动标注。');
  }
  return result;
}
