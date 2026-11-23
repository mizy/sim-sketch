# SimSketch 编辑增强 · 实现报告

> 节点：实现元素缩放与旋转 / 实现复制粘贴与快捷键 / 视口缩放平移 / 统一磁吸 / Review 修复  
> 日期：2026-11-22  
> 范围：元素变换、复制粘贴与快捷键、画布视口、统一磁吸与全图适配；含 review MUST FIX / SHOULD FIX 的修复与真实验证记录。

## 1. 实现结果

### 1.1 交互

- 选中图形后，缩放手柄（`data-transform-handle="nw|n|ne|e|se|s|sw|w"`）与选中框一起按对象自身旋转角绘制：
  - 矩形、直线、路径、画笔、箭头：8 个局部轴手柄 + `rotate`；
  - 圈选：8 个局部轴手柄；按 product_spec §10 本轮不提供旋转手柄，旧草稿已有的 `rotation` 仍会正确渲染、命中、缩放和导出（P1 再做交互旋转）；
  - 圆：仅 4 个角手柄并强制等比，无旋转手柄；
  - 圆弧：仅 4 个角手柄并强制等比，三点整体旋转；
  - 文字：`mode=none`，不显示缩放手柄/旋转手柄，只允许拖动锚点；字号通过独立 `fontSize` 调整（8–96，默认 22）。
- 手柄视觉 9 CSS px；命中区桌面 24 CSS px、触屏 32 CSS px，按 `zoom` 折算，10% 与 800% 下屏幕尺寸一致。
- 拖动过程只更新 `drawing.preview`，不写项目、不写 undo；指针松开后提交一次；几何没有实际变化时不写空 undo。
- `Shift` 缩放等比；旋转默认自由角度，只有按住 `Shift` 才吸附 15°；操作条显示只读角度。
- `Esc` 取消本次变换，恢复原几何并保留选择。
- 操作条通过 `onPreview` 跟随对象移动；视口缩放、空格/中键平移、窗口 resize 也会重新投影，只有上方确实放得下时才为旋转手柄预留空间，避免遮住抓取点，也不回退既有“操作条在对象上方”的行为。
- 缩放手柄沿用 `Editor.snapAt()` / `Editor.snapPoint()` 统一捕捉并排除当前选择；旋转只用 `Shift` 15° 吸附，避免捕捉改变角度。

### 1.2 数据模型

- `RectShape.rotation?: number`：角度，单位为度，屏幕坐标系顺时针为正；`a/b` 仍是未旋转的局部包围盒。
- `RegionMark.rotation?: number`：旋转椭圆角度，单位同上；旧草稿没有该字段时保持轴对齐。
- 旧草稿不写入默认 `rotation`；只有显式存在该字段时才由 `normalizeProject` 收敛到 `(-180, 180]`，非法值移除。
- `TextMark.fontSize?: number`：独立字号（8–96，缺省按 22 渲染）；不新增旋转字段，文字几何缩放仍只移动锚点，保持可读、可编辑。

### 1.3 几何一致性

新增 `transform.ts`，纯函数实现：

- `selectionFrame` / `frameHandles` / `frameHandlePoint` / `frameScaleFactors` / `frameScaleMatrix`；
- `scaleMatrix` / `rotationMatrix` / `applyMatrix` / `isSimilarityMatrix`；
- `transformShape` / `transformMark`；
- `selectionBounds` / `snapAngle`。
- `TransformFrame.half` 只存对象真实半宽/半高，`handleHalf` 只负责把手柄外扩到可抓取尺寸；缩放 pivot、比例与最小尺寸都不读取 `handleHalf`。

旋转矩形按 `center + rotation + half` 建立有向 frame，缩放发生在局部坐标，再反旋转回世界坐标；`a/b` 保持未旋转局部框语义，矩形身份与 `rotation` 字段不会被静默改写。世界轴切变无法用矩形表达时返回 `null` 并提示，而不是转成 path。

矩形旋转严格按架构决策使用显式 `rotation`：

- `shapePath()`：有 rotation 时输出四角 `L` 路径；无 rotation 时保持原有 `H/V` 路径。
- `shapePoints()` / `shapeRings()`：返回旋转后的四角，布尔输入不再使用未旋转矩形。
- `snap.ts`：矩形端点/中点、圈选区域象限点都按旋转后的位置生成。
- `scene.ts`：矩形投影缓存包含 rotation，GPU/Canvas2D/SVG 三条渲染链路使用同一旋转环。
- `board.ts`：命中代理、SVG 导出、文字叠加都走同一 `shapePath` / 旋转环。
- `viewport.ts` 的内容适配对图形使用 `shapePoints`、对旋转圈选使用椭圆采样、对文字使用共享标签框，因此 F、首次载入与导出不会裁掉旋转或文字内容。
- 旋转矩形沿自身轴非等比缩放时仍保持 `type=rect` 与 `rotation`；对边锚点不动，导出/命中/布尔继续走旋转角点。
- 圆/圆弧非等比缩放会强制等比，并明确提示“仅支持等比缩放”，不会悄悄变成椭圆弧；圆半径下限取 `min(1, 原始半径)`，旧草稿中小于 1 的圆仍可平滑缩放；圆弧弦长最小 4，退化弧拒绝提交。
- 圈选区域按 `a/b` 局部轴独立缩放；带旧草稿 `rotation` 的圈选仍沿自身轴缩放并保持椭圆语义，但本轮不提供旋转手柄（产品规格明确列为 P1）。
- 最小尺寸按对象类型夹取：矩形/路径 4、圆直径 2、圆弧 4 模型单位，不允许翻转或零尺寸。
- 文字度量收敛到 `text-metrics.ts`：以 22px / 13px / 29px 为旧默认基线，按 `fontSize / 22` 统一缩放字符宽高、padding、命中框、变换包围盒与全图适配，避免各层错位。

### 1.4 画布视口

- `BoardViewport` 只持有 `zoom` 与 `center`，属于临时交互状态：不进入项目、不进入 undo、不写 IndexedDB 草稿。
- 视口宽高始终匹配画板 CSS 比例，`pixelsPerWorldUnit === zoom`，GPU / Canvas2D / SVG 三个后端共享同一 `RenderViewport`。
- 滚轮/触控板以指针下世界点为锚点缩放；`+ / -` 以画板中心缩放；`0` 回到 100%；`F` 适配全图；空格 + 左键或中键拖拽平移。
- 缩放范围 10%–800%。窗口 resize 时保持当前 zoom 与中心，不再 auto-fit；仅首次加载/新建/导入/示例使用基准画布取景。
- `exportJson` / `exportSvg` 使用独立的 `exportViewBox`（960×600 基准比例的内容适配），与实时 zoom/pan 无关。
- 视口变化会触发 `paint()`、内联文字重新定位、缩放读数刷新，并重新投影 `#selection-actions` / `#shape-actions`，因此缩放或平移后操作条仍贴在对象上方。
- 像素↔模型换算只在 `viewport.ts` 收口：`worldPerPixel()` / `screenConstant()` 供 snap、变换手柄与 Editor 的 14px 外扩量共用，`worldFromScreen` / `screenFromWorld` / `boardPoint` / `boardToScreen` 负责坐标；不使用整数取整，800% 下不会出现 8px 级跳动。
- 浮点策略：交互过程保留完整精度，避免缩放锚点漂移；几何路径输出与多边形落盘沿用既有三位小数；草稿中的坐标可能带浮点尾差，不影响命中、导出或再编辑。
- 触屏没有滚轮/空格：`max-width: 900px` 下保留紧凑缩放进/出、百分比与“适配”控件（不再隐藏），缩放与适配在手机/平板上仍可达；双指平移仍属后续增强，当前触屏平移未提供。

### 1.5 统一磁吸

- `snap.ts` 是纯领域模块：静态优先级为端点 → 中点 → 圆心 → 象限点 → 栅格；同距离时按稳定 ID/坐标 tie-break，不随图元顺序抖动。
- 阈值固定为 10 CSS px，按 `10 / zoom` 折算成世界半径，10% 与 800% 下手感一致。
- `SnapIndex` 以 64 世界单位格预筛候选，复用 `candidates` 数组并限制查询范围与候选上限；只在项目提交/加载时重建，`pointermove` 不重建。
- 绘制、移动、缩放统一走 `Editor.snapAt()` / `Editor.snapPoint()`，变换时排除当前选中对象，避免自吸附；旋转刻意不使用实体捕捉，只做 Shift 15° 吸附，避免捕捉改变角度。
- 按住 `Alt` 临时关闭磁吸；开关状态写入 `localStorage`，不进入项目/undo。命中类型由 `#snap-badge` 投影到屏幕，视口变化时同步重定位。

