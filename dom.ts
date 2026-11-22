export function element<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`找不到页面元素：${selector}`);
  return node;
}
