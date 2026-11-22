# SimSketch 方案 A 迁移报告（步骤 6–7）

日期：2026-11-21  
范围：ADR 0001 第 6 步「切换默认」、第 7 步「清理与文档收口」。

## 1. 改了什么

### 默认路径

- `rendererMode.ts` 的默认值从 `svg` 改为 `auto`。
- 默认启动顺序：**WebGPU → Canvas2D → SVG**。
  - WebGPU 初始化失败（无 `navigator.gpu`、无 adapter、5s adapter/device 超时、context/pipeline 创建失败）时自动尝试 Canvas2D。
  - WebGPU 运行中 `device.lost` / `uncapturederror` 时由 `RendererHost` 重新挂载 Canvas2D。
  - Canvas2D 工厂阶段就校验 `getContext('2d')`；初始化失败，或运行期 draw 抛错/context 丢失，都会销毁 canvas 并回退 SVG，不再出现 `data-renderer=canvas2d` 但页面空白。
- `?renderer=auto` 与不传参数等价；`?renderer=canvas2d` 失败即 SVG；`?renderer=webgpu` 只尝试 WebGPU，失败或运行期失效直接回退 SVG，避免显式诊断被静默改道 Canvas2D。
- SVG 不再承担默认实时绘制，只保留导出、视觉对照和最终兜底。
- E2E 新增默认后端断言与「禁用 WebGPU 自动回退 Canvas2D」用例。

### Wasm 首屏与加载

- `kernel.ts` 保持惰性单例：首次调用 `ensureGeometryKernel()` 才 `fetch` `.wasm`。
- `app.ts` 保留 `warmGeometryKernel()`：首帧 `requestAnimationFrame` 之后，用 `requestIdleCallback`（2s 超时兜底）预热；不 `await`，不进入首屏关键路径。编辑器状态机、DOM 投影、视口、导出已拆到独立模块。
- 布尔操作仍会 `await ensureGeometryKernel()`；首次布尔需要等加载，但绘制、选择、拖动、保存不受影响。WebGPU 在首屏若遇到填充而内核未就绪，会先跳过填充并在就绪后自动补帧。
- 构建产物中 `.wasm` 是独立带哈希资源，不会内联进入口 JS。

### 渲染正确性修复

- WebGPU 闭合填充改用 Wasm `tessellatePolygons` 生成 triangle-list，直接以顶点色提交，不再使用以 `ring[0]` 为原点的 triangle fan 或逐图元 stencil/cover pass。三角化按顶点 x 切垂直扫描线、在每个 slab 内按 even-odd 配对 y 跨度；相比 ear-clipping + 孔洞桥接，多个孔洞共享同一外环时不会再产生重叠耳朵或填错孔洞。凹多边形（例如 `union(rect(0,0,10,4), rect(0,4,4,10))`）也不再因 fan 三角形越界重叠而被 even-odd 漏填。
- 每次 `draw()` 重新打包 `RenderScene`（三角化仍按图元多边形数组缓存），不再保留无效的帧计划缓存；内核尚未预热时跳过填充并登记一次重画请求，内核就绪后自动补帧。
- 新增 `tests/gpu-scene.test.ts`：对 L 形、单孔洞、双孔洞（review 复现的外环 80×53 + 两个孔洞，期望面积 3970）、多组件凹多边形逐点比较三角化 parity 与 even-odd 多边形包含关系，并校验三角形总面积。Rust 侧同名回归覆盖同一组双孔洞用例。
- WebGPU 虚线改为从实例数据读取实际 `dash` pattern；椭圆与 SVG/Canvas2D 一样使用 9/5。折角 join 仍是按段距离的近似，已在 README 标注。
- 网格 spacing/radius/origin/背景色/点色统一从 `RenderScene.background` 进入 WebGPU uniform 与 Canvas2D，消除 theme 改动导致的后端漂移。

### 旧依赖清理

- 删除 `vendor/polygon-clipping.js`。
- 删除 `vendor/polygon-clipping.d.ts`。
- 删除仅用于旧参照实现的 `tests/support/reference-boolean.ts`。
- `tests/boolean-golden.test.ts` 改为对照**冻结的 polygon-clipping 0.15.7 指标**（面积、环数、组件数、包围盒）；矩形类用例额外锁定归一化 ring 拓扑，所有用例校验环方向与孔洞归属；圆形完整顶点等价仍记为 UNKNOWN。不再需要第二套布尔实现。
- `tsconfig.json` 移除 `vendor/**/*.d.ts`。
- `vendor/README.md` 保留退役说明；README、ADR、路线图同步更新。
- `public/sw.js` 缓存版本升到 `sim-sketch-shell-v22`，旧缓存会在激活时清理；Wasm 与其他同源资源继续走内容哈希缓存。

