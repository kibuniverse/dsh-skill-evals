import type { RunRecord, Prices } from './types.js'

export function selectedFromScores(scores: Record<string, number>, threshold: number) {
  return Object.entries(scores).filter(([, p]) => p >= threshold).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name)
}
export function coverage(required: string[][], names: string[]) {
  return required.length ? required.filter(group => group.some(n => names.includes(n))).length / required.length : 1
}
export function selectionGrade(row: RunRecord, names = row.selected) {
  const allowed = new Set([...row.required.flat(), ...row.acceptable])
  const precision = names.length ? names.filter(n => allowed.has(n) && !row.forbidden.includes(n)).length / names.length : row.noSkill ? 1 : 0
  const recall = coverage(row.required, [...row.existing, ...names])
  return { precision, recall, exact: recall === 1 && names.every(n => allowed.has(n) && !row.forbidden.includes(n)) && (!row.noSkill || names.length === 0) }
}
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
export function percentile(values: number[], p: number) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b); return sorted[Math.ceil(p * sorted.length) - 1] ?? sorted[0]!
}
export function costOf(row: Pick<RunRecord, 'typesafeUsage' | 'mainUsage'>, prices: Prices | null) {
  if (!prices) return null
  const t = row.typesafeUsage; const m = row.mainUsage
  return ((t?.input ?? 0) * prices.typesafeInput + (t?.output ?? 0) * prices.typesafeOutput + Math.max(0, (m?.input ?? 0) - (m?.cached ?? 0)) * prices.mainInput + (m?.cached ?? 0) * prices.mainCached + (m?.output ?? 0) * prices.mainOutput) / 1e6
}
export function clusteredDifference(rows: RunRecord[]) {
  const ids = [...new Set(rows.filter(r => r.arm === 'A' || r.arm === 'B').map(r => r.caseId))]
  const differences = ids.flatMap(id => {
    const a = rows.filter(r => r.caseId === id && r.arm === 'A' && r.taskSuccess !== null)
    const b = rows.filter(r => r.caseId === id && r.arm === 'B' && r.taskSuccess !== null)
    return a.length && b.length ? [mean(b.map(r => Number(r.taskSuccess)))! - mean(a.map(r => Number(r.taskSuccess)))!] : []
  })
  if (!differences.length) return null
  let seed = 20261003
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
  const samples = Array.from({ length: 2000 }, () => mean(differences.map(() => differences[Math.floor(random() * differences.length)]!))!)
  return { estimate: mean(differences), lower95: percentile(samples, 0.025), upper95: percentile(samples, 0.975), pairedTasks: differences.length }
}
export function summarize(rows: RunRecord[]) {
  const selector = rows.filter(r => r.arm === 'selector' && r.status === 'passed' && !r.needsHistory && r.feasible)
  const outcomes = rows.filter(r => r.arm !== 'selector')
  const rate = (filtered: RunRecord[], test: (r: RunRecord) => boolean) => mean(filtered.map(r => Number(test(r))))
  const perArm = Object.fromEntries(['A', 'B', 'C'].map(arm => {
    const trials = outcomes.filter(r => r.arm === arm)
    const eligible = trials.filter(r => r.taskSuccess !== null)
    const groups = [...new Set(trials.map(r => r.caseId))].map(id => trials.filter(r => r.caseId === id))
    const complete = groups.filter(g => new Set(g.map(r => r.repeat)).size === g[0]!.expectedRepeats && g.length === g[0]!.expectedRepeats && g.every(r => r.status !== 'not-run'))
    const totalCost = trials.length && trials.every(r => r.cost !== null) ? trials.reduce((s, r) => s + r.cost!, 0) : null
    const successes = eligible.filter(r => r.taskSuccess).length
    return [arm, { trials: trials.length, evaluable: eligible.length, successRate: rate(eligible, r => r.taskSuccess === true), allRepeatsSuccess: mean(complete.map(g => Number(g.every(r => r.taskSuccess === true)))), completeTaskGroups: complete.length, incompleteTaskGroups: groups.length - complete.length, repeatCounts: [...new Set(groups.map(g => g.filter(r => r.status !== 'not-run').length))], unattendedSuccess: rate(eligible, r => r.taskSuccess === true && !r.interactionRequired), endToEndSuccessRate: rate(trials, r => r.taskSuccess === true), loadingCoverage: { existing: mean(trials.map(r => coverage(r.required, r.existing))), selected: mean(trials.map(r => coverage(r.required, [...r.existing, ...r.selected]))), prepared: mean(trials.map(r => coverage(r.required, [...r.existing, ...r.prepared]))), submitted: mean(trials.filter(r => r.submissionObserved).map(r => coverage(r.required, [...r.existing, ...r.submitted]))), eventual: mean(trials.filter(r => r.submissionObserved).map(r => coverage(r.required, [...r.existing, ...r.submitted, ...r.supplementalNames]))) }, wallP50: percentile(trials.map(r => r.wallMs), .5), wallP95: percentile(trials.map(r => r.wallMs), .95), totalCost, costPerSuccess: totalCost !== null && successes ? totalCost / successes : null }]
  }))
  const repeated = [...new Set(selector.map(r => r.caseId))].map(id => selector.filter(r => r.caseId === id)).filter(g => g.length > 1 && g.length === g[0]!.expectedRepeats && new Set(g.map(r => r.repeat)).size === g[0]!.expectedRepeats)
  return {
    mode: [...new Set(rows.map(r => r.mode))], count: rows.length,
    statuses: Object.fromEntries(['passed', 'task-failed', 'infrastructure-failed', 'cancelled', 'not-run'].map(s => [s, rows.filter(r => r.status === s).length])),
    selector: { evaluated: selector.length, preprocessingFailures: rows.filter(r => ['failed', 'aborted'].includes(r.selectionStatus ?? '')).length, historyDependent: rows.filter(r => r.needsHistory).length, infeasible: rows.filter(r => !r.feasible).length,
      precision: mean(selector.map(r => selectionGrade(r).precision)), requiredRecall: mean(selector.map(r => selectionGrade(r).recall)), setPassRate: rate(selector, r => selectionGrade(r).exact), noSkillFalseLoadRate: rate(selector.filter(r => r.noSkill), r => r.selected.length > 0),
      preparedCoverage: mean(selector.map(r => coverage(r.required, [...r.existing, ...r.prepared]))), submittedCoverage: mean(selector.filter(r => r.submissionObserved).map(r => coverage(r.required, [...r.existing, ...r.submitted]))),
      repeatConsistency: mean(repeated.map(g => Number(g.every(r => JSON.stringify([...r.selected].sort()) === JSON.stringify([...g[0]!.selected].sort()))))),
      categories: Object.fromEntries([...new Set(selector.map(r => r.category))].map(c => { const group = selector.filter(r => r.category === c); return [c, { count: group.length, setPassRate: rate(group, r => selectionGrade(r).exact) }] })),
    }, perArm, differenceBA: clusteredDifference(outcomes),
    totalTypesafeOutputTokens: rows.reduce((s, r) => s + (r.typesafeUsage?.output ?? 0), 0), totalMainOutputTokens: rows.reduce((s, r) => s + (r.mainUsage?.output ?? 0), 0), totalMainCachedTokens: rows.reduce((s, r) => s + (r.mainUsage?.cached ?? 0), 0),
    totalTypesafeInputTokens: rows.reduce((s, r) => s + (r.typesafeUsage?.input ?? 0), 0), totalMainInputTokens: rows.reduce((s, r) => s + (r.mainUsage?.input ?? 0), 0),
    latency: { selectionP50: percentile(rows.flatMap(r => r.selectionMs === null ? [] : [r.selectionMs]), .5), selectionP95: percentile(rows.flatMap(r => r.selectionMs === null ? [] : [r.selectionMs]), .95) },
    unknownUsage: { selector: rows.filter(r => (r.arm === 'selector' || r.arm === 'B') && r.typesafeUsage === null).length, main: outcomes.filter(r => r.mainUsage === null).length },
    supplementalLoads: rows.reduce((s, r) => s + r.supplementalLoads, 0),
  }
}
