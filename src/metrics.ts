/**
 * 统计层：从运行记录计算选择质量（precision/recall/集合命中）、任务成功率、成本与延迟分位，
 * 以及 B−A 的按任务聚类 bootstrap 区间；另提供开发集参数回放（tuning）与确定性 LCG 随机源。
 *
 * 警示：summarize / perArmSummary / selectorSummary / tuning 返回对象的键序直接进入
 * report.json 与 index.html 的字节序列，属于输出契约——只能换行排版，不能调整键序。
 */
import type { RunRecord, Prices } from './types.js'

/** 按分数降序选出达到阈值的技能；同分按名字 localeCompare 破平（依赖宿主 locale，前后对比须同机执行）。 */
export function selectedFromScores(scores: Record<string, number>, threshold: number) {
  return Object.entries(scores)
    .filter(([, p]) => p >= threshold)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name)
}

/** 等价组覆盖率：required 中至少一个成员出现在 names 里的组占比（无 required 时记 1）。 */
export function coverage(required: string[][], names: string[]) {
  return required.length ? required.filter(group => group.some(n => names.includes(n))).length / required.length : 1
}

/** 对给定选择集合打分：precision（不许选错）、recall（等价组必须覆盖）、exact（集合完全命中）。 */
export function selectionGrade(row: RunRecord, names = row.selected) {
  const allowed = new Set([...row.required.flat(), ...row.acceptable])
  const precision = names.length
    ? names.filter(n => allowed.has(n) && !row.forbidden.includes(n)).length / names.length
    : row.noSkill
      ? 1
      : 0
  const recall = coverage(row.required, [...row.existing, ...names])
  return {
    precision,
    recall,
    exact:
      recall === 1 &&
      names.every(n => allowed.has(n) && !row.forbidden.includes(n)) &&
      (!row.noSkill || names.length === 0),
  }
}

/** 均值；空集返回 null（与"未知"区分）。 */
const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null)

/** 经验分位（取排序后第 ceil(p·n) 个；p 取 0.025/0.975 用于 95% 区间）。 */
export function percentile(values: number[], p: number) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(p * sorted.length) - 1] ?? sorted[0]!
}

/** 一次运行的成本（单位与 --prices 一致，每百万 token）；未提供价格表时记 null。 */
export function costOf(row: Pick<RunRecord, 'typesafeUsage' | 'mainUsage'>, prices: Prices | null) {
  if (!prices) return null
  const t = row.typesafeUsage
  const m = row.mainUsage
  return (
    ((t?.input ?? 0) * prices.typesafeInput +
      (t?.output ?? 0) * prices.typesafeOutput +
      Math.max(0, (m?.input ?? 0) - (m?.cached ?? 0)) * prices.mainInput +
      (m?.cached ?? 0) * prices.mainCached +
      (m?.output ?? 0) * prices.mainOutput) /
    1e6
  )
}

/**
 * 确定性线性同余发生器（LCG）：state ← (state·1664525 + 1013904223) mod 2³²。
 * next() 给出原始 u32（洗牌取模用），nextFloat() 给出 [0,1)（bootstrap 抽样用）。
 * e2e 调度洗牌与 bootstrap 区间共用此实现，保证同 seed 下结果逐位可复现。
 */
export function makeLcg(seed: number) {
  let state = seed >>> 0
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0)
  return { next, nextFloat: () => next() / 2 ** 32 }
}

/** 通过率助手：把谓词映射为 0/1 后求均值。 */
const passRate = (filtered: RunRecord[], test: (r: RunRecord) => boolean) => mean(filtered.map(r => Number(test(r))))

/** B−A 的按任务聚类 bootstrap：以任务为聚类单位重抽样 2000 次，给出 95% 区间。 */
export function clusteredDifference(rows: RunRecord[]) {
  const ids = [...new Set(rows.filter(r => r.arm === 'A' || r.arm === 'B').map(r => r.caseId))]
  const differences = ids.flatMap(id => {
    const a = rows.filter(r => r.caseId === id && r.arm === 'A' && r.taskSuccess !== null)
    const b = rows.filter(r => r.caseId === id && r.arm === 'B' && r.taskSuccess !== null)
    return a.length && b.length
      ? [mean(b.map(r => Number(r.taskSuccess)))! - mean(a.map(r => Number(r.taskSuccess)))!]
      : []
  })
  if (!differences.length) return null
  const { nextFloat } = makeLcg(20261003)
  const samples = Array.from({ length: 2000 }, () =>
    mean(differences.map(() => differences[Math.floor(nextFloat() * differences.length)]!))!,
  )
  return {
    estimate: mean(differences),
    lower95: percentile(samples, 0.025),
    upper95: percentile(samples, 0.975),
    pairedTasks: differences.length,
  }
}