## 2. 本轮明确未做（后续）

- **精确角度 / 比例数值输入**：本轮只做拖拽 + 15° 旋转吸附，未提供“输入 30° / 输入 1.5 倍”的属性面板或 HUD。
- 交点捕捉候选仍按 `implement_snap` 的结论保留槽位，本轮未生成交点。
- 标注多选沿用现有模型：图形支持 Shift 多选；标注仍为单选。跨类型/多标注同时变换不在本轮范围。
- 文本没有随几何缩放的文字框；字号是独立样式字段，不随元素缩放改变。文字旋转仍属 P1。

## 3. 兼容性

- 旧草稿：无 `rotation` 的矩形/圈选区域渲染、命中、布尔、导出与改造前一致。
- `shapePath` 的无 rotation 矩形仍输出 `H/V`，既有几何测试断言不变。
- 画笔粗细、选中加粗、移动端调色板、图层面板、布尔、撤销重做、SVG/PNG/JSON 导出均未改写。
- 新增字段只进入项目数据；手柄、预览、捕捉命中都是临时状态，不进入草稿/undo。

## 4. 验证记录（真实执行）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm test` | 变换节点当时 14 个测试文件 / 166 个测试全部通过 |
| `pnpm test:e2e` | 变换节点当时 44 个测试全部通过；该节点未重跑全量 |
| `git diff --check` | 通过 |

新增 e2e 覆盖：

- 8 个局部轴手柄与 ≥24px 命中区；
- 角/边缩放 + 一次 undo；
- 自由旋转不被强制 15°，Shift 才吸附；
- `Esc` 取消不提交；
- 圆仅四角等比、无旋转手柄；
- 文字无缩放/旋转手柄，仅可拖动并保持可编辑；
- 圈选标注缩放 + undo；
- Delete 删除选中标注并可一次撤销；
- range 聚焦后 `0`/Esc/Delete 仍作用于画布；
- 图形多选整体缩放 + 一次 undo；
- 旋转矩形沿自身轴缩放后仍为 rect，刷新后 rotation 保持；
- 旋转圈选按 `F` 与刷新后完整可见；
- 滚轮缩放/空格平移后操作条仍贴在对象上方。

未执行 `git commit / push / checkout / reset`，未重启或终止任何 daemon。若外部 daemon 仍运行旧构建，需要手动决定是否重启（stale daemon）。

---

## 5. 复制粘贴与快捷键（实现节点）

### 5.1 交互与快捷键

| 快捷键 | 行为 |
|---|---|
| `Ctrl/⌘+C` | 复制选中图形与/或标注；保留类型、颜色、线宽、旋转、图层等属性 |
| `Ctrl/⌘+V` | 粘贴为新对象；连续粘贴依次偏移 +16 / +32 / +48 模型单位；粘贴后自动选中新对象 |
| `Ctrl/⌘+X` | 复制后删除，一次 undo 可恢复 |
| `Ctrl/⌘+D` | 原地复制（零偏移），一次 undo 可回退 |

- 粘贴结果立即处于选中态，四角缩放手柄与旋转手柄直接可用；拖动仍走既有的 `snapPoint()` 统一捕捉入口。
- `input` / `textarea` / `contenteditable` 内的 C/V/X/D 保持浏览器原生行为，画布不拦截。
- 编辑对话框、画布内联文字编辑激活时，快捷键整体让位给原生输入。

### 5.2 剪贴板与数据安全

- 新增 `clipboard.ts`：白名单解析 + 深拷贝 + 新 ID + 平移，未知字段不进入项目。
- 系统剪贴板采用 `text/plain` JSON payload（`format: sim-sketch/clipboard`），键盘粘贴优先用 async Clipboard API 读取真实内容；只有本应用 payload 才进入画布，普通文字/图片保持原生。
- `Ctrl+V` 不再用定时器抢先粘贴。每次按键登记手势：`readText` 先完成则由它处理，迟到的同次 `paste` 事件按“手势已粘贴”去重；`readText` 被拒时不抢先用旧对象，交给真实 `paste` 事件决定。剪贴板为空才回退内存副本。
- payload 带 `copiedAt` 时间戳与 `nonce`；连续复制 A/B 时，若系统剪贴板仍读到更旧的 A，优先使用刚写入内存的 B。`writeText` 串行化，避免异步写入乱序。
- 复制时 `navigator.clipboard.writeText` 失败不报错、不阻断；内存副本始终可用。
- 粘贴一律落到当前活动图层，payload 中的源图层 id 全部映射为目标图层；参考图层不可作为目标，自动回退到最后一个普通图层。
- 粘贴/剪切/原地复制全部走 `Editor.commit()`，因此统一进入 IndexedDB 草稿持久化与撤销/重做；复制本身不写历史。

### 5.3 验证记录（真实执行）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm test` | 剪贴板节点当时 14 个测试文件 / 166 个测试全部通过 |
| `pnpm test:e2e` | 四套件 27 个全部通过；`tests/browser/clipboard.spec.ts` 当时 11 个（本轮补到 13 个） |
| `git diff --check` | 通过 |

新增 e2e 覆盖：

- 图形连续粘贴 +16/+32 偏移、新 ID、样式与图层保留；
- 标注复制粘贴保留类型/线宽/图层并偏移；
- 粘贴后自动选中、可直接拖动，刷新后新对象仍在；
- 剪切 / 原地复制 / undo / redo 每次动作只产生一条历史；
- 切换活动图层后粘贴落到当前活动图层；
- `textarea` 与图层名输入框内复制粘贴不被画布接管；
- 兜底先粘贴后，迟到的 `paste` 事件只让位、不重复粘贴；
- 外部剪贴板 payload 变化后，连续粘贴偏移重新从 +16 开始。

## 6. Review 修复记录

| 问题 | 修复 | 验证 |
|---|---|---|
| MUST FIX 1：缩放/平移后操作条不跟随 | `Editor.afterViewportChange()` 统一刷新 `paint`、内联文字、缩放读数；`onViewportChange` 重新投影操作条，空格/中键平移也走该入口 | `tests/browser/viewport.spec.ts` 新增缩放 + 平移后操作条对齐断言 |
| MUST FIX 2：旋转圈选被 `F`/加载裁切 | `viewport.ts` 对带 `rotation` 的 region 使用 `ellipseRing` 采样；文字同时改用共享标签框 | `tests/viewport.test.ts` 旋转椭圆覆盖测试；viewport e2e 断言 `getBBox()` 完全落在 viewBox 内（F 与刷新各一次） |
| SHOULD FIX 3：文字度量重复 | 新增 `text-metrics.ts`，`board.ts` / `transform.ts` / `viewport.ts` 共用 | `pnpm typecheck`、全量单测 |
| SHOULD FIX 4：Ctrl+V 双通路时序缺口 | 当轮用独立手势队列 + 150ms 兜底；第五轮已改为 `readText` + 手势级去重，不再有定时器抢跑 | clipboard e2e：迟到 `paste` 只粘贴一次且只产生一条 undo |
| SHOULD FIX 5：报告缺失/失实 | 本报告补齐视口、磁吸、真实命令与数字；修正“内容适配自动覆盖旋转圈选”的错误描述 | 文档人工核对 |
| SHOULD FIX 6：移动端缩放不可达 | 小屏不再隐藏 `.zoom-control`，改为紧凑浮动控件；报告明确双指平移未提供 | 人工核对 CSS；既有移动端 palette e2e 通过 |
| SHOULD FIX 7：测试缺口 | 补充旋转矩形转 path + 刷新、旋转圈选 F/刷新、操作条跟随、rotation 归一化、外部 payload 偏移重置 | §4 / §5.3 的命令全部通过 |
| NIT 9：候选计数早退不重置 | `SnapIndex.resolve()` 入口先把 `candidateCount` 归零 | snap 单测全通过 |

## 7. 第二轮 Review 修复记录（2026-11-22）

### 7.1 阻塞项

| 问题 | 修复 | 验证 |
|---|---|---|
| MUST FIX 1：画笔采样把临时视口写进持久几何 | `editor-drawing.ts` 改为固定世界步长；新增纯函数 `appendPenSamples()`，`extendStroke()` 不再调用 `boardScreenDistance`，因此同一屏幕轨迹不会因绘制时 zoom 改变落盘精度。§17.2 进一步把步长收敛到 0.5 world，保证 800% 下 10 CSS px 的笔触仍被保留 | 新增 `tests/pen-sampling.test.ts`：10% / 100% / 800% 同一屏幕轨迹采样数一致，world 间距恒 ≥ 当前步长 |
| MUST FIX 2：外部剪贴板 payload 可写坏草稿 | `clipboard.ts` 增加 8MB 文本、5000 对象、20 万顶点、坐标 ±1e6、字符串 2000 长度上限；非有限/越界坐标拒绝；粘贴平移后再次过校验；本地草稿加载只做几何清洗、不按全局预算截断；新增提交前预算守卫，超预算新增被明确拒绝 | 新增 `tests/clipboard.test.ts` 7 条；`tests/project.test.ts` 改为验证超预算草稿原样加载并由 `projectWithinLimits()` 报告；`tests/browser/budget.spec.ts` 验证 5000 对象时新增被拒绝且无空 undo |

