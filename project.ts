import type {Point, Shape} from './geometry.ts';

export type MarkShape = 'pen' | 'region' | 'arrow' | 'text';
export type MarkKind = 'fixed' | 'force' | 'pressure' | 'structure' | 'note' | 'other';
export type MarkSource = 'manual' | 'ai';

export interface MarkBase {
  id: string;
  shape: MarkShape;
  kind: MarkKind;
  label: string;
  value: number | null;
  unit: string;
  direction: string;
  question: string;
  confirmed: boolean;
  source: MarkSource;
  layerId: string;
  color?: string;
}

export interface PenMark extends MarkBase {
  shape: 'pen';
  points: Point[];
}

export interface RegionMark extends MarkBase {
  shape: 'region';
  a: Point;
  b: Point;
}

export interface ArrowMark extends MarkBase {
  shape: 'arrow';
  a: Point;
  b: Point;
}

export interface TextMark extends MarkBase {
  shape: 'text';
  a: Point;
}

export type Mark = PenMark | RegionMark | ArrowMark | TextMark;

export interface Layer {
  id: string;
  name: string;
  opacity: number;
}

export interface Project {
  reference: string | null;
  referenceLayerId?: string;
  layers: Layer[];
  marks: Mark[];
  shapes: Shape[];
}

export interface StoredMark extends Partial<Omit<MarkBase, 'shape'>> {
  id: string;
  shape?: MarkShape;
  a?: Point;
  b?: Point;
  points?: Point[];
}

export type StoredProject = Partial<Omit<Project, 'marks' | 'shapes' | 'layers'>> & {
  layers?: Layer[];
  marks?: StoredMark[];
  shapes?: Shape[];
};

let database: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('sim-sketch', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('projects');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}

export async function readProject(): Promise<StoredProject | undefined> {
  const db = await openDatabase();
  return new Promise<StoredProject | undefined>((resolve, reject) => {
    const request = db.transaction('projects').objectStore('projects').get('draft');
    request.onsuccess = () => resolve(request.result as StoredProject | undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function saveProject(project: Project): Promise<void> {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('projects', 'readwrite');
    transaction.objectStore('projects').put(project, 'draft');
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}

export const defaultLayerId = 'layer-default';

export const newLayer = (name: string): Layer => ({id: crypto.randomUUID(), name, opacity: 1});

export function normalizeProject(project: StoredProject): Project {
  let layers: Layer[] = project.layers?.length ? project.layers : [{id: defaultLayerId, name: '图层 1', opacity: 1}];
  const fallback = layers[0].id;
  const ids = new Set(layers.map(layer => layer.id));
  let referenceLayerId = project.referenceLayerId;
  if (project.reference && !ids.has(referenceLayerId ?? '')) {
    // 旧草稿可能已有 layer-reference 图层但没写 referenceLayerId：复用它，避免重复插入。
    referenceLayerId = 'layer-reference';
    if (!ids.has(referenceLayerId)) {
      ids.add(referenceLayerId);
      layers = [{id: referenceLayerId, name: '参考图片', opacity: 1}, ...layers];
    }
  }
  const marks = (project.marks ?? []).map(mark =>
    ids.has(mark.layerId ?? '') ? mark : {...mark, layerId: fallback});
  const shapes = (project.shapes ?? []).map(shape =>
    ids.has(shape.layerId) ? shape : {...shape, layerId: fallback});
  return {...project, reference: project.reference ?? null, layers, referenceLayerId,
    marks: marks as Mark[], shapes};
}

export const emptyProject = (): Project => ({
  reference: null, layers: [{id: defaultLayerId, name: '图层 1', opacity: 1}], marks: [], shapes: []
});

interface MarkGeometry {
  pen: {points: Point[]};
  region: {a: Point; b: Point};
  arrow: {a: Point; b: Point};
  text: {a: Point};
}

export type MarkFields<S extends MarkShape> =
  Partial<Omit<MarkBase, 'id' | 'shape'>> & MarkGeometry[S];

export function newMark(shape: 'pen', fields: MarkFields<'pen'>): PenMark;
export function newMark(shape: 'region', fields: MarkFields<'region'>): RegionMark;
export function newMark(shape: 'arrow', fields: MarkFields<'arrow'>): ArrowMark;
export function newMark(shape: 'text', fields: MarkFields<'text'>): TextMark;
export function newMark(shape: MarkShape, fields: MarkFields<MarkShape>): Mark {
  const mark: Mark = {
    id: crypto.randomUUID(),
    shape,
    kind: 'note',
    label: '',
    value: null,
    unit: '',
    direction: '',
    question: '',
    confirmed: false,
    source: 'manual',
    layerId: defaultLayerId,
    ...fields
  } as Mark;
  return mark;
}

export function demoProject(): Project {
  return {
    reference: 'demo',
    layers: [{id: defaultLayerId, name: '图层 1', opacity: 1}],
    marks: [
      newMark('region', {a: [220, 181], b: [393, 445], kind: 'fixed', label: '左侧安装面'}),
      newMark('arrow', {a: [672, 175], b: [672, 348], kind: 'force', label: '右侧上表面 · 总载荷均布',
        value: 500, unit: 'N', question: '图中向下对应模型 −Z 还是重力方向？'})
    ],
    shapes: []
  };
}

export const markKinds: Record<MarkKind, {label: string; color: string}> = {
  fixed: {label: '固定约束', color: '#087b72'},
  force: {label: '力', color: '#713ad0'},
  pressure: {label: '压力', color: '#2766c5'},
  structure: {label: '结构', color: '#b74730'},
  note: {label: '备注', color: '#9f6415'},
  other: {label: '其他条件', color: '#65748e'}
};

export function markColor(mark: Pick<Mark, 'kind' | 'color'>): string {
  if (typeof mark.color === 'string' && /^#[0-9a-f]{6}$/i.test(mark.color)) return mark.color.toLowerCase();
  return (markKinds[mark.kind] ?? markKinds.note).color;
}

export function markLegend(marks: Pick<Mark, 'kind' | 'color'>[]): {color: string; labels: string[]}[] {
  const byColor = new Map<string, Set<string>>();
  for (const mark of marks) {
    const color = markColor(mark);
    if (!byColor.has(color)) byColor.set(color, new Set());
    byColor.get(color)!.add((markKinds[mark.kind] ?? markKinds.note).label);
  }
  return Array.from(byColor, ([color, labels]) => ({color, labels: Array.from(labels)}));
}
