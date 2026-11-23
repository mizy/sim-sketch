# 画笔粗细与标注线宽持久化 · 实现报告

## 1. 背景与目标

旧版画笔、圈选、箭头只有固定线宽，重点标注无法突出、细部标注又显笨重。本次改动让线宽成为每个标注自身的持久化属性，并提供一个不离开画布就能调整的「粗细」控件：

- 粗细只影响之后新画的内容，不追改历史标注；
- 画笔 / 圈选 / 箭头共用当前粗细，新画直线 / 矩形 / 圆 / 圆弧写入 `Shape.strokeWidth`；
- 旧草稿打开后保持原有 4 / 3 / 5 观感，非法数据静默回退；
- 选中加粗仅作为渲染修饰，不污染落盘数据；
- 桌面与移动端均保持可键盘操作、可触控。

## 2. 最终决策表

| 决策项 | 口径 |
|---|---|
| 取值范围 | 1–24 px，整数，`step=1` |
| 默认值 | 4 px（与旧画笔观感一致；新圈选/箭头也统一取当前值，旧草稿仍为 3 / 5） |
| 控件位置 | 桌面：调色板颜色井右侧，竖分隔线分组；移动端：颜色井下方第二行 |
| 控件形态 | 原生 `range` + 实时数值 `output` + 桌面临宽预览线 |
| 生效范围 | 之后新画的 pen / region / arrow；之后新画的 line / rect / circle / arc |
| 选中强调 | 自身宽度 + 2（4→6 / 3→5 / 5→7 的观感保持不变） |
| 旧数据 | pen 4、region 3、arrow 5；越界数值夹到 1–24；非数字回退形状默认值 |
| 滑块值持久化 | 不持久化，刷新回到 4；持久化的是每个标注 / 图形自身宽度 |
| 文字 | 不参与线宽，字号仍固定 22 |
| 追改旧标注 | 不做；编辑弹窗也不提供线宽修改（P1） |

## 3. 数据模型与兼容

- `PenMark` / `RegionMark` / `ArrowMark` 新增可选 `width?: number`；`TextMark` 不获得该字段，靠类型系统阻止文字带线宽。
- `StoredMark` 增加可选 `width?: number`，用于承接旧草稿与未知额外字段。
- `normalizeProject()` 是草稿加载、撤销/重做、每次提交的唯一规范化入口：
  - 只对 `pen` / `region` / `arrow` 补 `width`；
  - 缺失、`NaN`、`Infinity`、非数字 → 按形状默认值 4 / 3 / 5；
  - 有限数值 → 四舍五入并夹到 1–24；
  - 已合法的标注保持原对象引用，`normalizeProject()` 仍幂等；
  - 文字与 `shape` 缺失的旧结构完全不动，避免破坏既有迁移测试。
- `Shape.strokeWidth` 也走加载校验：`NaN` / `Infinity` / 非数字 / 非正数回退旧图形默认 `2.4`，有限值夹到 1–24；历史 `2.4` 小数原样保留，不做四舍五入。
- 脏数据在 `normalizeProject()`、`mark-width.ts` 与命中代理三处都有兜底，坏掉的 `stroke-width` 不会同时导致图形不可见、不可点、不可删。
- 没有 IndexedDB schema 版本升级：`width` 是向后兼容的可选字段，旧代码读到它会原样保留、忽略不读；回滚不会损坏已存草稿。
- 保存路径无需改动：`saveProject()` 直接写入规范化后的 `Project`，刷新后 `readProject() → Editor.load() → normalizeProject()` 保留宽度。

## 4. 适用范围矩阵

| 内容 | 行为 |
|---|---|
| 画笔 pen | `width` 写入标注，渲染读取自身宽度 |
| 圈选 region | 与画笔、箭头共用当前粗细 |
| 箭头 arrow | 线宽随自身宽度；箭头头部长度随宽度放大，上限为箭头长度的 1/2 |
| 直线 / 矩形 / 圆 / 圆弧 | 创建时写入 `Shape.strokeWidth = 当前粗细` |
| 布尔结果 path | 继续继承第一个操作数的 `strokeWidth` |
| 文字 | 不参与线宽；字号固定 22 |
| 参考图片、图层、颜色 | 不受影响 |

## 5. 渲染链路