### 7.2 快捷键与可访问性

| 问题 | 修复 | 验证 |
|---|---|---|
| 图层名输入框内 `Ctrl/⌘+Z` 触发画布撤销 | `editor-ui.ts` 在画布撤销分支前增加 `editingText` 守卫，文本控件保留浏览器原生撤销 | clipboard e2e：粘贴后聚焦图层名输入框按 `Ctrl+Z`，画布对象数不变 |
| 工具栏/缩放按钮上 Space 被平移手势吞掉 | 移除 `.tool-group/.zoom-control` 特判；任何 `button/summary/a/label/[role=button]` 上的 Space 都优先原生激活，只有画布/空白区域进入平移 | viewport e2e：聚焦 `#zoom-in` 按 Space，缩放从 100% 变为 125% |
| 新建文字残留捕捉标记 | 文字工具 pointerdown 无论新建还是编辑都先 `clearSnap()` | 类型检查 + 既有文字编辑 e2e |

### 7.3 架构与测试缺口

- 剪贴板不再反向依赖交互层：`translatedMark()` 移到 `annotations.ts`，`editor.ts` 与 `clipboard.ts` 共用纯几何函数。
- 删除无调用死代码：`viewport.sceneViewport()`、`BoardViewport.screenDistance()`、`Editor.hasSelection`。
- `editor-text.ts` 内联编辑字号改用 `text-metrics.ts` 的 `textFontSize(mark)`，不再硬编码 22，并随 `fontSize × zoom` 缩放。
- 补测：缩放期捕捉（手柄拖到另一图形端点时 badge 显示“端点”且落点靠近端点）、Shift 等比缩放、文字标注变换后仍可双击编辑、源图层删除后的粘贴回退、画笔跨 zoom 采样密度。
- **未拆分 `editor.ts`**：本轮定位为 review 修复，拆分手势状态机属于后续重构；在当前节点改动会扩大回归面，因此保留并在 P1 技术债中跟踪。
- **范围可追溯性**：多选整体变换与中键平移按用户后续追加要求实现；圈选交互旋转仍按 product_spec §10 保持在 P1，仅保留旧草稿 `rotation` 的渲染/缩放兼容。此前报告中“旋转圈选已实现”的描述已修正。

### 7.4 验证记录（真实执行）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm test` | 第三轮当时 14 个测试文件 / 166 个测试全部通过 |
| `pnpm test:e2e tests/browser/clipboard.spec.ts tests/browser/viewport.spec.ts tests/browser/transform.spec.ts tests/browser/snap.spec.ts` | 第三轮当时 27 个测试全部通过 |
| `git diff --check` | 通过 |

未执行 `git commit / push / checkout / reset`，未重启或终止任何 daemon。当前 `dist/` 未重新构建；若外部 daemon 仍运行旧构建，需用户手动决定是否重建/重启。

## 8. 第三轮 Review 修复记录（2026-11-22）

### 8.1 MUST FIX

| 问题 | 修复 | 验证 |
|---|---|---|
| 损坏草稿中的未知/空 shape 会让 `normalizeProject` 抛错并回退 demo | `geometry.ts` 的 `sanitizeShapeGeometry` 增加 `default: return null`；`project.ts` 先过滤非对象 marks/shapes，再进入归一化与预算；`shapeVertexCount` 增加 `default: 0` | `tests/project.test.ts` 新增损坏草稿用例：未知 type 与 null 被丢弃，合法图形保持原引用，二次归一化幂等 |
| `SnapIndex.resolve` 对 Infinity/超大浮点/Infinity 阈值可能死循环 | 入口统一校验指针有限且在几何硬上限内；格子索引必须为 `Number.isSafeInteger`；`snapThresholdWorld` 拒绝非有限/负阈值，并给有限阈值加上世界上限 | `tests/snap.test.ts` 新增 Infinity、NaN、1e308、Infinity 阈值用例；原空间索引与阈值用例继续通过 |
| 图层名输入框/内容可编辑区按 Escape 会清空画布选择 | `editor-ui.ts` 的 Escape、Space、Enter、F/0/+/- 分支只检查文本类 `editingText`；range/select/color 继续走画布快捷键 | clipboard e2e：图层名输入框按 Escape 保持选择；transform e2e：`#brush-width` 聚焦后 `0`/Delete 仍生效 |
| 复制普通文字/图片后 Ctrl+V 会误粘贴内存旧对象并拦截原生粘贴 | `pasteSelection` 区分“真实剪贴板内容”与“键盘兜底”：非本应用文本返回 false；图片/富文本保持原生行为；只有空剪贴板或没有真实 paste 事件才回退内存副本；`pasteIndex` 仅在成功添加对象后递增 | clipboard e2e：普通文字与图片 paste 均不新增对象且不 `preventDefault`；既有连续粘贴/迟到事件/空剪贴板兜底用例继续通过 |

### 8.2 SHOULD FIX / 防御性修补

- 变换预览的选中框复用 gesture 开始时的 `previewFrame`，pointermove 不再重新扫描选择包围盒；几何预览仍按需变换当前选择（大路径为 O(V)），报告不再声称只变换 4 个角点。
- `viewport.ts` 的 arc 内容适配改用 `arcPoints()` 采样弧，`F`/导出不再只取三个控制点而裁掉弧的鼓出部分。
- `clipboard.ts` 的外部颜色只接受 `#rrggbb` 并转小写；`url(...)`、`javascript:`、超长字符串一律回退/丢弃。
- 报告中的测试数字统一为当前工作区最终实测值。

## 9. 第四轮 Review 修复记录（2026-11-22）

### 9.1 MUST FIX

| 问题 | 修复 | 验证 |
|---|---|---|
| 旋转无条件吸附 15° | `editor.ts` 只在 `event.shiftKey` 时调用 `snapAngle`；自由旋转保留原始角度 | transform 单测/ e2e：自由旋转不是 15° 整数倍，Shift 才吸附 |
| 旋转矩形非等比缩放被改成 path | 新增 `TransformFrame`（center/rotation/half）与 `frameScaleMatrix`，在局部坐标缩放后反旋转；`transformRect` 对切变返回 `null`，不静默改 type | `tests/transform.test.ts` 与 transform e2e：旋转矩形缩放后仍为 rect、rotation 与对边锚点保持 |
| 仅 4 角手柄且命中区 22px | `TransformHandle` 扩展为 `nw/n/ne/e/se/s/sw/w/rotate`；overlay 按 frame 旋转绘制 8 手柄，命中区桌面 24px、触屏 32px | transform e2e：9 个手柄可见，边手柄命中区 ≥24px |
| 圆/文本手柄策略错误 | 圆/圆弧 `uniform` 且无旋转；文本 `mode=none` 不生成缩放手柄；pointerup 以手势 `moved` 标志拦截无变化提交，不再 JSON 序列化全几何 | transform e2e：圆无 rotate/边手柄；文本无手柄、仅拖动、仍可编辑；undo 步数正确 |
| 最小尺寸与退化保护缺失 | frame 按对象类型夹取最小尺寸（矩形/路径 4、圆直径 2、圆弧 4）；`validTransformedShape` 拒绝半径 <1、弦长 <4、共线弧 | `tests/transform.test.ts` 最小比例用例；contract 在提交前兜底 |
| Delete 不删标注 | `Editor.deleteSelection()` 同时清理图形多选与单个标注，仍只占一步 undo | transform e2e：Delete 删除圈选，Ctrl+Z 一次恢复 |
| range/select 焦点吞快捷键 | `editor-ui.ts` 仅对 `editingText` 让位；range/select/color 继续走画布快捷键（Esc、0、Delete、F、+/- 等） | transform e2e：`#brush-width` 聚焦后 `0`/Esc/Delete 仍生效；既有 pen-width 焦点用例通过 |
| 粘贴目标图层与规格相反 | `PasteOptions` 改为单一 `targetLayerId`；Editor 统一映射到当前活动图层，参考图层回退最后一个普通图层 | clipboard 单测：所有对象落到 target；clipboard e2e：切换活动图层后粘贴落新图层 |

### 9.2 同步修正

