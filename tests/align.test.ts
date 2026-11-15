import { describe, expect, it } from 'vitest'
import { buildManuscript, computePairAlignment } from '../src/core/pipeline'
import { defaultNormConfig } from '../src/core/normalize'
import { CanceledError } from '../src/core/align/align'
import { runDp, backtrace, enumerateOptimalPaths } from '../src/core/align/dp'
import { normalize } from '../src/core/normalize'

const cfg = defaultNormConfig()

async function pair(aText: string, bText: string, overrides?: Partial<ReturnType<typeof defaultNormConfig>>) {
  const a = await buildManuscript('a', '甲', '', aText)
  const b = await buildManuscript('b', '乙', '', bText)
  const c = { ...cfg, ...overrides, costs: { ...cfg.costs, ...(overrides?.costs ?? {}) } }
  const { alignment, moves } = computePairAlignment(a, b, c, [], [])
  return { a, b, alignment, moves, cfg: c }
}

describe('DP 对齐引擎', () => {
  it('给出最小代价结果，同价多前驱全部保留', async () => {
    const { a, b } = await pair('甲乙丙', '甲丁丙')
    const na = normalize(a, cfg).tokens
    const nb = normalize(b, cfg).tokens
    const r = runDp(na, nb, cfg.costs)
    // 替换一次（代价 2）小于删+插（代价 2 时相等；默认 sub=2 与 ins+del=2 同分）
    expect(r.cost).toBeLessThanOrEqual(2)
    const { ops } = backtrace(r)
    expect(ops.some((o) => o.kind === 'sub')).toBe(true)
  })

  it('可配置代价：提高替换代价后改为插入+删除', async () => {
    const a = await buildManuscript('a', '甲', '', '甲乙丙')
    const b = await buildManuscript('b', '乙', '', '甲丁丙')
    const expensive = { ...cfg, costs: { insert: 1, delete: 1, substitute: 5 } }
    const { alignment } = computePairAlignment(a, b, expensive, [], [])
    const ops = alignment.segments.flatMap((s) => s.columns)
    expect(ops.some((c) => c.kind === 'gapA' || c.kind === 'gapB')).toBe(true)
    expect(ops.every((c) => c.kind !== 'sub')).toBe(true)
  })

  it('连续缺句表现为连续 gap，而不是整页错位替换', async () => {
    const { alignment } = await pair('學而時習之有朋自遠方來樂亦在其中', '學而時習之樂亦在其中')
    const cols = alignment.segments.flatMap((s) => s.columns)
    const gaps = cols.filter((c) => c.kind === 'gapB')
    expect(gaps.length).toBe(6) // 有朋自遠方來 六字
    // 缺句之后仍能正确配对，没有大规模替换
    expect(cols.filter((c) => c.kind === 'sub')).toHaveLength(0)
  })

  it('重复短句同分时枚举多个可选方案，不固定取左侧', async () => {
    const a = await buildManuscript('a', '甲', '', '溫故而知新溫故而知新可以為師')
    const b = await buildManuscript('b', '乙', '', '溫故而知新可以為師')
    const na = normalize(a, cfg).tokens
    const nb = normalize(b, cfg).tokens
    const r = runDp(na, nb, cfg.costs)
    const { tieCells } = backtrace(r)
    expect(tieCells.length).toBeGreaterThan(0)
    const paths = enumerateOptimalPaths(r, 0, 0, r.n, r.m, 8)
    const distinct = new Set(paths.map((p) => JSON.stringify(p.ops)))
    expect(distinct.size).toBeGreaterThan(1)
  })

  it('任务取消抛出 CanceledError，不产出半成品对齐', async () => {
    const a = await buildManuscript('a', '甲', '', '學而時習之'.repeat(40))
    const b = await buildManuscript('b', '乙', '', '學而時習之'.repeat(40))
    const signal = { canceled: true }
    expect(() => computePairAlignment(a, b, cfg, [], [], signal)).toThrow(CanceledError)
  })
})

describe('分块接缝', () => {
  it('小块配置下接缝核验通过，块边界缺字不被当作异文', async () => {
    const text = '道可道非常道名可名非常名無名天地之始有名萬物之母'
    const { alignment } = await pair(text + '恆也', text, { chunkSize: 12, overlapSize: 4 })
    for (const seg of alignment.segments) {
      expect(seg.chunkHash).toBeTruthy()
    }
    const cols = alignment.segments.flatMap((s) => s.columns)
    // 仅允许末尾两个 gap（恆、也），接缝处不得出现 sub
    const subs = cols.filter((c) => c.kind === 'sub')
    expect(subs).toHaveLength(0)
    expect(cols.filter((c) => c.kind === 'gapB')).toHaveLength(2)
    expect(alignment.segments.every((s) => s.seamVerified)).toBe(true)
  })
})

describe('移段检测', () => {
  it('整段迁移产生移段候选，原位置与新位置区间均可回查', async () => {
    const a = await buildManuscript('a', '甲', '', '開篇之言君子食無求飽居無求安敏於事末章之句')
    const b = await buildManuscript('b', '乙', '', '開篇之言末章之句君子食無求飽居無求安敏於事')
    const { moves } = computePairAlignment(a, b, cfg, [], [])
    expect(moves.length).toBeGreaterThan(0)
    const m = moves[0]
    expect(m.deleteRun.end).toBeGreaterThan(m.deleteRun.start)
    expect(m.insertRun.end).toBeGreaterThan(m.insertRun.start)
    expect(m.similarity).toBeGreaterThanOrEqual(cfg.moveThreshold)
    expect(m.status).toBe('suggested') // 仅建议，未自动确认
  })
})
