# dsh-skill-evals

独立评测 `dsh-skill-auto-load-typesafe` 的本地仓库。首版交付回归门禁、真实选择器入口、SDK 完整任务 A/B/C 对照、80 条选择种子和 20 个可自动验收任务。种子标签尚需人工复核；离线示例不代表真实准确率或收益。

## 安装和验收

需要 Node 22.19+（或 24+）、npm、Git，以及本地被测插件仓库。

```sh
cd /Users/yankaizhi/codebase/dsh-skill-evals
npm ci
npm run typecheck
npm test
npm run eval:offline
npm run report -- --input reports/offline/records.jsonl --output reports/replay
```

`npm test` 先运行编译与真实 SDK 循环兼容门禁，再运行 Vitest。默认测试使用固定 TypeSafe 响应与内存模型 adapter；子进程不继承个人凭据，拒绝意外网络请求，不需要 API key。

| 命令 | 作用 |
| --- | --- |
| `npm run setup:sut` | 导出固定提交、编译、挂载、注入、持久化和关闭 SDK 进程 |
| `npm test` | 插件入口回归、指标/评分器、真实 SDK 多轮工具调用与 Session 重放 |
| `npm run typecheck` | 严格类型检查 |
| `npm run eval:offline` | 合成示例记录与报告；`--input` 可回放已有记录 |
| `npm run eval:selector` | 手动启动真实 TypeSafe 选择器评测 |
| `npm run eval:e2e` | 手动启动真实主模型 20×3×3 对照 |
| `npm run report` | 从 `--input` JSONL 重新生成 JSON/CSV/HTML |

## 被测提交和版本

默认源码为 `/Users/yankaizhi/codebase/dsh-skill-auto-load-typesafe` 的 `e11e698f3773f1e7c886a464e8156b5c386e48bc`。使用 `git show` 导出已提交源码到忽略的 `.work/sut`，在新项目的依赖下编译，不写原仓库。

```sh
npm run setup:sut -- --sut-path /path/to/plugin --sut-ref COMMIT
npm run eval:offline -- --sut-path /path/to/plugin --sut-ref COMMIT
```

Harness、SDK 和相关 DSH 包固定 `0.1.7-rc.1`。**Cordis 为 4.0.4**：所选 SDK 的 peer 要求 `~4.0.4`，原计划的 4.0.2 无法满足；没有通过 `--force` 忽略依赖冲突。兼容门禁不改被测源码，编译或运行失败时写 `reports/compatibility.json` 并阻止真实评测。

## 真实选择器评测

凭据只从环境变量读取；`.env.example` 是变量名说明，项目不会自动加载 `.env`。

```sh
# 在当前 shell 设置 TYPESAFE_API_KEY 后手动执行：
npm run eval:selector -- --split dev --output reports/selector-dev
# 根据开发集 15 组回放比较选择参数，可重新运行所选开发配置：
npm run eval:selector -- --split dev --threshold 0.85 --max-skills 3 --output reports/selected-dev
# 保留集必须读取冻结配置，不能同时覆盖阈值、数量或 TypeSafe model：
npm run eval:selector -- --split holdout --selection-config reports/selected-dev/frozen-config.json --output reports/selector-holdout
```

默认阈值 0.75、数量 3、TypeSafe `jev-latest`，记录响应中返回的实际版本。默认每条 3 次，串行运行，无应用层自动重试，选择器总超时 5 秒。`--limit 2 --repeats 1` 可缩小手动试运行。80 条用例按任务家族分成开发 40、保留 40；同一家族的改写不会跨集合。

实时命令禁止 `--split all`。报告仅用开发分数比较阈值 `0.5/0.65/0.75/0.85/0.9` 与数量 `1/3/5`；数量回放使用正文 UTF-8 字节预算。冻结文件保存目录/正文 hash 和开发记录 hash，保留集只运行该配置。

## 完整任务对照

必须显式提供 provider、model，设置 `DEEPSEEK_API_KEY` 和 `TYPESAFE_API_KEY`；目前内置真实 provider 是 `deepseek-official`。需要其他 provider 时应单独实现受控 adapter 和凭据配置。

```sh
npm run eval:e2e -- --provider deepseek-official --model MODEL_ID --output reports/e2e
# 小规模手动验证：
npm run eval:e2e -- --provider deepseek-official --model MODEL_ID --limit 1 --repeats 1 --output reports/e2e-small
```