- 旋转操作条新增只读角度读数（仅旋转手势期间显示，避免撑宽操作条）。
- 缩放入口步进统一为 1.2×（产品 AC4）。
- 原先锁定错误行为的测试已重写：自由旋转、旋转矩形保持 rect、文本无手柄、圆无旋转、range 焦点快捷键、粘贴目标图层。

### 9.3 验证记录（本轮真实执行）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm test` | 第四轮当时 14 个测试文件 / 170 个测试全部通过 |
| `pnpm test:e2e` | 第四轮当时 54 个通过，1 个既有 WebGPU 用例跳过（无失败） |
| `git diff --check` | 通过 |

未执行 `git commit / push / checkout / reset`，未重建 `dist/`。本轮为验证启动了本地 Vite dev server（端口 18766），未重启或终止任何 daemon；若外部 daemon 仍使用旧构建，需用户手动决定是否重启。

## 10. 第五轮 Review 修复记录（2026-11-22）

### 10.1 MUST FIX

| 问题 | 修复 | 验证 |
|---|---|---|
| 小对象缩放锚点与最小尺寸被选中框 padding 污染 | `TransformFrame` 拆分真实 `half` 与仅用于手柄的 `handleHalf`；`frameScaleFactors` 以 pointerdown 真实落点为比例起点；pivot/clamp 只读真实 half；提交前按对象真实宽高/线长复核最小尺寸 | `tests/transform.test.ts` 新增 10×4 小矩形：按下不跳变、nw 固定、收缩到 4×4；`tests/browser/transform.spec.ts` 新增同场景 e2e |
| 草稿规模上限在 load/commit 静默丢数据 | `normalizeProject` 不再按 5000/200k 预算截断；加载超预算草稿原样保留并提示；`Editor.commit()` 仅在规模继续增长时拒绝并显示明确 notice，删除/清理旧草稿仍允许 | `tests/project.test.ts` 验证加载不截断；`tests/browser/budget.spec.ts` 验证 5000 对象再加 1 个被拒绝且无空 undo |

### 10.2 SHOULD FIX / 同步修正

| 问题 | 修复 | 验证 |
|---|---|---|
| 粘贴时序与系统剪贴板竞态 | 移除 150ms 定时器兜底；键盘粘贴先 `readText`，手势级认领同次 `paste` 事件；外部普通文本优先原生；payload 增加 `copiedAt`/`nonce`，旧系统剪贴板不覆盖更新的内存副本；`writeText` 串行化 | clipboard e2e：延迟同次事件只粘贴一次；复制画布后外部普通文本不被旧对象吞掉 |
| 变换预览性能声明失实 | 删除未使用的 `transformBounds` 与 JSON 全几何比较；报告改为如实描述 `previewFrame` 复用与 O(V) 几何预览 | `pnpm typecheck` / 单测 / transform e2e |
| 标注旋转角度不可见 | `#selection-actions` 增加 `#selection-angle`，`renderAngle()` 同时更新图形与标注读数 | transform e2e：箭头旋转时标注操作条显示非 0° 角度 |
| 像素↔模型换算分散 | `viewport.ts` 新增 `worldPerPixel()` / `screenConstant()`；snap、overlay、Editor 统一调用 | 单测 + 四套 e2e |
| 死代码/重复实现 | 删除 `matrixAngleDegrees` / `isAxisAligned` / `transformBounds` / `handlePoint` / `rotationHandlePoint` / `scaleFactors`；矩形与圈选共用 `transformAxialBox`；剪贴板与项目共用 `projectWithinLimits` | `pnpm typecheck` 无未使用符号 |
| 文档自相矛盾 | 修正文字字号、旋转捕捉、像素换算、测试数量、旧预算描述与 `transformBounds` 声明 | 文档人工核对 |

### 10.3 验证记录（本轮真实执行）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm test` | 14 个测试文件 / 172 个测试全部通过 |
| `pnpm exec playwright test tests/browser/transform.spec.ts tests/browser/clipboard.spec.ts --project=chromium` | 25 个测试通过（含新增小对象与外部文本竞态用例） |
| `pnpm exec playwright test tests/browser/budget.spec.ts --project=chromium` | 1 个测试通过 |
| `pnpm test:e2e` | 60 个测试全部通过 |
| `pnpm build` | 通过（39 modules，`dist/` 已更新） |

未执行 `git commit / push / checkout / reset`；未终止或重启任何 daemon。`dist/` 已在本次修复后重建；若外部 daemon 仍运行旧构建，需用户手动决定是否重启（stale daemon）。

## 11. 第五轮 Review 修复记录（2026-11-22）

### 11.1 阻塞项

| 问题 | 修复 | 验证 |
|---|---|---|
| MUST 1：坐标安全边界在 commit/load 静默删对象或改几何 | `geometry.ts` 区分严格外部校验与本地迁移：新增 `clampedPoint()`，有限越界坐标夹取并保留对象/顶点数，只有非有限坐标才移除；`normalizeProjectWithRepair()` 返回 `clamped/dropped/droppedObjects` 报告，`Editor.load/apply` 显示 `PROJECT_REPAIR_NOTICE`；`boardPoint()` 与视口 pan/zoom 中心在输入层夹到世界硬上限 | `tests/project.test.ts`：1e6+1 rect/path 保留且顶点数不变、1e308 夹取、NaN 移除并报告；`tests/browser/coordinate-safety.spec.ts`：旧草稿加载提示 + 刷新仍保留、边界外拖动后可恢复 |
| MUST 2：高密度 path 的 snap feature 展开栈溢出 | `snapEntities()` 改为逐项 `push`；新增 `MAX_SNAP_FEATURES=50k`、`MAX_PATH_SNAP_RINGS=512`、`MAX_PATH_SNAP_FEATURES=4096`；多环 path 按步长均匀抽样并保留最后一个 ring | `tests/snap.test.ts`：3 万 ring 路径生成受控 feature 且 `SnapIndex.rebuild` 正常；`coordinate-safety` e2e：粘贴 9 万顶点 payload 后保存、渲染、缩放继续可用，无 pageerror |

### 11.2 同步修复的 SHOULD

- Space 原生控件判定扩展到 `select/input/textarea/[contenteditable]`，下拉框聚焦时不再触发画布平移；新增 viewport e2e。
- 旧草稿半径 <1 的圆按 `min(1, 原始半径)` 作为缩放下限，不再只有放大两倍后才能通过提交校验。
- `exportJson` 把 `...project` 放到派生 `width/height/viewBox` 之前，外部/旧字段不能覆盖导出视口。
- `pasteGestures` 增加时间戳、2 秒过期与容量上限，`readText` 无 `paste` 事件时不会长期堆积并吞掉后续原生粘贴。
- `transform.ts` 的 `selectionBounds` 同步改为逐点追加，避免 20 万顶点的路径/画笔在多选包围盒处再次触发 `push(...大数组)` 栈溢出。
- 修正报告中的圈选口径：按 product_spec §10，圈选交互旋转仍属 P1；旧草稿 `rotation` 仅做渲染/命中/缩放/导出兼容。报告不再声称“旋转圈选已实现”。
- 删除无调用方的 `Editor.selectionCanRotate()`；`TOOL_MESSAGES.select` 改为“8 个局部轴手柄”。

### 11.3 明确未在本轮处理

- 变换预览仍按 O(V) 复制 path/pen 点集；200k 顶点预算下的大路径预览优化属于独立性能重构，不在本次阻塞修复范围。
- `editor.ts` 仍超过 500 行；手势/剪贴板/视口控制器拆分为后续架构任务，本轮避免扩大回归面。

### 11.4 验证记录（本轮真实执行）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm test` | 14 个测试文件 / 175 个测试全部通过 |
| `pnpm test:e2e tests/browser/coordinate-safety.spec.ts tests/browser/viewport.spec.ts tests/browser/clipboard.spec.ts tests/browser/snap.spec.ts tests/browser/transform.spec.ts tests/browser/budget.spec.ts --project=chromium` | 39 个测试全部通过 |
| `pnpm test:e2e` | 63 个测试通过，1 个 WebGPU 回退用例按环境跳过，0 失败 |
| `pnpm test:e2e tests/browser/webgpu-fill.spec.ts --project=webgpu` | 5 个测试全部通过（补跑被跳过的回退用例） |
| `git diff --check` | 通过 |

未执行 `git commit / push / checkout / reset`；未终止或重启任何 daemon。本轮未重建 `dist/`，若外部 daemon 仍运行旧构建需用户手动决定是否重启（stale daemon）。

## 12. 改动文件清单

按职责分组（含与四组能力共存的工作区画笔粗细/操作条改动）：

