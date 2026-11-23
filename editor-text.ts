import {markColor} from './project.ts';
import type {Mark, Project, TextMark} from './project.ts';
import {textFontSize} from './text-metrics.ts';
import {boardScreenScale, boardToScreen} from './viewport.ts';

export interface TextEditingHost {
  board: SVGSVGElement;
  input: HTMLInputElement;
  project(): Project;
  paint(): void;
  render(): void;
  commit(next: Project): void;
  addMark(mark: Mark): void;
  select(id: string | null): void;
  activateLayer(id: string): void;
  /** drawing = {mode: 'text'} 期间隐藏画布上已保存的文字。 */
  setTextDrawing(active: boolean): void;
}

/** 画布内联文字输入：DOM 输入框只负责编辑，提交仍走 Editor 的历史与保存。 */
export class InlineTextEditor {
  private inline: {mark: TextMark; existing: boolean} | null = null;

  constructor(private readonly host: TextEditingHost) {
    host.input.addEventListener('blur', () => this.finish());
    host.input.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); this.finish(); }
      if (event.key === 'Escape') { event.preventDefault(); this.finish(true); }
    });
  }

  get active(): boolean {
    return Boolean(this.inline);
  }

  /** 重绘后重新隐藏已保存文字，避免输入框与画布文字重影。 */
  hideMark(): void {
    if (this.inline) this.host.board.querySelector(`[data-id="${this.inline.mark.id}"]`)
      ?.setAttribute('visibility', 'hidden');
  }

  begin(mark: TextMark): void {
    if (this.inline) this.finish();
    const existing = this.host.project().marks.some(item => item.id === mark.id);
    this.inline = {mark, existing};
    this.host.select(mark.id);
    this.host.activateLayer(mark.layerId);
    this.host.setTextDrawing(true);
    this.host.paint();
    this.host.board.querySelector(`[data-id="${mark.id}"]`)?.setAttribute('visibility', 'hidden');
    const input = this.host.input;
    input.value = mark.label;
    input.hidden = false;
    this.position();
    input.focus();
    if (existing) input.select();
  }

  /** 丢弃当前输入并关闭输入框；不写入历史，供切换项目/撤销前清理。 */
  cancel(): void {
    if (!this.inline) return;
    const {mark} = this.inline;
    this.inline = null;
    this.host.board.querySelector(`[data-id="${mark.id}"]`)?.removeAttribute('visibility');
    this.host.setTextDrawing(false);
    this.host.input.hidden = true;
    this.host.input.value = '';
  }

  finish(cancel = false): void {
    if (!this.inline) return;
    const {mark, existing} = this.inline;
    this.host.board.querySelector(`[data-id="${mark.id}"]`)?.removeAttribute('visibility');
    const label = this.host.input.value.trim();
    this.inline = null;
    this.host.setTextDrawing(false);
    this.host.input.hidden = true;
    if (!cancel && !label && existing) {
      this.host.select(null);
      this.host.commit({...this.host.project(), marks: this.host.project().marks.filter(item => item.id !== mark.id)});
    } else if (!cancel && label && label !== mark.label) {
      const updated: TextMark = {...mark, label};
      if (existing) {
        this.host.commit({...this.host.project(), marks: this.host.project().marks.map(item =>
          item.id === mark.id ? updated : item)});
      } else this.host.addMark(updated);
    } else {
      if (!existing) this.host.select(null);
      this.host.render();
    }
  }

  position(): void {
    if (!this.inline) return;
    const parent = this.host.board.parentElement;
    if (!parent) return;
    const point = boardToScreen(this.host.board, this.inline.mark.a);
    const wrap = parent.getBoundingClientRect();
    const scale = boardScreenScale(this.host.board);
    const input = this.host.input;
    input.style.left = `${point.x - wrap.left}px`;
    input.style.top = `${point.y - wrap.top}px`;
    input.style.fontSize = `${textFontSize(this.inline.mark) * scale}px`;
    input.style.color = markColor(this.inline.mark);
    input.style.width = `${Math.max(80, Math.min(wrap.right - point.x - 12, 450))}px`;
  }
}