- `mark-width.ts` 集中管理 1–24、默认 4、旧标注迁移默认 4/3/5、旧图形默认 2.4、选中 +2，以及 `normalizeMarkWidth()` / `normalizeBrushWidth()` / `normalizeShapeStrokeWidth()` / `renderMarkWidth()`。
- `annotations.ts` 的 `markGeometry()` 仍是 SVG、WebGPU、Canvas2D、SVG 导出四条路径的唯一几何/样式真源：
  - 宽度读取标注自身 `width`，缺失时按形状回退；
  - 选中态在输出样式上 `+2`，不回写 `mark.width`；
  - 箭头头部：`min(distance * 0.5, max(min(21, distance * 0.47), width * 1.8))`，默认宽度下与旧观感一致，24px 时头部同步放大。
- `scene.ts` 只消费 `markGeometry()` 的 `width`，四个渲染后端零改动，因此不会出现“SVG 粗、导出细”的双口径。
- `board.ts`：
  - 可见几何继续走 `markGeometry()`；
  - 命中代理宽度改为 `max(18/22, 可见线宽)`，24px 粗线边缘仍可点选；
  - 图形命中代理同样取 `max(18, normalizeShapeStrokeWidth(Shape.strokeWidth))`；
  - 模板不再硬编码滑块的 min/max/value，范围与初值统一由 `editor-ui.ts` 从 TS 常量写入。
  - SVG overlay 与 GPU/Canvas2D 的可见线宽一致。
- `geometry.ts` 的 `newShape()` 默认 `strokeWidth` 从 2.4 调整为 4；旧草稿中缺失 `strokeWidth` 的图形在渲染层仍回退 2.4，不整体改变旧图形观感。

## 6. 交互与可访问性

- `index.html` 在 `.palette-panel` 内新增 `.palette-width`：`label` + `output` + 原生 `range` + SVG 预览线。
- 滑块 `aria-label="画笔粗细"`，`output[for=brush-width]` 实时显示 `N px`；键盘方向键可调，Home/End 等原生行为保留。
- 滑块变化只调用 `Editor.setBrushWidth()` 并回显数值/预览，不提交项目、不重绘已有标注。
- 颜色切换（`chooseBrush()`）不重置粗细；粗细状态由 `Editor.brushWidth` 单点持有。
- 移动端（≤700px）：调色板改为两行，颜色井保持 4 列 × 58px；滑块触控高度 44px；预览线在移动端隐藏但数值保留。
- 只有文本类输入框与 `textarea` 保留 Delete/Backspace 的原生编辑行为；`range` / `select` / `color` 聚焦时 Delete、Ctrl/⌘+Z、Esc 仍作用于画布。Esc 与撤销始终放行，避免滑块聚焦后「删除/撤销坏了」。

## 7. 回归红线

- 未改写既有未提交的 `editor-ui.ts` 选中操作条跟随逻辑（`placeActions` / `schedulePosition` 原样保留）。
- 未改写 `tests/browser/smoke.spec.ts` 的任何断言。
- 颜色选择、自定义颜色、布尔按钮启用规则（`canBoolean`）保持不变。
- `normalizeProject()` 对既有图层、参考图、文字、旧图形保持原行为，既有 5 条迁移测试全绿。

## 8. 改动文件

| 文件 | 改动 |
|---|---|
| `mark-width.ts` | 新增：线宽范围、默认值、画笔/图形规范化、选中加粗 |
| `project.ts` | 三类标注 `width?`、`StoredMark.width?`、`MarkFields` 扩展、`normalizeProject()` 补齐标注与图形宽度 |
| `annotations.ts` | `markGeometry()` 读取自身宽度；箭头头部随宽度放大 |
| `board.ts` | 命中代理宽度跟随线宽；图形命中同步 |
| `scene.ts` | 标注经 `markGeometry()` 继承；图形线宽统一走 `normalizeShapeStrokeWidth()` |
| `geometry.ts` | `newShape()` 默认线宽 4 |
| `editor-drawing.ts` | 创建标注/图形时写入当前粗细 |
| `editor.ts` | 新增 `brushWidth` 与 `setBrushWidth()`，创建路径消费 |
| `editor-ui.ts` | 粗细滑块接线与回显；仅文本输入吞 Delete/Backspace，范围/颜色/select 不阻断画布快捷键 |
| `index.html` | 调色板新增「粗细」range + 数值 + 预览 |
| `style.css` | 桌面临宽分组、移动端两行布局、44px 触控高度 |
| `tests/mark-width.test.ts` | 11 条单测（默认值、旧草稿、非法值、旧图形脏数据、scene 消费、保存/重载、新建内容） |
| `tests/browser/pen-width.spec.ts` | 5 条 Playwright 用例（拖动滑块、键盘 + 旧草稿、图形持久化/换色、滑块焦点快捷键、移动端） |
| `docs/pen-width-report.md` | 本报告 |

