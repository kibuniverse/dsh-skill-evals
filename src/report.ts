/**
 * 序列化层：把运行记录渲染为三种产物——report.json（全量汇总 + 开发集参数回放 + 口径说明）、
 * trials.csv（每条记录一行的精简视图）、index.html（人读报告）。
 * 指标计算在 metrics.ts，这里只负责渲染与落盘。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { summarize, tuning } from './metrics.js'
import { saveJson } from './io.js'
import type { RunRecord } from './types.js'

/** HTML 转义（文本与属性共用）。 */
const escape = (v: unknown) =>
  String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** trials.csv 的列（顺序即输出列序）。 */
const TRIAL_COLUMNS = [
  'caseId',
  'arm',
  'repeat',
  'mode',
  'split',
  'status',
  'selectionStatus',
  'selectionFailure',
  'taskSuccess',
  'wallMs',
  'selectionMs',
  'injectedBytes',
  'supplementalLoads',
  'cost',
  'failure',
] as const

/** CSV 单元格：null 记为空串，双引号翻倍转义。 */
const cell = (v: unknown) => '"' + (v === null ? '' : String(v)).replaceAll('"', '""') + '"'

/** 统计口径说明，同时进入 report.json 与 index.html（文字属于输出契约，勿改写）。 */
const NOTES = [
  'synthetic-demo contains constructed scores/outcomes, not model performance.',
  'completed/loaded audit fields do not prove submission or task success.',
  'Missing prices produce unknown costs.',
  'History-dependent and budget-infeasible cases are reported separately.',
  'Selected is before count/byte caps; prepared/submitted coverage is reported separately.',
  'Infrastructure failures are excluded from conditional task success but included in end-to-end success.',
  'allRepeatsSuccess requires the full planned repeat count and counts infrastructure failures as unsuccessful; incomplete groups are reported separately.',
  'Small seed sets do not establish statistically significant product gains.',
]

/** 生成报告：写 report.json / trials.csv / index.html，返回 report 对象。 */
export async function writeReport(rows: RunRecord[], dir: string) {
  await mkdir(dir, { recursive: true })
  const summary = summarize(rows)
  // dev / holdout 永远各出一份子汇总（空集也保留），便于分侧对照。
  const bySplit = {
    dev: summarize(rows.filter(r => r.split === 'dev')),
    holdout: summarize(rows.filter(r => r.split === 'holdout')),
  }
  const report = {
    generatedAt: new Date().toISOString(),
    labelStatus: 'seed-labels-require-human-review',
    summary,
    bySplit,
    developmentSweep: tuning(rows),
    notes: NOTES,
  }
  await saveJson(join(dir, 'report.json'), report)
  await writeFile(
    join(dir, 'trials.csv'),
    TRIAL_COLUMNS.join(',') + '\n' + rows.map(r => TRIAL_COLUMNS.map(c => cell(r[c])).join(',')).join('\n') + '\n',
  )
  const synthetic = rows.some(r => r.mode === 'synthetic-demo')
  // 注意：模板内不得引入换行或空格变化——index.html 的字节序列本身就是输出契约。
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>DSH Skill Evals</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:0 24px;color:#17212e;background:#f7f9fc}table{border-collapse:collapse;width:100%;background:white}td,th{padding:10px;border-bottom:1px solid #ddd;text-align:left}pre{white-space:pre-wrap;background:white;padding:20px;border-radius:8px}.notice{padding:16px;background:#fff1ce;border-radius:8px}h1{font-size:30px}</style><h1>DSH Skill Evals</h1><p class="notice">${synthetic ? '示例回放：分数和任务结果为合成数据，不能作为插件效果结论。' : '运行记录报告。种子标签仍需要人工复核；费用缺失显示为 null。'}</p><p>运行数：${rows.length} · 生成时间：${escape(report.generatedAt)}</p><h2>汇总指标</h2><pre>${escape(JSON.stringify(summary, null, 2))}</pre><h2>任务明细</h2><table><thead><tr><th>用例</th><th>组别</th><th>重复</th><th>状态</th><th>任务成功</th><th>耗时 ms</th></tr></thead><tbody>${rows.map(r => `<tr><td>${escape(r.caseId)}</td><td>${escape(r.arm)}</td><td>${r.repeat}</td><td>${escape(r.status)}</td><td>${escape(r.taskSuccess)}</td><td>${Math.round(r.wallMs)}</td></tr>`).join('')}</tbody></table><h2>失败明细</h2><pre>${escape(
    JSON.stringify(
      rows
        .filter(r => !['passed', 'not-run'].includes(r.status))
        .map(r => ({
          caseId: r.caseId,
          arm: r.arm,
          repeat: r.repeat,
          status: r.status,
          failure: r.failure,
          artifacts: r.artifacts,
        })),
      null,
      2,
    ),
  )}</pre><h2>开发集参数回放</h2><pre>${escape(JSON.stringify(report.developmentSweep, null, 2))}</pre><h2>统计说明</h2><ul>${report.notes.map(n => `<li>${escape(n)}</li>`).join('')}</ul></html>`
  await writeFile(join(dir, 'index.html'), html)
  return report
}
