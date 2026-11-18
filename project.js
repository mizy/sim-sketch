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

export const emptyProject = () => ({reference: null, marks: []});

export const newMark = (shape, fields = {}) => ({
  id: crypto.randomUUID(), shape, kind: 'note', label: '', value: null, unit: '',
  direction: '', question: '', confirmed: false, source: 'manual', ...fields
});

export function demoProject() {
  return {
    reference: 'demo',
    marks: [
      newMark('region', {a: [220, 181], b: [393, 445], kind: 'fixed', label: '左侧安装面'}),
      newMark('arrow', {a: [672, 175], b: [672, 348], kind: 'force', label: '右侧上表面 · 总载荷均布',
        value: 500, unit: 'N', question: '图中向下对应模型 −Z 还是重力方向？'})
    ]
  };
}

export const kindLabel = {note: '备注', fixed: '固定约束', force: '力', pressure: '压力', other: '其他条件'};
