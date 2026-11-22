# vendor（已退役）

`polygon-clipping.js` 与 `polygon-clipping.d.ts` 已于 2026-11-21 删除。

应用和测试现在统一通过 `kernel.ts` 调用 `wasm/` 的 Rust/Wasm 内核；迁移期的
polygon-clipping 0.15.7 黄金指标已冻结在 `tests/boolean-golden.test.ts`，不再需要
第二套布尔实现。删除原因、实测数据和回退验证见 `docs/migration-report.md`。