### 文档

- `README.md`：默认 WebGPU + Wasm、回退顺序、Wasm 预热、测试与性能命令、迁移报告入口。
- `docs/adr/0001-webgpu-typescript-rust-wasm.md`：状态改为「实施完成，待 review/QA 与产品验收」，记录第 1–7 步结果与实测摘要。
- 本报告：`docs/migration-report.md`。

## 2. 测试命令与结果

全部在 `/Users/mizy/projects/sim-sketch` 实际执行。

| 命令 | 结果摘要 |
| --- | --- |
| `pnpm typecheck` | 通过，0 个 TS 错误。 |
| `pnpm test` | 7 个测试文件、65 个用例全部通过（`project` 4、`geometry` 7、`boolean-golden` 16、`geometry-kernel` 26、`gpu-scene` 10、`webgpu-kernel-failure` 1、`webgpu-tessellation-failure` 1）。`pretest` 自动重建 Wasm。 |
| `pnpm test:e2e` | 11 个用例通过：8 个 Chromium 用例（默认后端绘制/选择/刷新持久化；未完成圆弧丢弃；Canvas2D context lost 回退 SVG；双后端不可用回退 SVG；禁用 WebGPU 回退 Canvas2D；Canvas2D 填充/孔洞像素断言；2000 mark overlay 节点复用；延迟内核下 Esc 取消布尔不提交）+ 3 个 WebGPU project 用例（L 形/孔洞像素；半透明填充/painter 次序跨后端像素对照；Wasm 加载失败运行期回退）。 |
| `pnpm build` | 通过。`dist/assets/index-*.js` 88.16kB（gzip 28.89kB）；`sim_sketch_geometry-*.wasm` 95.58kB（gzip 37.94kB）；CSS 16.03kB（gzip 4.18kB）。 |
| `cd wasm && cargo test --release` | 10 个 Rust 用例通过，含新增 `curve::tests::triangulates_two_holes_without_filling_them`，以及 `rings` 的孔洞归属用例。 |
| `node scripts/perf-probe.mjs` | 通过，输出见下节。 |

补充：

- `pnpm test` 的 `pretest` 输出 `wasm-pack is present but not executable here (x86_64 binary, no Rosetta); using cargo build.`，随后 `Finished release profile`。
- 未执行 `git commit/push/checkout/reset`，未执行 `cah restart/stop` 或 kill daemon。

## 3. 性能实测

环境：

- macOS 27.0.1 / Apple M1。
- Headless Chromium 157.0.7727.15（Playwright）。
- WebGPU 实测通过 `--enable-unsafe-webgpu` 启用；适配器为 **Google SwiftShader（软件渲染）**，不是硬件 GPU。因此下面数据是保守基线。
- 画布 1920×1080（CSS 1920×1080，DPR 1，scene 960×540，`pixelsPerWorldUnit=2`）。
- 2000 个带填充的矩形图元，单图层，完整走 `buildScene` → `WebGpuRenderer.draw` / `Canvas2dRenderer.draw`。
- pointermove 使用合成 `PointerEvent`（真实指针不存在时会丢失 pointer capture，故仅旁路 `setPointerCapture`/`releasePointerCapture`；按下已有图元后连续拖动，场景重建、增量命中代理和 overlay 更新路径与真实交互一致）。

### WebGPU（默认）

| 指标 | 未选中 2000 图元 | 全部选中 2000 图元 |
| --- | --- | --- |
| 后端 | `webgpu` | `webgpu` |
| 连续帧间隔均值 | **16.67ms（60.0fps）** | 453.65ms（非 60fps） |
| 帧间隔 p50 / p95 / max | 16.70 / **16.80** / 18.40ms | 16.70 / **250.0** / 23349.1ms |
| draw CPU p50 / p95 / max | 2.30 / **2.70** / 3.40ms | 4.50 / **242.2** / 23350.8ms |
| pointermove p50 / p95 / max | 3.80 / **4.50** / 10.10ms | 未采样（draw 已不达标） |
| pointermove 均值 | 4.02ms | — |
| pointermove 后图元节点数 | 2000（命中代理按 id 增量复用） | — |