20 个任务包含代码修复、缺陷审查、CSV 汇总、JSON 校验和文件报告各 4 个。默认每任务每组 3 次，共 180 次，使用 `--seed`（默认 20261003）随机安排顺序，并保存运行计划。

- A 关闭自动加载插件；B 挂载被测插件；C 按标签注入正确 skill，作为诊断对照。
- 三组保留同一冻结目录、原生 `skill` 自主加载、文件工具和同样的输入/预算。C 使用同一个 `renderSkillContent`；A/B 的 Agent 配置中没有标签、grader 或参考答案。
- SDK 实际启动 `dsh --profile sdk`。每次有独立工作目录、Harness home、审计存储、会话。禁用个人文件 skill、office skill、额外 provider、网页工具、标题模型、自动重试和遥测；凭据服务只读本次环境。
- 最多 20 次主模型请求，每次输出上限 4096 token，总耗时 120 秒。预算耗尽记录取消；Ctrl-C 取消本次运行并停止后续计划。未执行的完整任务保留 `not-run` 记录。
- 工具目录、provider/model 与输入预算进入对照 hash，自动检查组间一致性；SDK smoke 也检查真实请求的工具一致。

## 记录、评分与报告

`reports/<run>/records.jsonl` 保存验证过的逐次记录；`report.json`、`trials.csv`、`index.html` 可随时重建。真实 SDK 原始请求、usage、Session、工具执行和插件审计在忽略的 `.work/trials/` 独立 trial 路径，记录中给出路径；评分在子进程关闭之后执行，答案仅存在评测程序侧。

分别记录候选分数、阈值选择、准备注入、实际请求中可见正文、自主补充加载，以及版本、hash、配置、任务结果、耗时和 usage。`selected` 是阈值筛选后的集合；`prepared` 受数量/字节限制；插件审计 `loaded/completed` 只表示准备阶段。选择器组件评测没有主模型请求，因此实际提交 coverage 显示未知。自主加载次数按成功的原生调用计数（包括重复调用），最终 coverage 只使用实际请求中可见的技能集合。

报告包含 precision、必需组 recall、无技能误加载、集合达标、重复一致性、各加载阶段 coverage、任务成功、全部重复成功、B−A 按任务聚类 bootstrap 95% 区间（2000 次）以及 p50/p95、token、失败明细和总成本/成功次数。基础设施失败单独统计；条件成功率排除它们，端到端成功率计入。全部重复成功要求计划次数完整，基础设施失败算不成功，未完整组另列。小样本区间不是产品提升证明。

价格默认未知。`--prices PATH` 可以提供同一货币每百万 token 的 `typesafeInput/typesafeOutput/mainInput/mainOutput/mainCached` 五项非负价格，格式见 `data/prices.schema.json`。usage 或价格缺失时成本为 `null`，不填零。审计区间延迟包括评分与准备加载，不是纯 API 服务端延迟。

## 目录

- `src/cli.ts`、`src/commands/`：CLI 入口（校验与分发）与各命令实现（offline/selector/e2e/report）及共享 flag 定义。
- `src/gate.ts`、`src/setup.ts`：运行前兼容门禁（导出、编译、SDK 冒烟）；SUT 固定提交导出与编译。
- `src/component.ts`、`src/fixtures.ts`、`tests/plugin.test.ts`：进程内 Cordis 组件测试载体、跨进程共享离线夹具与工程回归。
- `src/sdk-runner.ts`、`src/runtime-plugin.ts`、`src/captures.ts`：SDK 子进程运行器、评测运行时插件（冻结目录、请求捕获、预算、离线 adapter）与捕获分析。
- `src/record.ts`、`src/evaluate.ts`、`src/grader.ts`：基线记录构造、live 评测编排（选择/任务）与 Agent 外评分器。
- `src/metrics.ts`、`src/report.ts`：指标与参数回放、报告渲染（JSON/CSV/HTML）。
- `src/types.ts`、`src/dataset.ts`、`src/io.ts`：全部 zod schema 与类型、数据装载、共享 IO 与环境白名单。
- `data/selection.json`、`data/tasks.json`、`data/skills.json`：独立种子数据。
- `docs/methodology.md`：评测依据和统计边界。
- `docs/baseline.md`：此前原项目检查与本仓库结果的区别。
- `docs/acceptance.md`：本次命令、测试及宿主限制的验收记录。

首次交付不运行付费 API、不预设提升结论。使用真实环境前应人工复核种子标签；文件任务的确定性验收覆盖明确行为，对代码审查正文质量还需人工复核。