| 能力 | 文件 |
|---|---|
| 视口缩放/平移 | `viewport.ts`、`editor.ts`、`editor-ui.ts`、`index.html`、`style.css` |
| 统一磁吸 | `snap.ts`（新增）、`editor.ts`、`editor-drawing.ts`、`board.ts`、`editor-ui.ts` |
| 元素缩放/旋转 | `transform.ts`（新增）、`transform-overlay.ts`（新增）、`editor.ts`、`editor-types.ts`、`editor-text.ts`、`geometry.ts`、`scene.ts`、`annotations.ts`、`project.ts`、`export.ts` |
| 复制粘贴/快捷键 | `clipboard.ts`（新增）、`editor.ts`、`editor-ui.ts`、`annotations.ts`、`project.ts` |
| 箭头大小/文字字号（E 组） | `mark-style.ts`（新增）、`text-metrics.ts`、`project.ts`、`annotations.ts`、`board.ts`、`scene.ts`、`editor.ts`、`editor-text.ts`、`editor-drawing.ts`、`editor-ui.ts`、`index.html`、`style.css` |
| 共享度量/渲染 | `text-metrics.ts`（新增）、`board.ts`、`viewport.ts`、`scene.ts` |
| 画笔粗细共存 | `mark-width.ts`（新增）、`editor-drawing.ts`、`editor-ui.ts`、`style.css`、`index.html` |
| 单测 | `tests/transform.test.ts`、`tests/snap.test.ts`、`tests/clipboard.test.ts`、`tests/viewport.test.ts`、`tests/pen-sampling.test.ts`、`tests/mark-width.test.ts`、`tests/mark-style.test.ts`（新增）、`tests/polygon.test.ts`、`tests/project.test.ts` |
| 浏览器测试 | `tests/browser/transform.spec.ts`、`tests/browser/snap.spec.ts`、`tests/browser/clipboard.spec.ts`、`tests/browser/viewport.spec.ts`、`tests/browser/mark-size.spec.ts`（新增）、`tests/browser/pen-width.spec.ts`、`tests/browser/polygon.spec.ts`、`tests/browser/coordinate-safety.spec.ts`、`tests/browser/budget.spec.ts`、`tests/browser/smoke.spec.ts` |
| 文档 | `docs/edit-enhancement-report.md`、`docs/pen-width-report.md` |

> 修正上一版失实清单：本任务没有修改 `renderer.ts`、`svg-renderer.ts`、`tests/geometry.test.ts`，已从改动文件清单移除。工作区同时存在其他未提交的橡皮擦/手绘拟合/无限画布改动，本报告不把它们的文件与行为算作本任务交付。

数据模型决策见 §1.2：`RectShape.rotation?` / `RegionMark.rotation?` 为可选度数字段，`a/b` 保持未旋转局部包围盒；裁剪预览、捕捉命中、视口 zoom/center 都是临时状态，不进入项目或 undo。快捷键表见 §5.1。

## 13. 性能实测：500 / 2000 图元 pointermove 磁吸

测量入口与 `pointermove` 实际使用的内核一致：`SnapIndex.resolve()`（`Editor.snapAt()` 直接调用）。环境 Bun 1.3.14 / macOS，`scale=1`、`thresholdPx=10`、无栅格；每 500 / 2000 个圆（每圆 4 个端点/中点/圆心/象限特征），先预热 20000 次，再跑 5 轮 × 20000 次，指针落在图元端点附近 10px 内。

| 图元数 | 索引特征数 | 索引重建 | 5 轮平均耗时 | 中位轮均值 | p50 | p95 | p99 |
|---:|---:|---:|---|---:|---:|---:|---:|
| 500 | 2500 | 1.16 ms | 0.351 / 0.203 / 0.183 / 0.146 / 0.152 µs | 0.183 µs | 0.167 µs | 0.375 µs | 1.208 µs |
| 2000 | 10000 | 1.97 ms | 0.216 / 0.193 / 0.207 / 0.241 / 0.177 µs | 0.207 µs | 0.167 µs | 0.292 µs | 0.541 µs |

结论：两次测量 p99 均低于 1.3 µs，约为 60fps 单帧预算 16.7 ms 的万分之一；图元从 500 增至 2000 时耗时没有随总数增长（局部查询只扫描约 4 个候选），符合空间索引预期，可接受。极少数 max 样本（143 µs / 1248 µs）来自 V8 GC/调度抖动，不影响 p99。该数字只覆盖捕捉纯计算，不包含浏览器重绘；`overlay-cache.spec.ts` 的 2000 节点复用与全量 e2e 已覆盖渲染路径无 pageerror/明显卡死。

## 14. 最终回归验证（QA 节点真实执行，2026-11-22）

| 命令 | 真实结果 |
|---|---|
| `pnpm typecheck` | 通过，`tsc --noEmit` 无输出，exit 0 |
| `pnpm test` | 14 个文件 / 175 个测试全部通过（含 transform 16、snap 17、clipboard 8、viewport 11、project 11、mark-width 11），耗时 872 ms |
| `pnpm test:e2e` | 64 passed（chromium + webgpu），17.1 s，0 失败；包含复制粘贴/视口/变换/磁吸/画笔粗细/布尔/图层/草稿/坐标安全/预算全部套件 |
| `pnpm build` | 通过：39 modules，`dist/assets/index-BvqMmUkg.js` 138.21 kB（gzip 44.79 kB），exit 0 |
| `pnpm lint` | 不可执行：`package.json` 无 lint 脚本/lint 依赖，本仓库未配置 lint |

验收点对应：纯几何单测覆盖缩放/旋转矩阵、旋转矩形 path/points/包围盒、圆等比缩放、捕捉优先级与 10px 阈值；浏览器测试覆盖 `Ctrl/⌘+C/V` 偏移与刷新持久化、缩放后点选/拖动、8 手柄缩放与旋转 + Esc + 单次 undo、缩放视口磁吸与 badge、文本控件原生 C/V。现有画笔粗细、操作条跟随、布尔、图层、导出、草稿迁移/预算/坐标安全测试均保持通过。未执行 `git commit / push / checkout / reset`，未重启或终止任何进程；`dist/` 已由本次 build 更新，若外部 daemon 仍在运行旧构建需用户手动决定是否重启（stale daemon）。

## 15. 橡皮擦 / 手绘拟合 / 无限画布（2026-11-22）

### 15.1 橡皮擦

- **UI 位置**：左侧工具栏「画笔」下方的「橡皮擦」；快捷键 `E`。选中后按钮 `aria-pressed=true`、背景高亮，画布光标隐藏并显示跟随指针的圆形擦除范围（`#eraser-cursor`，尺寸实时反映擦除直径）。
- **尺寸**：底部调色板出现独立的「橡皮擦」滑块（`#eraser-width`，1–24，默认 12）。复用 `mark-width.ts` 的 `normalizeBrushWidth` 与同一范围常量，但滑块值与 `#brush-width` 完全独立。
- **持久化**：`localStorage["sim-sketch-eraser-width"]`，与画笔粗细互不覆盖；刷新后恢复。
- **命中粒度**：`eraser.ts` 的 `hitTargets()` 对整个对象做世界坐标距离测试，命中即删除整条对象，不产生新几何：
  - 画笔/直线/箭头/圆弧/路径/矩形边：到折线（闭合形状含最后一段）的距离 ≤ 擦除半径 + 自身线宽/2；
  - 圆：`|pointer 到圆心距离 − 半径|` ≤ 半径 + 线宽/2；
  - 圈选：椭圆内部或边界带均命中；
  - 文字：标签框（`textLabelBox`）外扩擦除半径。
  - 擦除半径 = `eraserWidth / 2 / zoom`，10% 与 800% 下屏幕上的擦除手感一致。
- **连续拖动**：`eraseAlong()` 以 `max(0.5, 半径 × 0.5)` 世界单位插值采样，快速拖动不会漏擦；单次采样上限 4096，避免异常输入拖垮主线程。
- **undo**：拖动期间只写入 `EraseSession` 并从预览项目排除，不调用 `commit`；`pointerup` 时若集合非空才提交一次，因此一次拖动 = 一步 undo。`erasedProject()` 在空集合时返回 `null`，空擦不写历史。
- **数据结构**：不新增持久字段；命中/删除完全基于现有 `Project.shapes` / `Project.marks`。

### 15.2 手绘自动拟合

- **UI 位置**：底部调色板「手绘拟合」竖列：
  - `#pen-fit`：关闭 / 直线拟合 / 曲线拟合；
  - `#pen-curve`：曲线模式下选二次贝塞尔 / 三次贝塞尔。
