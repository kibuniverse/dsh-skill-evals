# 评测依据

检索日期：2026-10-03。公开资料建议同时检查任务结果与执行轨迹，使用可复现任务、明确成功条件和多次运行，并区分基础设施噪声与能力问题。

- [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)：任务、重复运行、轨迹与结果共同构成评测；确定性检查与人工判断适用于不同问题。
- [OpenAI: Testing Agent Skills Systematically with Evals](https://developers.openai.com/blog/eval-skills)：捕获运行轨迹和产物，再按小组检查生成可比较分数。
- [OpenAI: Trace grading](https://developers.openai.com/api/docs/guides/trace-grading)：对完整决策与工具执行过程打分，可定位单看最终回答发现不了的问题。

本仓库据此分成工程门禁、选择器质量、完整任务收益三层。代码回归证明接入契约；选择器分数评估 routing；A/B/C 加任务产物验收判断真实收益。C 是诊断上限参照，不能解释为生产收益。

## 标签和边界

`required` 是数组的数组：每个内部组任意一个等价 skill 满足该要求；`acceptable` 允许额外加载但不增加必需 recall；`forbidden` 的加载使集合不达标。`noSkill`、`needsHistory`、`feasible` 单独记录。当前插件只把直接用户文本交给 TypeSafe，历史指代不混入主选择指标。正文不足、预算限制与准备阶段错误也不能用候选分数替代。

目录和标签是人工编写的种子，不是人工复核后的生产基准。当前 20 项完整任务都是小型、可确定性验收的文件任务；不能外推至飞书/日历、真实部署、长时间任务或工具网络副作用。审查任务按缺陷类别和有效解释字段验收，还需人工审核解释质量。

## 统计约定

选择 precision 是逐次运行宏平均；必需 recall 对等价要求组计数；已有可见技能参与 coverage。无技能误加载率只在无技能样本上计算。集合达标同时要求必需组覆盖、无禁止/未知附加项、无技能时集合为空。重复一致性比较排序后的选择集合。

任务条件成功率仅用有明确任务结果的运行；端到端成功率的分母为记录的计划运行，基础设施失败、取消和未运行均不算成功。全部重复成功仅对达到计划重复次数的任务组计算，并展示未完整组数。B−A 区间按共同可评估任务聚类，先对每个任务各组的重复结果取均值，再重采样任务；缺失对照任务不进入区间。报告不自动宣称显著提升。

价格由调用者提供，保持同一货币。SDK 的 uncached/cache-read/cache-write 输入 token 是分离字段；主模型输入总量包含三者，费用分别计 cached read 和其余输入。付费失败导致 usage 不可得时费用为未知。原始审计/Session 均保存在 Agent 工作区之外。
