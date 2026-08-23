# 项目规则

## 改动流程（任何改动，必须遵守）

任何改动——代码、文档、配置，再小也不例外——都走 GitHub issue 闭环：

1. **改前先建 issue**：说明改什么、为什么、怎么验收。没有 issue 不动手。
2. **改中关联**：commit message 里带上对应 issue 号（`Refs #N`；收尾 commit 用 `Closes #N`，推送后自动关闭）。
3. **完成后更新 issue**：关闭不是终点——在 issue 里补一条结果说明：实现要点、测试/联调验证情况、遗留事项。

临时排查、只读操作不需要 issue；一旦产生文件改动，补建 issue 再提交。

## 提交约定

- 中文 subject，前缀按类型：`T<N>:`（编号工单）、`feat:`、`fix:`、`test:`、`docs:` 等
- commit 结尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- 提交前 typecheck / lint / test 全绿