- **持久化**：`localStorage["sim-sketch-pen-fit"]`（`off|line|curve`）与 `localStorage["sim-sketch-pen-curve"]`（`quadratic|cubic`）；刷新后恢复，默认关闭 / 三次。
- **作用范围**：只在 `pointerup` 且当前草稿是 `shape === 'pen'` 时调用 `fitPenMark()`；直线/矩形/圆/圆弧/多边形/箭头完全不受影响。
- **算法（`pen-fit.ts`）**：
  1. RDP 简化，容差 `max(0.75, 笔宽 × 0.35)` 世界单位；
  2. 端点固定，内部点用累计弦长作为初始 `t`；
  3. 直线：首尾保留，最小二乘方向用于残差评估；
  4. 二次/三次贝塞尔：固定首尾求控制点，随后把内部点投影回曲线重算 `t`，迭代 3 次（弦长参数与真实参数有偏差，重投影可显著降低误差）；
  5. 误差阈值 `max(1.5, 笔宽 × 0.9, 总长 × 0.02)`；超过阈值原样保留原始手绘（返回同一 `PenMark` 引用）。
- **数据结构**：新增 `bezier.ts`：
  - `BezierSegment = line | quadratic | cubic`（绝对坐标，含 `end` 与 1/2 个控制点）；
  - `BezierPath = { start, segments[] }`；
  - `PenMark.curve?: BezierPath`（可选，旧草稿不受影响）；`PenMark.points` 同步保存 `sampleBezierPath()` 的自适应离散点。
- **全链路**：
  - 渲染：GPU/Canvas2D 消费离散点；SVG 预览/导出对 `curve` 输出原生 `M/Q/C`；
  - 命中/包围盒：继续使用 `points`，因此与旧逻辑一致；
  - 移动/缩放/旋转/剪贴板：`transformBezierPath()` 同步变换控制点；
  - 序列化：IndexedDB 草稿、剪贴板、JSON 导出自动保留 `curve`；
  - 规范化：本地草稿对曲线坐标做夹取，结构损坏时只丢弃曲线、保留原始 `points`；外部剪贴板严格拒绝越界控制点。
- **已知限制**：一条手绘笔只拟合一段贝塞尔；复杂 S 形/多段曲线误差超标时按设计保留原始手绘。直线模式下首尾点严格固定，不做端点投影。

### 15.3 无限画布

- **平移**：空格 + 左键、中键拖拽、选择工具下触屏单指在空白处拖拽；视口中心独立于模型坐标，允许到 ±1e9（double 精度下 800% 仍远小于 1px），不写项目/草稿/undo。
- **内容适配**：`fitWorldRect(project, cssW, cssH, includeBase)` 只框内容包围盒 + 24 世界单位留白，并保持当前窗口比例；显式 `F` 与导出使用 `includeBase=false`，因此 `-5000,-5000` 的内容会就地取景，不回到原点。首屏/新建传 `includeBase=true`，把 960×600 基准画布一起纳入，保持示例观感。
- **导出**：SVG/JSON 的 `viewBox` 均来自内容包围盒（基准 960:600 比例），与实时 zoom/pan 无关；`width/height` 由 viewBox 向上取整派生，空项目回退 960×600。
- **背景/网格**：SVG 回退层按当前 `RenderViewport` 的 `x/y/width/height` 绘制底色与网格，不再使用固定 `-10000..10000` 窗口；Canvas2D/WebGPU 原本就按视口绘制。导出快照按导出 viewBox 铺满背景。
- **重置入口**：`0` / 百分比按钮回到 100%（保留当前中心）；`F` / 「适配」重新按内容取景。需要回到基准画布时先 `新建空白` 或按 `F` 后再平移。
- **精度**：交互全程不使用整数取整；`boardPoint()` 依赖 `getScreenCTM()`，800% 下不会出现台阶。模型坐标硬上限仍为 ±1e6（`MAX_COORDINATE`），视口中心可到 ±1e9。
- **已知限制**：触屏单指平移只发生在选择工具的空白区域；绘制工具下单指仍用于绘图。双指缩放/平移未新增。

### 15.4 本轮新增验证

| 命令 | 真实结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm test` | 17 个文件 / 190 个测试全部通过 |
| `pnpm test:e2e` | 75 passed + 1 skipped（webgpu 内核失败回退用例按环境跳过），0 失败 |

新增测试：

- `tests/pen-fit.test.ts`：直线点集→line、二次/三次曲线点集→对应贝塞尔、噪声点集保留原始手绘、RDP 端点固定、误差阈值自适应。
- `tests/eraser.test.ts`：整条命中、空白不命中、一次会话去重、空擦返回 `null`（不写 undo）、拖动插值连续命中。
- `tests/browser/eraser-fit.spec.ts`：`E` 激活态/尺寸控件、一次拖动擦两条 + 一步 undo、空擦后撤销回到上一条真实绘制、拟合设置刷新持久化、line 曲线导出与刷新保留。
- `tests/browser/infinite-canvas.spec.ts`：中键平移至约 `-5500` 后绘制、负坐标选中与变换手柄、`F` 只框内容、背景铺满 viewBox、JSON/SVG 导出按内容包围盒。
- `tests/viewport.test.ts`：新增负坐标远内容包围盒与屏幕↔世界往返测试；旧的“F 必须包含原点”断言改为“只框内容且完整包含对象”。


## 15. 产品验收返工修复（2026-11-22）

本轮只做聚焦修复，未改变 `viewport` / `snap` / `transform` / `clipboard` 的模块边界与既有数据模型决策。

### 15.1 阻塞项：箭头大小与文字字号（E 组）

| 验收问题 | 修复 | 验证 |
|---|---|---|
| 无 `ArrowMark.size` / `TextMark.fontSize`，新建、选中修改、持久化、导出、8–96 夹取全部缺失 | 新增 `mark-style.ts` 作为唯一样式真源：`size` / `fontSize` 均为 8–96 整数；箭头默认 21，文字默认 22；旧箭头缺字段继续走旧公式，旧文字缺字段按 22 渲染 | `tests/mark-style.test.ts` 6 条：旧公式锚点（线宽 5→21、线宽 24→43.2）、显式 size 优先线宽、杆长/2 夹取、文字 22→44 度量、非法值夹取与幂等 |
| 画布、内联编辑框、命中框、选中框、全图适配各自一套字号 | `text-metrics.ts` 按 `fontSize / 22` 统一缩放字符宽高、padding、hit box 与四角；`editor-text.ts` 内联框字号改为 `fontSize × zoom`；`viewport.ts` / `transform.ts` 继续消费同一 `textLabelCorners` | `mark-size` e2e：48→8 后画布 `font-size`、操作条、JSON、刷新一致；内联编辑框字号 = `fontSize × zoom` |
| 新建箭头/文字没有当前尺寸入口，选中已有对象不能改 | 调色板新增「箭头大小」「字号」仅当前工具可见；选中箭头/文字时操作条出现对应滑块；箭头编辑弹窗同步提供 `size`；`input` 实时预览，`change` 提交且只占 1 步 undo | `mark-size` e2e：新建箭头 40、选中改 60、编辑弹窗回显 60、刷新保留；文字 48→8 刷新保留 |
| SVG/PNG/JSON 导出不一致 | 画布与 `drawBoard` 共用 `markGeometry` / `textLabelBox`，SVG 导出直接继承 `font-size` 与箭头头部；JSON 原样携带 `size` / `fontSize` | `mark-size` e2e 断言 JSON 字段、SVG `font-size="8"`；PNG 走同一 SVG 快照路径 |

### 15.2 用户可感知缺口

| 问题 | 修复 | 验证 |
|---|---|---|
| 10% 缩放下图形命中代理仅约 1.8 CSS px | `board.drawOverlay` 接收 `hitScale = 屏幕单位/世界单位`；命中代理宽度改为 `max(18 CSS px, 自身线宽)`，缩放时只更新命中宽度不重建 path；文字额外生成 8 CSS px 外扩命中框 | `viewport` e2e：10% 下点在直线上方 6px 仍能选中；`mark-size` e2e：10% 下文字仍可点选 |
| resize 重新 auto-fit，丢失用户 zoom/center | `BoardViewport.resize()` 默认只应用当前 zoom/center；仅首帧尺寸未知时补一次 fit；首次加载/新建仍使用基准取景 fit | `viewport` e2e：窗口 1280×720 → 1000×700 后缩放读数、视图中心不变 |
| `readText` 被拒没有提示 | 键盘粘贴读取失败时，等同一按键的 `paste` 事件一个事件循环；仍未处理则回退内存副本并提示「剪贴板不可用，已在本标签页内粘贴」，且与目标图层提示合并而不是覆盖 | `clipboard` e2e：覆写 `readText` 为 reject，仍粘贴成功并显示提示 |
| 非法 SimSketch payload / 参考图层回退无提示 | 识别明显为本应用但解析失败的文本，提示「剪贴板内容不是 SimSketch 对象。」；参考图层粘贴回退到最后一个普通图层并在提示中写出目标图层名 | `clipboard` e2e：畸形 payload 不新增对象且提示精确；参考图层粘贴落到「图层 1」并提示 |
| 圈选自由绘制仍参与吸附，与 US-05 AC5 相反 | 圈选与画笔的创建/拖动全程使用 raw point；箭头、直线、矩形、圆、圆弧与对象移动继续吸附 | `snap` e2e：圈选/画笔在已有端点旁按下与拖动时 `#snap-badge` 始终隐藏；既有端点/中点/缩放/移动吸附用例继续通过 |
| `#snap-badge` 对读屏不可见 | 移除 `aria-hidden`，改为 `role="status"` + `aria-live="polite"` | 人工核对 DOM；不影响 e2e |
| 无选择时 `Ctrl/⌘+C` 仍被画布拦截 | `clipboardContent()` 对空选择返回 `null`，复制快捷键不再 `preventDefault`，交回浏览器原生复制 | `clipboard` e2e：body 无选择按 `Ctrl+C` 时 `defaultPrevented === false` |

