# SimSketch

用手指、触控笔或鼠标描述仿真里的受力区域、固定约束和方向。可以从空白画板开始，也可以导入图片后标注。支架示例可用于熟悉标注流程。

## 运行

```bash
pnpm install
pnpm dev        # 本地开发，默认 http://localhost:5173/
pnpm build      # 类型检查 + 构建到 dist/
pnpm preview    # 预览构建产物
```

`dist/` 是纯静态产物，可直接托管到 GitHub Pages 或任意静态站点（`base: './'`，支持子目录）。不要再直接用 `python3 -m http.server` 打开源码目录：`.ts` 需要 Vite 转译。

应用首次加载后可离线打开和绘制，当前草稿使用 IndexedDB 保存到本设备。可用「复制图片」将当前画布复制到剪贴板。开始另一张草图或导入新图片前，可以导出当前草图的 PNG、SVG 或完整 JSON；同一次使用中的替换也可以撤销。打开应用的「安装应用」可看到系统安装入口。发布新版资源时更新 `public/sw.js` 中的缓存版本。

工具栏提供直线、矩形、圆和三点圆弧，绘制的图形沿用当前画笔颜色。直线可按住 Shift 吸附 45°，矩形按住 Shift 为正方形。切到「选择」后点击图形或按住 Shift 多选；选中两个以上闭合图形（矩形、圆、布尔结果）可执行并集、差集和交集。差集以先选中的图形为主体，减去其余图形。布尔结果保存为带孔洞的路径对象，可继续参与下一次布尔运算。拖动选中的图形可整体移动；Delete 删除，Esc 取消选择或取消未完成的圆弧。

在画布上选择标注，或打开「标注」列表，可修改类型、区域说明、载荷数值和模型方向。文字工具可直接在画布上输入；选择工具可拖动对象，双击文字或点击「编辑」继续修改。回车保存，Esc 取消；清空已有文字可删除该标注。打开「图层」可新建和重命名图层、调整顺序和不透明度；新对象加入当前图层，选中对象后可以更换所在图层。导入的参考图片也位于独立图层。

## 路线图

2D CAD 方向的阶段计划、代码边界和验收标准见 `docs/cad-roadmap.md`。

WebGPU + TypeScript + Rust/Wasm 的技术栈决策见 `docs/adr/0001-webgpu-typescript-rust-wasm.md`。

## 测试

```bash
pnpm test        # Vitest：几何、内核、布尔与草稿迁移
pnpm test:e2e    # Playwright：默认后端、绘制/选择/持久化、无 WebGPU 回退
pnpm typecheck   # TypeScript strict
node scripts/perf-probe.mjs  # 2000 图元 1080p、pointermove、Wasm 首屏实测
```

`cargo test --release`（在 `wasm/` 下）覆盖 Rust 布尔、曲线与编辑内核。迁移报告见 `docs/migration-report.md`。

渲染器诊断：`?renderer=svg|canvas2d|webgpu|auto`；`?snap=500,300` 可注入一个捕捉标记用于视觉 QA（只用于调试，不参与产品交互）。

## 技术栈

Vite + TypeScript strict；三种后端消费同一份 `RenderScene`：`webgpu-renderer.ts`（默认）、`canvas2d-renderer.ts`（兼容回退）、`svg-renderer.ts`（SVG 回退与视觉对照）。默认启动顺序是 WebGPU → Canvas2D → SVG：WebGPU 不可用或运行中丢失 device 时自动降级；Canvas2D 初始化或运行期失败会继续回退 SVG，不会留下空白 canvas；WebGPU 填充所需的 Wasm 若加载失败，同样会通过 Host 回退，不会只剩描边。WebGPU 负责网格、直线、圆弧、圆、路径描边、闭合填充、选中高亮和捕捉标记；闭合填充由 Rust/Wasm 按垂直扫描线 + even-odd 生成无重叠三角形并直接带颜色提交，支持多个孔洞且不再依赖 triangle fan；三角化结果按图元多边形数组缓存，拖动单个图元只重算它自己；不透明描边与不透明填充各合批一次；半透明内容按 painter 顺序合并连续的同类 run，选中多个图形时 draw 次数会随 run 数增长（已纳入 `perf-probe` 压测）。描边批次先提交、填充批次后提交，用逐图元深度恢复半透明填充与描边的 painter 次序；顶点缓冲按变化区间增量上传。文字/标注气泡始终由 SVG/DOM overlay 负责，交互命中代理按 shape id 增量更新。二维布尔与闭合填充三角化走 `kernel.ts` 门面与 `wasm/` 的 Rust/Wasm 内核；曲线离散、交点、修剪、延伸、偏移和圆角已通过同一门面暴露并有单测覆盖，但当前产品绘制路径仍使用 `geometry.ts` 的 TS 圆弧采样。布尔输入的圆采样走 Wasm（布尔前已等待内核就绪），普通首屏圆弧渲染不依赖内核。Wasm 在首屏绘制后用空闲时间预热，只有布尔等几何操作会等待它，不阻塞首屏。

## 入口

`index.html` 加载 `app.ts`，只负责启动、菜单、安装与 Service Worker 接线；编辑器状态机在 `editor.ts`。`renderer.ts` 定义 `SketchRenderer` 与场景协议，`renderer-host.ts` 负责后端升级/回退，`scene.ts` 把项目投影成跨后端 `RenderScene`，`editor-text.ts` / `editor-ui.ts` 负责内联文字与面板 DOM 投影，导出由 `export.ts` 编排、`svg-document.ts` 调用 `board.ts` 生成完整 SVG 文档，`board.ts` 还负责文字/标签 overlay 与交互命中代理，`reference.ts` 管理参考图与 SVG/PNG 光栅化，`geometry.ts` 管理矢量图形，`kernel.ts` 是 Wasm 几何内核唯一门面，`project.ts` 管理草稿存储和标注数据，`public/sw.js` 提供离线启动。

默认使用 WebGPU + Wasm。`?renderer=auto` 与不传参数等价（WebGPU → Canvas2D → SVG）；`?renderer=canvas2d` 只尝试 Canvas2D，失败即 SVG；`?renderer=webgpu` 只尝试 WebGPU，失败或运行期丢失 device 时直接回退 SVG，不会再静默切到 Canvas2D，便于区分显式诊断与 auto 路径。SVG/PNG 导出始终走完整 SVG 文档，不依赖当前 GPU 后端。非不透明图层在 WebGPU/Canvas2D 下按图层离屏合成，保持组透明语义。WebGPU 的虚线 pattern 与 SVG/Canvas2D 共用实例数据（椭圆 9/5，普通描边取 `dash` 实际值）；WebGPU 的 dash 相位按实例/段重置，折线虚线会与 SVG 单 path 的连续相位不同。线段折角仍是按段求距离的近似 round join，半透明描边会在关节处重复 alpha 混合。迁移期性能、回退和体积实测见 `docs/migration-report.md`。

「画笔颜色」支持自动、仿真预设和自定义颜色。选中预设后，新画的笔画、圈选、箭头和文字都会带上对应的语义。图例按画布上实际使用的颜色合并，并附在 JSON 中。