结论：

- 未选中的 2000 个带填充矩形下，帧间隔 p95 16.80ms、draw CPU p95 2.70ms，达到 60fps 目标；draw CPU 比上一轮（缓存帧计划时 0.60ms）高，因为现在每帧都重新打包 scene，不再依赖永远不会命中的缓存。
- pointermove p95 4.50ms、max 10.10ms，低于 16ms 目标。
- **全部选中 2000 图元不达标**：每个图元产生半透明光晕、半透明填充与不透明描边，`recordTranslucent` 在 stroke/fill 交替处 flush，draw 次数约 4000；SwiftShader 下 draw p95 242ms，并出现 23s 背压尖峰。这是已知未达标项，需在真机 GPU 复核并考虑合并半透明批次或只给可见选中绘制光晕。
- 关键改动：矩形投影按 shape 身份缓存多边形、三角化按多边形数组缓存、WebGPU 不透明描边/填充各合批一次、半透明内容按 painter 顺序合并连续同类 run、顶点缓冲按变化区间增量上传、SVG 命中代理按 shape id 增量更新。

### Canvas2D 回退

| 指标 | 实测 |
| --- | --- |
| 后端 | `canvas2d` |
| 连续帧间隔均值 | **16.67ms（60.0fps）** |
| 帧间隔 p50 / p95 / max | 16.70 / 16.80 / 17.60ms |
| draw CPU p50 / p95 / max | 2.30 / **2.50** / 3.00ms |
| 回退后绘制 | 2000 种子 + 1 个新矩形 = 2001 个 `[data-shape-id]` |

Canvas2D 在 2000 个带填充矩形下仍保持 60fps 节奏，draw CPU p95 2.5ms，低于 33ms 回退目标。

### Wasm 体积与首屏

| 指标 | 实测 |
| --- | --- |
| `.wasm` 原始体积 | 95,584B（95.58kB） |
| `.wasm` gzip 体积 | 37,944B（**37.94kB**） |
| 入口 JS | 88.16kB（gzip 28.89kB） |
| First Contentful Paint | 32ms |
| `main` 可交互 | 88ms |
| Wasm 请求开始 | 70ms（首屏之后） |
| 人为延迟 Wasm 响应 1500ms 时完成矩形绘制 | 426ms（早于 Wasm 可用） |
| 延迟期间成功绘制的图元 | 1 个矩形 |

结论：Wasm 体积远低于 500KB gzip 目标；请求在 FCP 之后才发出，且响应延迟 1.5s 不影响首屏和核心绘制。

### 布尔耗时（附加）

在 Node 中预热后连续执行 200 次「400×300 矩形减去 R100 圆」：平均 **0.18ms/次**，总计 35.6ms。首次浏览器布尔还需等待 Wasm 下载/实例化，受网络和缓存影响。

## 4. 回退验证

| 场景 | 验证方式 | 结果 |
| --- | --- | --- |
| 无 WebGPU | `navigator.gpu = undefined` 后加载默认路径 | 自动落到 `canvas2d`；矩形绘制成功，`[data-shape-id]` = 1。 |
| WebGPU 不可用但存在 `navigator.gpu` | headless Chromium 无 `--enable-unsafe-webgpu`（adapter 为 null） | 自动落到 `canvas2d`，核心绘制可用。 |
| Wasm 加载慢 | 将 `.wasm` 响应延迟 1500ms | 首屏、交互和绘制照常；Wasm 就绪前 WebGPU 填充跳过并在内核就绪后自动补帧，布尔操作等待或超时。 |
| Wasm 加载失败 | 拦截 `.wasm` 返回非法内容；WebGPU 已初始化且绘制带填充矩形 | `WebGpuRenderer.requestKernelRepaint` 将失败上报 Host，自动回退 `canvas2d` 并保留填充；`tests/browser/webgpu-fill.spec.ts` 覆盖。 |
| Canvas2D 不可用 | `navigator.gpu=undefined` 且 `getContext('2d')=null` | 自动回退 SVG；矩形绘制成功，`[data-shape-id]` = 1。 |
| 显式后端 | `?renderer=webgpu` / `canvas2d` / `svg` | `webgpu` 独占尝试（失败回 SVG），`canvas2d` 失败回 SVG；`svg` 直接使用。 |

## 5. 剩余风险