### 15.3 本轮真实命令结果

| 命令 | 真实结果 |
|---|---|
| `pnpm typecheck` | exit 0，`tsc --noEmit` 无输出 |
| `pnpm test` | 17 个测试文件 / 190 个测试全部通过（新增 `mark-style.test.ts` 6 条、clipboard 样式复制 1 条） |
| `pnpm test:e2e` | 77 passed、0 failed（chromium + webgpu）；含 `mark-size.spec.ts`、`viewport.spec.ts`、`clipboard.spec.ts`、`snap.spec.ts`、`transform.spec.ts` 与既有回归 |
| `pnpm lint` | 不可执行：`package.json` 未配置 lint 脚本，属仓库既有工具链缺失 |

### 15.4 兼容与边界

- 旧草稿缺失 `size` / `fontSize` 时不写入字段，保持对象引用稳定；显式非法值才回退/夹取，`normalizeProject` 仍幂等。
- 箭头头部与文字字号不随几何缩放改变；复制/剪切/原地复制保留 `size` / `fontSize` / `width` / `rotation` / 颜色 / kind / label。
- 本轮未执行 `git commit / push / checkout / reset`，未终止或重启任何 daemon。工作区存在其他任务并行修改，最终全量 e2e 以当前共享工作区实测为准；若外部 daemon 仍运行旧构建，需要用户手动决定是否重启（stale daemon）。

## 16. Review 阻塞问题修复（2026-11-22）

本轮只针对 review 指出的问题做聚焦修补，`viewport` / `snap` / `transform` / `clipboard` 的模块边界与架构数据模型未改变，也未回退画笔粗细/操作条改动。

### 16.1 阻塞项：远坐标草稿加载后整块画布空白

| 问题 | 修复 | 验证 |
|---|---|---|
| `editor.load()` 无条件用 `includeBase=true` 适配，基准画布与远坐标内容并集后 `zoom` 被夹到 10%，合法对象落在视口外 | 已保存草稿改为 `fitProject(project, !saved)`：只框内容；960×600 基准仅用于新建/示例/空项目 | `viewport.test.ts` 用 `[999990,-20]..[1000000,20]` 复算 content-only 可见、base-union 不可见；`coordinate-safety` e2e 断言 reload 后图形 boundingBox 在画板内且可拖动 |
| 旧测试只在基准视图的固定屏幕坐标点选/绘制，内容适配后会失效 | `pen-width` 改为按可见笔迹包围盒点选，并先按 `0` 回到 100%；`eraser-fit` 在固定像素轨迹前按 `0` | 两个 spec 全量通过 |

### 16.2 其余 Review 修复

| Review 项 | 修复 |
|---|---|
| Clipboard API 缺失被误报成功 | `writeClipboardText` 显式检查 `navigator.clipboard.writeText`；不可用时返回 `false`，继续走内存副本与提示；新增单测与「Clipboard API 缺失」e2e |
| 同毫秒复制 A/B 无法判断新旧 | `Editor` 维护单调递增的 `lastClipboardStamp`，`copiedAt` 不再可能相等；外部 payload 时间戳也会抬高本地水位；新增同毫秒复制 e2e |
| 混合多选显示边手柄但实际拒绝非等比缩放 | `selectionFrame` 对多选按内容推导：含圆/圆弧或非 90° 倍数旋转的矩形/圈选时 `mode=uniform`，只显示四角；含文字时不提供旋转手柄；多选最小尺寸取成员最大值 |
| 非法变换后提交上一次有效预览 | `updateTransform` 失败时清空 `shapes/marks`、回退 `previewFrame` 并置 `moved=false`，pointerup 不再提交与当前落点不一致的陈旧几何 |
| Shift 吸附的是增量而不是绝对角 | 新增 `snapRotationDelta(startRotation, delta)`，对 `起始角 + 增量` 吸附后再换算回增量；新增「已自由旋转 99° 后再 Shift」e2e |
| 圈选选择框与渲染最小尺寸不一致 | `REGION_MIN_RADIUS=3` 统一渲染、命中、包围盒、选择框与最小缩放；`transformRegion` 落盘也夹到该下限；新增单测 |
| 大选择性能 | `selectionBounds` 改为流式 min/max，移除“收集全部点 + filter 第二份数组”；变换手势继续复用开始时缓存的 frame |
| 异步 `readText` 后未复核焦点 | `readText` 成功与失败回退路径都重新检查 `isTextEntryTarget(document.activeElement)`，焦点已进入输入框时不再粘到画布 |
| 角度读数未归一化 | 操作条角度按 `(-180,180]` 显示，与落盘 `rotation` 同口径 |
| `pasteIndex` 跨画布/撤销残留 | `replaceCanvas`、`undoChange`、`redoChange` 重置连续粘贴序号 |
| `rings.length !== polygon.length` 死分支 | 删除恒 false 分支 |

### 16.3 明确未在本轮扩大范围

- `editor.ts` / `editor-ui.ts` / `geometry.ts` / `transform.ts` 的文件级拆分、共享对象字段 schema、字号常量去重属于架构重构，未在“聚焦修补”节点展开。
- `positionActions` 的 DOM 矩形读取与 `board` 标注命中层在 zoom 变化时的重建仍是后续性能项；本轮只消除了 `selectionBounds` 的重复数组分配。

### 16.4 本轮真实命令结果

| 命令 | 真实结果 |
|---|---|
| `pnpm typecheck` | exit 0，无输出 |
| `pnpm test` | 17 个测试文件 / 196 个测试全部通过 |
| 聚焦 e2e（coordinate-safety / clipboard / transform / viewport） | 43 passed；随后新增绝对角 e2e 并通过 |
| `pnpm test:e2e` | 81 passed、0 failed（chromium + webgpu）。修复过程中曾因内容适配导致 2 条旧测试使用固定屏幕坐标而失败，已同步测试并通过 |
| `pnpm lint` | 不可执行：`package.json` 未配置 lint 脚本 |

## 17. 第三轮 Review 阻塞问题修复（2026-11-22）

本轮只处理 review 的 MUST FIX 与可直接收敛的 SHOULD FIX；`viewport` / `snap` / `transform` / `clipboard` 模块边界、矩形 `rotation` 数据模型与既有画笔粗细/操作条改动均未改变。

### 17.1 阻塞项

| Review 项 | 修复 | 验证 |
|---|---|---|
| 零尺寸 rect/region 能显示手柄但 `transformShape/transformMark` 返回 null | `geometry.ts` 新增 `expandDegenerateBox()`：仅当某轴真正退化时按产品下限居中展开（矩形 4×4、圈选 6×6），并在模型硬边界处整体内移；`sanitizeShapeGeometry`、`normalizeProjectWithRepair`、`clipboard.sanitizeShape/sanitizeMark` 共用。外部共线圆弧在 `parseClipboard` 阶段拒绝 | `tests/project.test.ts` 覆盖零尺寸矩形/圈选迁移与幂等；`tests/clipboard.test.ts` 覆盖外部 payload 展开与退化圆弧拒绝；`tests/browser/clipboard.spec.ts` 粘贴零尺寸矩形后拖 `w`/`n` 手柄并导出验证宽高 > 4 |
| 未知/缺失 shape 的旧标注被保留为 `Mark[]`，选中时 `markExtents` 崩溃 | `sanitizeStoredMark` 对未知 shape 返回 null 并计入 `droppedObjects`；`transform.ts` 的 `markExtents` / `markBoundPoints` / `selectionFrame` 同时做运行时防御，未知标注不再生成手柄或抛异常 | `tests/project.test.ts` 断言未知标注被丢弃并报告；`tests/transform.test.ts` 直接传入损坏 mark，`selectionBounds/selectionFrame` 返回 null |
| 外部 `copiedAt=1e308` 抬高本地水位，使同毫秒 A/B 去重失效 | `parseClipboard` 只接受安全整数且不超过本机时钟 +24h 的 `copiedAt`，非法值直接忽略字段；`Editor.nextClipboardStamp()` 再对 `+1` 做安全整数兜底 | `tests/clipboard.test.ts` 覆盖 1e308、`MAX_SAFE_INTEGER`、未来 2 天与正常时间戳；既有同毫秒 A/B e2e 继续通过 |

