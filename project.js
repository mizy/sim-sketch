const database = new Promise((resolve, reject) => {
  const request = indexedDB.open('sim-sketch', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('projects');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export async function readProject() {
  const db = await database;
  return new Promise((resolve, reject) => {
    const request = db.transaction('projects').objectStore('projects').get('draft');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveProject(project) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('projects', 'readwrite');
    transaction.objectStore('projects').put(project, 'draft');
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
  });
}

export const defaultLayerId = 'layer-default';
export const newLayer = name => ({id: crypto.randomUUID(), name, opacity: 1});

export function normalizeProject(project) {
  let layers = project.layers?.length ? project.layers : [{id: defaultLayerId, name: '图层 1', opacity: 1}];
  const fallback = layers[0].id;
  const ids = new Set(layers.map(layer => layer.id));
  let referenceLayerId = project.referenceLayerId;
  if (project.reference && !ids.has(referenceLayerId)) {
    referenceLayerId = ids.has('layer-reference') ? crypto.randomUUID() : 'layer-reference';
    layers = [{id: referenceLayerId, name: '参考图片', opacity: 1}, ...layers];
  }
  return {...project, layers, referenceLayerId,
    marks: project.marks.map(mark => ids.has(mark.layerId) ? mark : {...mark, layerId: fallback})};
}

export const emptyProject = () => ({reference: null, layers: [{id: defaultLayerId, name: '图层 1', opacity: 1}], marks: []});

export const newMark = (shape, fields = {}) => ({
  id: crypto.randomUUID(), shape, kind: 'note', label: '', value: null, unit: '',
  direction: '', question: '', confirmed: false, source: 'manual', layerId: defaultLayerId, ...fields
});

export function demoProject() {
  return {
    reference: 'demo',
    layers: [{id: defaultLayerId, name: '图层 1', opacity: 1}],
    marks: [
      newMark('region', {a: [220, 181], b: [393, 445], kind: 'fixed', label: '左侧安装面'}),
      newMark('arrow', {a: [672, 175], b: [672, 348], kind: 'force', label: '右侧上表面 · 总载荷均布',
        value: 500, unit: 'N', question: '图中向下对应模型 −Z 还是重力方向？'})
    ]
  };
}

export const markKinds = {
  fixed: {label: '固定约束', color: '#087b72'},
  force: {label: '力', color: '#713ad0'},
  pressure: {label: '压力', color: '#2766c5'},
  structure: {label: '结构', color: '#b74730'},
  note: {label: '备注', color: '#9f6415'},
  other: {label: '其他条件', color: '#65748e'}
};

export function markColor(mark) {
  if (typeof mark.color === 'string' && /^#[0-9a-f]{6}$/i.test(mark.color)) return mark.color.toLowerCase();
  return (markKinds[mark.kind] ?? markKinds.note).color;
}

export function markLegend(marks) {
  const byColor = new Map();
  for (const mark of marks) {
    const color = markColor(mark);
    if (!byColor.has(color)) byColor.set(color, new Set());
    byColor.get(color).add((markKinds[mark.kind] ?? markKinds.note).label);
  }
  return Array.from(byColor, ([color, labels]) => ({color, labels: Array.from(labels)}));
}
