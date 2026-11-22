# ADR 0001：WebGPU + TypeScript + Rust/Wasm 技术栈

状态：实施完成，待 review/QA 与产品验收（2026-11-22）。方案 A（原生 WebGPU + WGSL + TypeScript），不引入额外渲染框架。

迁移进度：

- 第 1 步「原地 TS 化」完成。
- 第 2–3 步「渲染器抽象 + WebGPU 图元」完成：`SketchRenderer` 契约、`WebGpuRenderer` / `Canvas2dRenderer` / `SvgRenderer`、跨后端 `RenderScene`、网格/直线/圆弧/圆/路径描边/闭合填充/选中高亮/捕捉标记。文字继续走 SVG/DOM overlay。
- 第 4 步「Rust 内核第一块」完成：`wasm/` 提供无状态二维布尔（并/交/差、孔洞、多块），`kernel.ts` 是唯一 TS 门面。
- 第 5 步「Rust 内核第二块」完成（ABI v2）：`curve.rs` 负责圆/三点圆弧/三次 Bézier 离散与带孔洞多边形三角化，`edit.rs` 负责线段交点、修剪、延伸、偏移、圆角；`kernel.ts` 暴露 `tessellatePolygons` / `flattenCircle` / `flattenArc` / `flattenCubicBezier` / `polylineIntersections` / `trimPolyline` / `extendPolyline` / `offsetPolyline` / `filletPolyline`。圆与圆弧的默认分段数沿用既有 TS 规则，`tests/geometry-kernel.test.ts` 逐点对照旧采样器。
- 第 6 步「切换默认」完成：默认 `auto` 按 WebGPU → Canvas2D → SVG 升级/回退；WebGPU 运行中丢失 device 时自动降级；Wasm 在首屏后空闲预热，不进入关键路径。
- 第 7 步「清理」完成：删除 `vendor/polygon-clipping.js`、`vendor/polygon-clipping.d.ts` 与旧参照实现；polygon-clipping 0.15.7 的面积/环数/组件数/包围盒指标冻结在 `tests/boolean-golden.test.ts`。README、路线图与 `docs/migration-report.md` 已收口。

实测（headless Chromium 157 / SwiftShader 软件适配器 / 1920×1080）：默认后端 `webgpu`；2000 图元连续帧均值 16.67ms（60.0fps）、draw CPU p95 0.4ms；真实 pointermove 路径 p95 5.10ms；Wasm 98.49kB、gzip 38.34kB；禁用 WebGPU 后自动回退 Canvas2D 且核心绘制可用。完整数据与剩余风险见 `docs/migration-report.md`。本机 `wasm-pack` 无法运行（x86_64 二进制、无 Rosetta、无外网），因此产物由 `cargo build --target wasm32-unknown-unknown --release` 生成，详见 `wasm/README.md`。

## 背景

SimSketch 当前是零构建静态站点：

- 原生 JavaScript、ES Modules、SVG 渲染。
- WebGPU 只用于画布底色和点阵，失败回退 SVG。
- 二维布尔依赖 vendored `polygon-clipping`。
- 测试用 `node:test`。

目标技术栈改为：

- WebGPU 渲染。
- TypeScript。
- Rust + WebAssembly 承担高性能几何计算。

## 先纠正一个点：C3JS 不是 WebGPU 库

查过公开资料：

- `c3js / c3.js` 是基于 D3 的 SVG 图表库，没有 WebGPU 渲染能力。
- `C3D Toolkit` 是 C3D Labs 的商业 CAD 内核，C3D Web Vision 目前公开资料写的是 WebGL，不是 WebGPU，也不是 JS 库。
- 没有找到叫「C3JS WebGPU」的成熟渲染库。

如果你想说的是下面某一个，需要明确：

| 可能指向 | 是否合适 | 说明 |
| --- | --- | --- |
| TypeGPU | 可选 B | TypeScript 里写 WebGPU shader、带类型推导的轻量工具包 |
| Three.js WebGPURenderer | 可选 C | 3D 引擎，2D CAD 用会偏重，但生态完整 |
| C3D Toolkit | 不建议 | 商业原生 CAD 内核，和浏览器 TS/Wasm 栈不是一条路 |
| c3.js | 不合适 | 图表库，和画布几何无关 |

本 ADR 默认采用 **方案 A：原生 WebGPU + WGSL + TypeScript**。不额外压一层渲染框架，先把 2D CAD 需要的线和填充做稳。

## 决策

### 1. 构建与语言

- Vite + TypeScript strict。
- 纯静态产物，继续部署 GitHub Pages。
- 不再手写无构建脚本；`dist/` 作为发布产物。
- 测试：Vitest（TS 单元测试）+ Playwright（浏览器冒烟）+ Cargo test（Rust）。

### 2. 渲染分工

```text
WebGPU canvas
  ├─ 点阵 / 网格
  ├─ 直线、圆弧、圆、路径描边
  ├─ 闭合区域填充
  └─ 选中高亮、捕捉标记

SVG / HTML overlay
  ├─ 标注文字
  ├─ 尺寸文字和箭头
  ├─ 输入 HUD
  └─ 图例、面板
```

文字不要第一版就塞进 WebGPU。CAD 的尺寸标注、文字、编辑框用 DOM/SVG 叠加最省事，也方便无障碍和输入。

渲染器接口固定为：

```ts
interface SketchRenderer {
  resize(width: number, height: number, dpr: number): void;
  draw(scene: RenderScene): void;
  destroy(): void;
}
```

首版实现：

- `WebGpuRenderer`：主渲染。
- `Canvas2dRenderer`：WebGPU 不可用时的兼容路径。
- `SvgRenderer`：迁移期对照和导出，不要求承担 2000 图元实时绘制。

### 3. Rust/Wasm 的边界