### 17.2 同步收敛的 SHOULD FIX

| Review 项 | 修复 | 验证 |
|---|---|---|
| `readText` 被拒后的 `setTimeout(0)` 回退可能抢在真实 paste 事件前 | 回退延后到 400ms，并记录 `fallbackTimer`；真实 `paste` 事件到达时先 `clearTimeout`，再按事件内容处理，迟到事件不再被误判为 `pasted` | 新增“读取拒绝 + 150ms 外部 payload”e2e：只粘贴外部内容；既有“读取拒绝回退”与“迟到 paste 只粘贴一次”继续通过 |
| 画笔固定 2 world 步长在 800% 下丢弃 10px 屏幕级笔触 | `PEN_SAMPLE_STEP` 收敛到 0.5 world（800% 约 4 CSS px，10% 由指针事件自然稀疏），仍保持与临时 zoom 解耦 | `tests/pen-sampling.test.ts` 新增 10 CSS px 轨迹在 10% / 800% 均完整保留 |
| 视口中心 ±1e9 超出模型域，远平移后绘制点被夹到视口外 | 新增纯函数 `clampViewCenter()`，按当前可见宽高把中心夹到 `±MAX_COORDINATE` 内；`panBy/zoomToAt` 共用。`fitProject` 仍优先完整框住内容，避免边界内容被推向视口一侧 | `tests/viewport.test.ts` 覆盖远中心夹取、正常中心不动与超大视口归零；`coordinate-safety` 的远坐标草稿 e2e 继续通过 |

### 17.3 仍未扩大范围

- `editor.ts` / `editor-ui.ts` / `geometry.ts` / `transform.ts` 的文件级拆分仍是独立架构任务；本轮未在修复节点重写交互状态机。
- 旋转矩形的点击命中与 SVG 导出已有路径级/JSON 级覆盖，新增浏览器点击与 SVG 下载断言会扩大 e2e 面积，留待后续专项测试节点。

### 17.4 本轮真实命令结果

| 命令 | 真实结果 |
|---|---|
| `pnpm typecheck` | exit 0，`tsc --noEmit` 无输出 |
| `pnpm test` | 17 个测试文件 / 202 个测试全部通过 |
| `pnpm exec playwright test tests/browser/clipboard.spec.ts tests/browser/transform.spec.ts tests/browser/viewport.spec.ts --project=chromium` | 41 passed、0 failed |
| `pnpm exec playwright test tests/browser/clipboard.spec.ts --project=chromium` | 21 passed、0 failed（含新增零尺寸粘贴与读取拒绝竞态用例） |
| `pnpm test:e2e` | 83 passed、0 failed（chromium + webgpu） |
| `pnpm build` | 通过（43 modules，`dist/` 已更新） |
| `git diff --check` | exit 0 |
| `pnpm lint` | 不可执行：`package.json` 未配置 lint 脚本 |

## 18. 第四轮 Review 阻塞问题修复（2026-11-22）

本轮只修复 review 指出的 MUST FIX 与四组对抗场景，`viewport` / `snap` / `transform` / `clipboard` 的模块边界、矩形 `rotation` 数据模型和既有画笔粗细/操作条改动均未改变。

### 18.1 阻塞项与四组对抗场景

| Review 项 | 修复 | 验证 |
|---|---|---|
| 非文本剪贴板（图片/文件/富文本）`readText()` resolve 空串时被当成空剪贴板，立即粘贴旧内存对象并 `preventDefault` 吞掉真实 paste | `editor-ui.ts` 不再把空串等同于空剪贴板：先通过 `navigator.clipboard.read()` 检查 `ClipboardItem.types`；存在非 `text/plain` 类型时把手势留给真实 paste 事件并保持原生行为；只有确认仅含空文本且真实事件被取消时才走 400ms 内存回退。`gesture.pasted` 仅在真正写入画布后置位 | 新增真实 `image/png` ClipboardItem + `Control+V` e2e：对象数不增加，paste 事件 `defaultPrevented === false` |
| 跨标签页把 `copiedAt` 当全局水位：Tab2 旧时间复制、延迟写入后，Tab1 把真正当前的 payload 判为 stale | payload 新增 `sessionId`；`isStaleExternal` 只在同一会话内比较 `copiedAt`，跨会话以系统剪贴板当前内容为准；`lastClipboardStamp` 只被同会话 payload 抬高 | 新增跨标签页 e2e：`sessionId=other-tab` 且 `copiedAt` 早 10 秒的 payload 仍被接受并偏移 16；同会话旧 payload 去重测试继续通过；`clipboard.test.ts` 覆盖 `sessionId` 限长解析 |
| 粘贴后自动选中数千对象，拖缩放手柄时 `exclude` 数组与候选线性 `includes` 在 pointermove 上放大成乘法级扫描 | `SnapOptions.exclude` 改为 `ReadonlySet<string>`，`SnapIndex` 逐候选 O(1) 查询；`transform` / `move` / `shape-move` 手势开始时各构建一次排除集合，pointermove 复用 `drawing.excluded` | `tests/snap.test.ts` 改用 Set；全量 transform / snap / clipboard e2e 通过 |
| 仅含 1×1 外部 region 的草稿：渲染半径被 `REGION_MIN_RADIUS=3` 抬升，但 F/JSON/SVG 仍按 1×1 取景 | `viewport.ts` 直接复用 `REGION_MIN_RADIUS`，未旋转分支也按抬升后的中心/半径生成包围点；`fitWorldRect` / `exportViewBox` 因此覆盖 6×6 可见范围 | `tests/viewport.test.ts` 新增 1×1 region 的 F 与导出画幅断言 |

### 18.2 同步收敛的 SHOULD FIX / NIT

| Review 项 | 修复 |
|---|---|
| 低缩放网格 LOD 最小 9–10px，最近格点必然落在 10px 阈值内，非 Alt 绘制被强制量化 | `snap.ts` 要求栅格屏幕间距至少为捕捉阈值两倍才参与吸附；实体捕捉与 10px 屏幕阈值不变 |
| 旋转矩形用世界 AABB 复核最小尺寸 | 核对确认 `rect.a/b` 是局部半轴端点、`rotation` 独立存储，`shapeSize` 已经是局部宽高；补充注释与防回归说明，未改成世界 AABB |
| `cancelSelection` 未清 `markStylePreview`，Esc 后画布停留在未提交预览 | 取消选择时一并清空尺寸预览并重绘 |
| 混合外部 payload 同时选中 shapes 与首个 mark，两个操作条并发 | 混合粘贴以图形为主选择；仅标注 payload 才选中标注 |
| 无选择时 `Ctrl/⌘+D` 触发浏览器书签对话框 | 非文本焦点下始终拦截并调用画布原地复制，无选择时不弹书签 |
| 移除无调用方的 `BoardViewport.fitting`，成功 fit 后不再保留 `pendingFitBase` | 删除 getter；成功后 `pendingFitBase=false`，仅首帧尺寸未知时保留待办 fit |

### 18.3 本轮真实命令结果

| 命令 | 真实结果 |
|---|---|
| `pnpm typecheck` | exit 0，`tsc --noEmit` 无输出 |
| `pnpm test` | 17 个测试文件 / 205 个测试全部通过 |
| `pnpm exec playwright test tests/browser/clipboard.spec.ts tests/browser/viewport.spec.ts tests/browser/snap.spec.ts tests/browser/transform.spec.ts --project=chromium` | 50 passed、0 failed |
| `pnpm test:e2e` | 85 passed、1 skipped、0 failed（chromium + webgpu）；跳过的 `webgpu-fill.spec.ts:227` 单独重跑 1 passed |
| `pnpm exec playwright test tests/browser/clipboard.spec.ts --project=chromium` | 24 passed、0 failed（最终手势去重收敛后复跑） |
| `git diff --check` | exit 0 |
| `pnpm lint` | 不可执行：`package.json` 未配置 lint 脚本 |

未执行 `git commit / push / checkout / reset`，未终止或重启任何 daemon。本轮未重建 `dist/`；若外部 daemon 仍运行旧构建，需要用户手动决定是否重启（stale daemon）。