/** 装载链各环节的覆盖率：已可见 → 已选择 → 已准备 → 已提交 → 含补充加载的最终可见。 */
function loadingCoverageOf(trials: RunRecord[]) {
  return {
    existing: mean(trials.map(r => coverage(r.required, r.existing))),
    selected: mean(trials.map(r => coverage(r.required, [...r.existing, ...r.selected]))),
    prepared: mean(trials.map(r => coverage(r.required, [...r.existing, ...r.prepared]))),
    submitted: mean(
      trials.filter(r => r.submissionObserved).map(r => coverage(r.required, [...r.existing, ...r.submitted])),
    ),
    eventual: mean(
      trials
        .filter(r => r.submissionObserved)
        .map(r => coverage(r.required, [...r.existing, ...r.submitted, ...r.supplementalNames])),
    ),
  }
}

/** 单个臂（A/B/C）的汇总。complete 组 = 重复次数齐全且无 not-run 行。 */
function perArmSummary(trials: RunRecord[]) {
  const eligible = trials.filter(r => r.taskSuccess !== null)
  const groups = [...new Set(trials.map(r => r.caseId))].map(id => trials.filter(r => r.caseId === id))
  const complete = groups.filter(
    g =>
      new Set(g.map(r => r.repeat)).size === g[0]!.expectedRepeats &&
      g.length === g[0]!.expectedRepeats &&
      g.every(r => r.status !== 'not-run'),
  )
  const totalCost = trials.length && trials.every(r => r.cost !== null) ? trials.reduce((s, r) => s + r.cost!, 0) : null
  const successes = eligible.filter(r => r.taskSuccess).length
  return {
    trials: trials.length,
    evaluable: eligible.length,
    successRate: passRate(eligible, r => r.taskSuccess === true),
    allRepeatsSuccess: mean(complete.map(g => Number(g.every(r => r.taskSuccess === true)))),
    completeTaskGroups: complete.length,
    incompleteTaskGroups: groups.length - complete.length,
    repeatCounts: [...new Set(groups.map(g => g.filter(r => r.status !== 'not-run').length))],
    unattendedSuccess: passRate(eligible, r => r.taskSuccess === true && !r.interactionRequired),
    endToEndSuccessRate: passRate(trials, r => r.taskSuccess === true),
    loadingCoverage: loadingCoverageOf(trials),
    wallP50: percentile(
      trials.map(r => r.wallMs),
      0.5,
    ),
    wallP95: percentile(
      trials.map(r => r.wallMs),
      0.95,
    ),
    totalCost,
    costPerSuccess: totalCost !== null && successes ? totalCost / successes : null,
  }
}

/** 选择器维度的汇总；rows 用于全量口径（预处理失败/历史依赖/不可行计数），selector 仅为通过行。 */
function selectorSummary(rows: RunRecord[], selector: RunRecord[]) {
  // 重复一致性只在"重复次数齐全"的组上评估。
  const repeated = [...new Set(selector.map(r => r.caseId))]
    .map(id => selector.filter(r => r.caseId === id))
    .filter(
      g =>
        g.length > 1 &&
        g.length === g[0]!.expectedRepeats &&
        new Set(g.map(r => r.repeat)).size === g[0]!.expectedRepeats,
    )
  return {
    evaluated: selector.length,
    preprocessingFailures: rows.filter(r => ['failed', 'aborted'].includes(r.selectionStatus ?? '')).length,
    historyDependent: rows.filter(r => r.needsHistory).length,
    infeasible: rows.filter(r => !r.feasible).length,
    precision: mean(selector.map(r => selectionGrade(r).precision)),
    requiredRecall: mean(selector.map(r => selectionGrade(r).recall)),
    setPassRate: passRate(selector, r => selectionGrade(r).exact),
    noSkillFalseLoadRate: passRate(
      selector.filter(r => r.noSkill),
      r => r.selected.length > 0,
    ),
    preparedCoverage: mean(selector.map(r => coverage(r.required, [...r.existing, ...r.prepared]))),
    submittedCoverage: mean(
      selector.filter(r => r.submissionObserved).map(r => coverage(r.required, [...r.existing, ...r.submitted])),
    ),
    repeatConsistency: mean(
      repeated.map(g =>
        Number(g.every(r => JSON.stringify([...r.selected].sort()) === JSON.stringify([...g[0]!.selected].sort()))),
      ),
    ),
    categories: Object.fromEntries(
      [...new Set(selector.map(r => r.category))].map(c => {
        const group = selector.filter(r => r.category === c)
        return [c, { count: group.length, setPassRate: passRate(group, r => selectionGrade(r).exact) }]
      }),
    ),
  }
}

