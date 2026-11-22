export type Rgba = readonly [number, number, number, number];

export const paper = {background: '#fbfcfe', dot: '#b6c3dd'};
export const accent = '#3047cc';
export const snapColor = '#d24a2a';

/** 把 `#rrggbb` 转成 0..1 的 RGBA。非标准颜色回退到草图墨色，避免每帧再解析 CSS。 */
export function rgba(value: string, alpha = 1): Rgba {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) return [46 / 255, 79 / 255, 119 / 255, alpha];
  const number = Number.parseInt(match[1], 16);
  return [(number >> 16) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255, alpha];
}

export function cssColor(color: Rgba): string {
  const [red, green, blue, alpha] = color;
  return `rgba(${Math.round(red * 255)},${Math.round(green * 255)},${Math.round(blue * 255)},${alpha})`;
}
