import {element} from './dom.ts';
import {Editor} from './editor.ts';
import {createEditorUi} from './editor-ui.ts';
import {copyPng, exportJson, exportPng, exportSvg} from './export.ts';
import {ensureGeometryKernel} from './kernel.ts';
import {demoProject, emptyProject, readProject} from './project.ts';
import {readReference} from './reference.ts';

const board = element<SVGSVGElement>('#board');
const status = element<HTMLElement>('#status');
const annotations = element<HTMLDivElement>('#annotations');
const notice = element<HTMLDivElement>('#notice');
const editDialog = element<HTMLDialogElement>('#edit-dialog');
const editForm = element<HTMLFormElement>('#edit-form');
const presets = element<HTMLDivElement>('#preset-colors');
const customColor = element<HTMLInputElement>('#custom-color');
const customBrush = customColor.closest('label')!;
const brushLabel = element<HTMLElement>('#brush-label');
const textInput = element<HTMLInputElement>('#canvas-text');

const editor = new Editor({board, status, notice, textInput});
createEditorUi(editor, {annotations, editDialog, editForm, presets, customColor, customBrush, brushLabel});

new ResizeObserver(() => editor.resize()).observe(board);

element<HTMLButtonElement>('#demo').onclick = () => editor.replaceCanvas(demoProject());
element<HTMLButtonElement>('#new').onclick = () => editor.replaceCanvas(emptyProject());
element<HTMLButtonElement>('#import').onclick = () => element<HTMLInputElement>('#image-file').click();
element<HTMLInputElement>('#image-file').onchange = async event => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const start = editor.changeVersion;
  try {
    const reference = await readReference(file);
    if (start !== editor.changeVersion) {
      notice.textContent = '导入时草图已更新，请重新选择图片。';
      return;
    }
    editor.replaceCanvas({...emptyProject(), reference});
  } catch {
    notice.textContent = '无法打开该图片，请选择可预览的 PNG、JPEG 或 WebP。';
  }
};

const exporter = {board, notice, project: () => editor.project};
element<HTMLButtonElement>('#copy-image').onclick = () => void copyPng(exporter);
element<HTMLButtonElement>('#export-png').onclick = () => void exportPng(exporter);
element<HTMLButtonElement>('#export-svg').onclick = () => exportSvg(exporter);
element<HTMLButtonElement>('#export-json').onclick = () => exportJson(exporter);

for (const button of document.querySelectorAll<HTMLElement>('[data-close]')) {
  button.onclick = () => button.closest('dialog')?.close();
}
for (const menu of document.querySelectorAll<HTMLDetailsElement>('.menu')) {
  const summary = menu.querySelector<HTMLElement>('summary')!;
  menu.addEventListener('click', event => {
    if ((event.target as Element).closest('button')) {
      menu.open = false;
      if (!document.querySelector('dialog[open]')) summary.focus();
    }
  });
  menu.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !menu.open) return;
    menu.open = false;
    summary.focus();
  });
  document.addEventListener('pointerdown', event => {
    if (menu.open && !menu.contains(event.target as Node)) menu.open = false;
  });
}
element<HTMLDialogElement>('#install-dialog').addEventListener('close', () =>
  element<HTMLElement>('.top-left summary').focus());

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

let installPrompt: InstallPromptEvent | null = null;
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event as InstallPromptEvent;
});
if (matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & {standalone?: boolean}).standalone) {
  element<HTMLButtonElement>('#install').hidden = true;
}
window.addEventListener('appinstalled', () => { element<HTMLButtonElement>('#install').hidden = true; });
element<HTMLButtonElement>('#install').onclick = async () => {
  if (!installPrompt) element<HTMLDialogElement>('#install-dialog').showModal();
  else {
    const prompt = installPrompt;
    installPrompt = null;
    await prompt.prompt();
  }
};

/** Wasm 只服务布尔/几何重计算；首屏绘制完成后再空闲预热，不进入首屏关键路径。 */
function warmGeometryKernel(): void {
  const load = (): void => { void ensureGeometryKernel().catch(() => undefined); };
  requestAnimationFrame(() => {
    if ('requestIdleCallback' in window) requestIdleCallback(load, {timeout: 2000});
    else setTimeout(load, 200);
  });
}

async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register('./sw.js', {updateViaCache: 'none'});
    const offerUpdate = (): void => {
      if (!registration.waiting || !navigator.serviceWorker.controller || document.querySelector('#update')) return;
      const button = document.createElement('button');
      button.id = 'update';
      button.textContent = '更新';
      button.onclick = async () => {
        await editor.whenSaved();
        navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), {once: true});
        registration.waiting?.postMessage('activate-update');
      };
      element<HTMLElement>('.top-left').append(button);
    };
    offerUpdate();
    registration.addEventListener('updatefound', () => registration.installing?.addEventListener('statechange', offerUpdate));
  } catch {
    element<HTMLElement>('#hint').textContent = '离线缓存设置失败，当前可在线绘制';
  }
}

async function start(): Promise<void> {
  try {
    const draft = await readProject();
    if (draft) editor.load(draft, true);
    else editor.apply(demoProject());
  } catch {
    editor.load(demoProject(), false);
    status.textContent = '此浏览器无法保存草稿，可以导出';
  }
  editor.setTool('pen');
  element<HTMLElement>('main').inert = false;
  editor.resize();
  void editor.host.start();
  warmGeometryKernel();
  await registerServiceWorker();
}

await start();
