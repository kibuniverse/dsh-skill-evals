import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { summarize, selectedFromScores, selectionGrade } from './metrics.js'
import { saveJson } from './io.js'
import type { RunRecord } from './types.js'

const escape = (v: unknown) => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
export function tuning(rows: RunRecord[]) {
  const dev = rows.filter(r => r.arm === 'selector' && r.split === 'dev' && r.status === 'passed' && !r.needsHistory)
  return [0.5, 0.65, 0.75, 0.85, 0.9].flatMap(threshold => [1, 3, 5].map(maxSkills => {
    const grades = dev.map(row => {
      const prepared: string[] = []; let bytes = 0
      for (const name of selectedFromScores(row.scores, threshold)) {
        if (prepared.length >= maxSkills) break
        const size = row.bodyBytes[name]
        if (size === undefined || bytes + size > row.config.maxInjectedBytes) continue
        if (row.skipped.some(s => s.name === name && s.reason === 'unavailable')) continue
        if (row.existing.includes(name)) continue
        bytes += size; prepared.push(name)
      }
      return selectionGrade(row, prepared)
    })
    const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
    return { threshold, maxSkills, samples: dev.length, precision: mean(grades.map(g => g.precision)), recall: mean(grades.map(g => g.recall)), setPassRate: mean(grades.map(g => Number(g.exact))) }
  }))
}
export async function writeReport(rows: RunRecord[], dir: string) {
  await mkdir(dir, { recursive: true })
  const summary = summarize(rows)
  const bySplit = { dev: summarize(rows.filter(r => r.split === 'dev')), holdout: summarize(rows.filter(r => r.split === 'holdout')) }
  const report = { generatedAt: new Date().toISOString(), labelStatus: 'seed-labels-require-human-review', summary, bySplit, developmentSweep: tuning(rows), notes: ['synthetic-demo contains constructed scores/outcomes, not model performance.', 'completed/loaded audit fields do not prove submission or task success.', 'Missing prices produce unknown costs.', 'History-dependent and budget-infeasible cases are reported separately.', 'Selected is before count/byte caps; prepared/submitted coverage is reported separately.', 'Infrastructure failures are excluded from conditional task success but included in end-to-end success.', 'allRepeatsSuccess requires the full planned repeat count and counts infrastructure failures as unsuccessful; incomplete groups are reported separately.', 'Small seed sets do not establish statistically significant product gains.'] }
  await saveJson(join(dir, 'report.json'), report)
  const columns = ['caseId', 'arm', 'repeat', 'mode', 'split', 'status', 'selectionStatus', 'selectionFailure', 'taskSuccess', 'wallMs', 'selectionMs', 'injectedBytes', 'supplementalLoads', 'cost', 'failure'] as const
  const cell = (v: unknown) => '"' + (v === null ? '' : String(v)).replaceAll('"', '""') + '"'
  await writeFile(join(dir, 'trials.csv'), columns.join(',') + '\n' + rows.map(r => columns.map(c => cell(r[c])).join(',')).join('\n') + '\n')
  const synthetic = rows.some(r => r.mode === 'synthetic-demo')
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>DSH Skill Evals</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:0 24px;color:#17212e;background:#f7f9fc}table{border-collapse:collapse;width:100%;background:white}td,th{padding:10px;border-bottom:1px solid #ddd;text-align:left}pre{white-space:pre-wrap;background:white;padding:20px;border-radius:8px}.notice{padding:16px;background:#fff1ce;border-radius:8px}h1{font-size:30px}</style><h1>DSH Skill Evals</h1><p class="notice">${synthetic ? '示例回放：分数和任务结果为合成数据，不能作为插件效果结论。' : '运行记录报告。种子标签仍需要人工复核；费用缺失显示为 null。'}</p><p>运行数：${rows.length} · 生成时间：${escape(report.generatedAt)}</p><h2>汇总指标</h2><pre>${escape(JSON.stringify(summary, null, 2))}</pre><h2>任务明细</h2><table><thead><tr><th>用例</th><th>组别</th><th>重复</th><th>状态</th><th>任务成功</th><th>耗时 ms</th></tr></thead><tbody>${rows.map(r => `<tr><td>${escape(r.caseId)}</td><td>${escape(r.arm)}</td><td>${r.repeat}</td><td>${escape(r.status)}</td><td>${escape(r.taskSuccess)}</td><td>${Math.round(r.wallMs)}</td></tr>`).join('')}</tbody></table><h2>失败明细</h2><pre>${escape(JSON.stringify(rows.filter(r => !['passed', 'not-run'].includes(r.status)).map(r => ({ caseId: r.caseId, arm: r.arm, repeat: r.repeat, status: r.status, failure: r.failure, artifacts: r.artifacts })), null, 2))}</pre><h2>开发集参数回放</h2><pre>${escape(JSON.stringify(report.developmentSweep, null, 2))}</pre><h2>统计说明</h2><ul>${report.notes.map(n => `<li>${escape(n)}</li>`).join('')}</ul></html>`
  await writeFile(join(dir, 'index.html'), html)
  return report
}
