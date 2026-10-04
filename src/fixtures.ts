/**
 * 跨进程共享的评测夹具，零内部依赖（不 import 本仓库其他模块）。
 *
 * responseFor 同时被两处使用：主进程的 component.ts（进程内组件测试）与
 * SDK 子进程的 runtime-plugin.ts（离线 fixture 模式）。保持零依赖是为了让
 * 子进程里的 dist/runtime-plugin.js 不再传递加载测试脚手架（component/setup/io 整条链）。
 */

/** 按打分函数构造一份离线选择响应，形状与真实 TypeSafe API 的应答一致。 */
export function responseFor(body: Record<string, unknown>, score: (name: string) => number) {
  const questions = body.questions as Record<string, { instructions: { skill: { name: string } } }>
  return {
    model: 'fixture-model',
    answers: Object.fromEntries(
      Object.entries(questions).map(([id, q]) => [id, { type: 'noul', noul: score(q.instructions.skill.name) }]),
    ),
    usage: { input_tokens: 100, output_tokens: Object.keys(questions).length },
  }
}