Rust 只做**无状态几何内核**，不持有 UI 状态、不碰 DOM、不写 IndexedDB。

第一批放进 Rust 的能力：

1. 二维布尔：并、交、差、孔洞、分离多块。
2. 曲线离散与三角化：圆、圆弧、路径 -> GPU 顶点/索引。
3. 交点、修剪、延伸、偏移、圆角。
4. 捕捉候选批处理。
5. 后续约束求解。

留在 TypeScript 的能力：

- 项目数据、图层、撤销栈。
- 工具状态机、选择、面板。
- 视口和相机。
- 渲染管线和 GPU 资源生命周期。
- 标注和尺寸 overlay。

调用原则：

- 不要每个 `pointermove` 都跨 Wasm 边界做一次小计算。
- 交互高频路径先在 TS 做便宜判断，批量几何求解再进 Wasm。
- 第一版可以用 JSON/serde 保证正确；热路径随后换成 `Float64Array` / `Uint32Array` 二进制视图。
- 不使用 SharedArrayBuffer 作为硬依赖。GitHub Pages 不能设置 COOP/COEP 响应头。
- 重计算放 Web Worker；结果用 transferable 传回主线程。

### 4. Wasm 输出直接喂 WebGPU

Rust 返回顶点和索引：

```rust
pub struct Tessellation {
    pub positions: Vec<f32>, // x, y
    pub indices: Vec<u32>,
}
```

TS 侧用 `Float32Array(wasm.memory.buffer, ptr, len)` 视图写 `GPUBuffer`，避免再复制一层。注意 Wasm 内存增长会让旧视图失效，每次取视图前重新构造。

## 目录建议

> 实施期沿用仓库根目录（`webgpu-renderer.ts`、`renderer-host.ts`、`wasm/` 等），与下方 `src/` 建议是同一职责的扁平映射；待迁移稳定后再统一搬入 `src/render|model|app`。

```text
src/
  main.ts
  app/
    editor.ts            指针状态机、工具切换
    panels.ts            DOM 面板
    persistence.ts       IndexedDB
  model/
    project.ts           项目 schema 与迁移
    entities.ts          图元类型
    annotations.ts       标注与锚点
  viewport/
    camera.ts            世界坐标 <-> 屏幕坐标
    hitTest.ts
  render/
    renderer.ts          接口和 RenderScene
    webgpu/
      device.ts
      grid.ts
      lineRenderer.ts
      fillRenderer.ts
      textOverlay.ts
    canvas2d/
      canvas2dRenderer.ts
  geometry/
    kernel.ts            Wasm 门面
    types.ts
  wasm/
    Cargo.toml
    src/
      lib.rs
      boolean.rs
      tessellate.rs
      snap.rs
      constraint.rs
tests/
  unit/
  browser/
```

## 迁移顺序

不要一次性重写。按可回滚的步骤走：

1. **原地 TS 化**：加 Vite、tsconfig、严格类型；把现有 JS 改成 `.ts`，行为不变；补现有测试。
2. **渲染器抽象**：保留 SVG 作为对照实现；WebGPU 先接管网格和直线，其他仍走 SVG。
3. **WebGPU 图元**：圆弧、圆、路径描边、闭合填充；文字继续 SVG overlay。
4. **Rust 内核第一块**：先搬布尔，和现有 `polygon-clipping` 做黄金用例对比。
5. **Rust 内核第二块**：曲线离散、三角化、交点；再搬修剪/延伸/偏移/圆角。
6. **切换默认**：WebGPU + Wasm 成为默认路径；Canvas2D 做兼容回退。
7. **清理**：删除旧 JS 几何和 vendored 布尔依赖，保留迁移说明。

每一步都要能单独部署和回滚，不允许「全部改完再一起试」。

## 性能目标

- 2000 个图元，1080p，60fps 为基线。
- `pointermove` 到画面更新小于 16ms；超标的重计算进 Worker。
- 一次典型布尔小于 50ms；超过 200ms 显示进度并允许取消。
- 首次 Wasm 体积目标小于 500KB gzip；超过就拆模块或延迟加载。
- 启动不阻塞首屏：先显示画布和已有 SVG，再初始化 WebGPU/Wasm。

## 测试门槛

- Rust：`cargo test` 覆盖布尔不变量、退化输入、圆弧三角化。
- TS：Vitest 覆盖项目迁移、视口坐标、工具状态机。
- 跨实现对照：同一组图元和操作，JS 旧实现与 Rust 新实现的面积、环数、包围盒一致。
- 浏览器：Chromium WebGPU 真机、Safari/不支持 WebGPU 的回退、移动端布局。
- 导出：SVG/PNG/JSON/DXF 在迁移前后结果一致。

## 风险

- **WebGPU 兼容性**：Safari 和部分移动设备仍可能不可用，必须保留 Canvas2D 回退。
- **文字渲染**：不要用 WebGPU 自己画文字，DOM/SVG overlay 是正确选择。
- **Wasm 边界成本**：高频小调用会拖慢交互；接口按批次设计。
- **二进制体积**：Rust 内核容易越滚越大，按布尔/离散/求解拆包。
- **双实现漂移**：迁移期 TS 和 Rust 各有一套几何，必须用黄金测试锁住结果。
- **C3JS 误选**：如果指的是图表库或商业 C3D 内核，会走错方向，需要先确认。

## 决策确认

「C3JS WebGPU」按 A：原生 WebGPU + WGSL（本 ADR 默认）落地；TypeGPU / Three.js WebGPURenderer
均未引入。迁移按「Vite + TypeScript 原地迁移 → 渲染器抽象 + WebGPU 图元 → Rust/Wasm 内核 →
默认路径切换」推进，当前实施完成，待 review/QA 与产品验收。