## 9. 测试记录（实际执行）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ 通过（`tsc --noEmit`，无输出） |
| `pnpm test` | ✅ 8 个测试文件 / 108 条用例全部通过；`pretest` 成功写出 `wasm/pkg/sim_sketch_geometry.wasm`（95,584 bytes），环境提示 `wasm-pack` 不可执行并自动改用 `cargo build`（成功） |
| `pnpm test:e2e` | ✅ 20 条用例全部通过（chromium + webgpu projects，8.2s） |
| `pnpm build` | ✅ 成功；`dist/index.html` 11.43 kB、CSS 16.86 kB、JS 90.98 kB、wasm 95.58 kB |

补充说明：新 E2E 首次运行有 2 条因 `[data-tool="pen"]` 同时匹配画板与按钮而失败；改为 `button[data-tool="pen"]` 后，单独重跑通过。修复审查问题后全量 20/20 通过。

关键断言：

- 单测：旧草稿 pen/region/arrow 默认 4/3/5；`width: 0 → 1`、`99 → 24`、`Infinity/字符串 → 形状默认`；JSON 往返后宽度保留；滑块值 12 时新建 pen/region/arrow 均为 12，新建 line/rect/circle/arc 的 `strokeWidth` 为 14/24 等预期值。
- E2E：默认笔画 4px → 拖动滑块到 ≥10px → 新笔迹/矩形宽度等于滑块值 → 刷新后仍保留；换颜色不重置滑块；选中时 +2、Esc 后恢复自身宽度；旧草稿仍为 3/4/5；滑块/图层不透明度聚焦时 Delete、Ctrl+Z、Esc 正常。
- 移动端 390×844：调色板无横向溢出，颜色井计算样式为 `58px 58px 58px 58px`，滑块高度 44px，选中操作条完整落在视口内。

本地视觉核对（临时截图，未提交到仓库）：

- `/tmp/simsketch-desktop.png`：1440×900，调色板 689×109，颜色井与粗细滑块同一行，无溢出。
- `/tmp/simsketch-mobile.png`：390×844，调色板 249×183，颜色井 4 列，粗细行在下方，滑块 233×44，无溢出。

## 10. 已知取舍与后续

- 新画的几何图形默认线宽由 2.4 变为当前画笔值（默认 4），这是刻意的可见变化；旧图形保持原样。
- 同一档位下新旧内容观感不同：滑块停在 4 时，新圈选/箭头为 4，而旧草稿中的圈选/箭头仍为 3/5；这是「共用当前粗细」的产品口径，不是迁移遗漏。
- 箭头头部随宽度放大采用简单比例与 1/2 长度上限，极端短箭头仍以可读性优先，未做逐像素美术调优。
- 编辑弹窗修改已有标注线宽、记住上次使用的粗细、预设细/中/粗档位列为 P1，本期不做。
- 滑块值不持久化：每次打开回到 4px，符合“只改后续绘制”的产品口径。

## 11. 风险与回滚

| 风险 | 应对 |
|---|---|
| 旧草稿异常宽度 | `normalizeProject()` 与渲染层双重兜底：标注缺失/非法回退 4/3/5，图形缺失/非法回退 2.4，越界夹取 1–24，不抛错 |
| 粗线命中困难 | 命中代理取 `max(18/22, 可见线宽)`，E2E 在 12px 笔迹上点击选中 |
| 移动端布局遮挡 | 两行调色板 + 4 列色井 + 44px 滑块；390×844 E2E 校验无横向溢出与操作条越界 |
| 箭头 24px 观感 | 头部长度随宽度放大且不超过箭头一半；建议 QA 在 24px 长/短箭头上做视觉复核 |
| 回滚 | 移除 `#brush-width` 控件与 `Editor.brushWidth` 消费即可；已存 `width` 字段对回滚后代码是未知字段，会原样保留、不影响数据 |

## 12. 运行环境备注

视觉核对期间在 18767 端口启动了一个本地 Vite dev server（后台进程 `20261122T070426367Z-4b4217`）。未执行任何 daemon restart/stop 或进程终止命令；如不需要，由使用者手动关闭即可。
