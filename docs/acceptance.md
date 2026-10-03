# 首版验收记录

日期：2026-10-03。目录：`/Users/yankaizhi/codebase/dsh-skill-evals`。Node v22.23.3，npm 12.1.0。

| 检查 | 新项目结果 |
| --- | --- |
| `npm ci` | 通过，从提交的锁文件安装 |
| `npm run typecheck` | 通过，严格 TypeScript |
| `npm test` | 5 个文件、58 项测试全部通过 |
| 编译/运行兼容门禁 | 固定 SUT 提交在 Harness/SDK 0.1.7-rc.1 上通过；原始 peer 与 Cordis 调整另列 |
| SDK 完整循环 smoke | A/B/C 启动真实 SDK 子进程；自主 skill 调用、资源读取、文件写入、模型请求和持久化重放通过 |
| SDK 预算/取消 | 请求限额及调用者取消测试通过，无付费调用 |
| A/B/C 一致性 | 相同目录、原生工具、provider/model、预算；真实请求工具 hash 一致 |
| 缺少凭据 | 独立 CLI 测试明确退出，未触发 live API |
| `npm run eval:offline` | 生成 420 条合成记录（240 选择、180 任务）及 JSON/CSV/HTML |
| `npm run report -- --input reports/offline/records.jsonl --output reports/replay` | 回放通过 |
| 原插件仓库 | 已跟踪文件无改动，原有未跟踪 REFACTOR-PLAN.md 保留 |
| 真实选择准确率、任务收益 | 未运行；由使用者显式启动手动评测 |

依赖调整：SDK 0.1.7-rc.1 要求 Cordis `~4.0.4`，因此实际固定 4.0.4。被测源码保持原提交；兼容报告保留其原始 peer 声明，不把功能通过宣称为原 package peer 范围满足。

安装期间 npm 的 advisory 查询提示 32 项 moderate，零 high/critical；数量为当时安装输出，随上游数据库变化。部分 native 包安装脚本被宿主 npm 策略阻止，实际 SDK 文件工具与 Session 测试通过。没有强制升级固定依赖或改变全局安装策略。

当前 Codex macOS 沙箱不支持 Harness shell 的嵌套 sandbox-exec，额外探测返回 SANDBOX_UNAVAILABLE。详见 baseline；首版 smoke 使用可正常运行的原生文件工具。手动任务遇到此宿主限制且不能恢复完成时计基础设施失败。

`reports/compatibility.json` 与 `.work/trials/` 保存本次实际兼容证据，默认 Git 忽略。`reports/offline/` 和 `reports/replay/` 明确标为 synthetic-demo，不是插件效果数据。此前 0.1.5-rc.3 的原项目测试结果仅在 baseline 作为背景描述。