1. **性能数据来自 SwiftShader**：60fps/pointermove/selected 数据均在软件适配器上取得；真实硬件 GPU 通常更快，但本机 headless 无法给出硬件数据，需要产品验收时在 Safari/Chrome 真机复核。
2. **headless GPU 偶发背压**：若连续压测过久，SwiftShader 仍可能让单帧 draw 出现秒级尖峰；本轮已通过按变化区间上传、不透明批次合批、增量命中代理把稳定态 p95 压到 16.8ms / 5.1ms；大量选中时半透明 run 增多，selected 场景实测 draw p95 242ms / max 23.3s，属于已知未达标项，真机仍需复核。
3. **首次布尔等待 Wasm**：布尔前会 `await` 内核初始化，并带 8s 超时、按钮 pending 与交互令牌取消；实测布尔本身约 0.18ms，主要成本仍是首次下载/实例化。
4. **文字/标注仍是 SVG/DOM overlay**：文字与几何分属 canvas 与 SVG 两个合成组，非不透明图层内文字与几何重叠时的组透明语义与旧 SVG 单组不完全等价；产品验收需确认。导出仍走 SVG 文档，不依赖当前后端。
5. **WebGPU 兼容性**：Safari/移动端或企业策略可能禁用 WebGPU，已由 Canvas2D 兜底；Canvas2D 也失败时仍有 SVG 最终回退。
6. **旧 golden 指标是冻结值**：`tests/boolean-golden.test.ts` 不再运行 polygon-clipping 参照实现。矩形类用例保留归一化 ring 拓扑（去共线、CCW、排序）对照；所有用例统一校验环闭合、无重复相邻点、无零面积碎片、外环 CCW、孔洞 CW 且孔洞位于外环内部。圆形结果仍无法逐顶点对照冻结 oracle，完整顶点等价视为 UNKNOWN。若未来故意调整布尔语义，需要同步更新这份夹具。
7. **渲染次序由深度测试恢复**：每个图层一个 pass，fill/stroke op 带按绘制次序递减的深度；提交时描边批次在前、填充批次在后，后画的半透明填充才能通过深度测试并与较早的描边混合。代价是多段折线的半透明描边在关节处会重复 alpha 混合（SVG/Canvas2D 的单 path 只混合一次），dash 相位也按实例/段重置；半透明 stroke 仍可正常参与 painter 顺序。`tests/browser/webgpu-z-order.spec.ts` 对 Canvas2D/WebGPU 做同场景像素对照，包含半透明填充覆盖描边的回归，但尚未逐点覆盖多折点关节。
8. **模块拆分**：`editor.ts`（状态机 + 指针/布尔，约 512 行）、`editor-text.ts`（内联文字）、`editor-ui.ts`（DOM 投影）、`editor-drawing.ts`（绘制纯函数）、`layers.ts`、`viewport.ts`、`export.ts`、`svg-document.ts`；`app.ts` 只保留启动、菜单、安装与 Service Worker 接线。`editor.ts` 略超 500 行，后续可按指针状态机再拆一层。
9. **布尔计算仍是主线程同步执行**：`withTimeout` 只包住内核加载；等待期间有「正在计算布尔结果…」状态，并新增 4 万顶点输入上限避免异常选区冻结 UI。但运行中的大布尔仍无法取消，ADR 期望的超过 200ms 取消尚未兑现；当前交互规模实测约 0.18ms，暂未引入 Worker。
10. **大量选中的 draw 次数**：2000 图元全部选中时，每个图元产生半透明光晕、半透明填充与不透明描边，`recordTranslucent` 会在 stroke/fill 交替处 flush，draw 次数随选中数线性增长。`scripts/perf-probe.mjs` 的 selected 场景（2000 选中、60 帧）实测 draw p50 4.5ms / p95 242ms / max 23.3s，当前不满足交互目标；需真机复核，并考虑合并半透明批次或只给可见选中绘制光晕。
11. **golden 冻结值可复现性**：冻结指标来自迁移期 vendored polygon-clipping 0.15.7，仓库已删除该实现；新增随机矩形解析面积不变量与重入不变量补足 oracle，但圆形逐顶点等价仍为 UNKNOWN。重新冻结需以固定版本重跑同一组用例。

## 6. 复现命令

```bash
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
node scripts/perf-probe.mjs
```

`scripts/perf-probe.mjs` 会自行创建并关闭 Vite dev server 与 Playwright 浏览器，不接触任何 daemon。
