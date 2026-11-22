import {newLayer} from './project.ts';
import type {Project} from './project.ts';

export function withNewLayer(project: Project): {project: Project; layerId: string} {
  let number = 1;
  while (project.layers.some(layer => layer.name === `图层 ${number}`)) number++;
  const layer = newLayer(`图层 ${number}`);
  return {layerId: layer.id, project: {...project, layers: [...project.layers, layer]}};
}

export function withReorderedLayers(project: Project, activeLayerId: string, direction: number): Project | null {
  const layers = [...project.layers];
  const from = layers.findIndex(layer => layer.id === activeLayerId);
  const to = from + direction;
  if (to < 0 || to >= layers.length) return null;
  [layers[from], layers[to]] = [layers[to], layers[from]];
  return {...project, layers};
}

export function withRemovedLayer(project: Project, activeLayerId: string):
  {project: Project; activeLayerId: string} | null {
  if (project.layers.length <= 1) return null;
  const index = project.layers.findIndex(layer => layer.id === activeLayerId);
  const removed = activeLayerId;
  const target = project.layers[index - 1] ?? project.layers[index + 1];
  return {
    activeLayerId: target.id,
    project: {...project, layers: project.layers.filter(layer => layer.id !== removed),
      referenceLayerId: project.referenceLayerId === removed ? target.id : project.referenceLayerId,
      marks: project.marks.map(mark => mark.layerId === removed ? {...mark, layerId: target.id} : mark),
      shapes: project.shapes.map(shape => shape.layerId === removed ? {...shape, layerId: target.id} : shape)}
  };
}