/** 全量汇总：一次运行（或其子集）的报告级指标。 */
export function summarize(rows: RunRecord[]) {
  const selector = rows.filter(r => r.arm === 'selector' && r.status === 'passed' && !r.needsHistory && r.feasible)
  const outcomes = rows.filter(r => r.arm !== 'selector')
  const selectionLatencies = rows.flatMap(r => (r.selectionMs === null ? [] : [r.selectionMs]))
  return {
    mode: [...new Set(rows.map(r => r.mode))],
    count: rows.length,
    statuses: Object.fromEntries(
      ['passed', 'task-failed', 'infrastructure-failed', 'cancelled', 'not-run'].map(s => [
        s,
        rows.filter(r => r.status === s).length,
      ]),
    ),
    selector: selectorSummary(rows, selector),
    perArm: Object.fromEntries(['A', 'B', 'C'].map(arm => [arm, perArmSummary(outcomes.filter(r => r.arm === arm))])),
    differenceBA: clusteredDifference(outcomes),
    totalTypesafeOutputTokens: rows.reduce((s, r) => s + (r.typesafeUsage?.output ?? 0), 0),
    totalMainOutputTokens: rows.reduce((s, r) => s + (r.mainUsage?.output ?? 0), 0),
    totalMainCachedTokens: rows.reduce((s, r) => s + (r.mainUsage?.cached ?? 0), 0),
    totalTypesafeInputTokens: rows.reduce((s, r) => s + (r.typesafeUsage?.input ?? 0), 0),
    totalMainInputTokens: rows.reduce((s, r) => s + (r.mainUsage?.input ?? 0), 0),
    latency: { selectionP50: percentile(selectionLatencies, 0.5), selectionP95: percentile(selectionLatencies, 0.95) },
    unknownUsage: {
      selector: rows.filter(r => (r.arm === 'selector' || r.arm === 'B') && r.typesafeUsage === null).length,
      main: outcomes.filter(r => r.mainUsage === null).length,
    },
    supplementalLoads: rows.reduce((s, r) => s + r.supplementalLoads, 0),
  }
}

/**
 * 开发集参数回放：在 dev split 已通过的选择记录上，重放（阈值 × 数量上限）组合，
 * 模拟 SUT 的准备语义（跳过超预算与不可用技能、填充数量上限），报告各组合的精度/召回/集合命中。
 * holdout 记录不参与，防止用保留集调参。
 */
export function tuning(rows: RunRecord[]) {
  const dev = rows.filter(r => r.arm === 'selector' && r.split === 'dev' && r.status === 'passed' && !r.needsHistory)
  return [0.5, 0.65, 0.75, 0.85, 0.9].flatMap(threshold =>
    [1, 3, 5].map(maxSkills => {
      const grades = dev.map(row => {
        const prepared: string[] = []
        let bytes = 0
        for (const name of selectedFromScores(row.scores, threshold)) {
          if (prepared.length >= maxSkills) break
          const size = row.bodyBytes[name]
          if (size === undefined || bytes + size > row.config.maxInjectedBytes) continue
          if (row.skipped.some(s => s.name === name && s.reason === 'unavailable')) continue
          if (row.existing.includes(name)) continue
          bytes += size
          prepared.push(name)
        }
        return selectionGrade(row, prepared)
      })
      return {
        threshold,
        maxSkills,
        samples: dev.length,
        precision: mean(grades.map(g => g.precision)),
        recall: mean(grades.map(g => g.recall)),
        setPassRate: mean(grades.map(g => Number(g.exact))),
      }
    }),
  )
}
