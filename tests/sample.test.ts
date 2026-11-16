import { describe, expect, it } from 'vitest'
import { buildSampleManuscripts, SAMPLE_INPUTS } from '../src/core/sample'
import { computePairAlignment } from '../src/core/pipeline'
import { defaultNormConfig, normalize } from '../src/core/normalize'
import { buildMultiColumns } from '../src/core/align/align'

// 验证页面上的差异与出处确实由输入计算生成，而非预排对照表。
describe('虚构样例五类情形（计算生成）', () => {
  it('样例包含四个底本', async () => {
    const mss = await buildSampleManuscripts()
    expect(mss.map((m) => m.id)).toEqual(SAMPLE_INPUTS.map((s) => s.id))
  })

  it('1) 异体归一：乙本「旹」对齐甲本「時」，原文写法保留可反查', async () => {
    const [jia, yi] = await buildSampleManuscripts()
    const cfg = defaultNormConfig()
    const { alignment } = computePairAlignment(jia, yi, cfg, [], [])
    const cols = alignment.segments.flatMap((s) => s.columns)
    const yiNorm = normalize(yi, cfg)
    const shiToken = yiNorm.tokens.find((t) => t.norm === '時' && t.variantApplied)!
    expect(shiToken).toBeDefined()
    expect(yi.chars.find((c) => c.cpIndex === shiToken.srcStart)?.code).toBe('旹')
    const pairCol = cols.find((c) => c.b === shiToken.tIndex && c.a !== null)
    expect(pairCol).toBeDefined()
    expect(pairCol!.kind).toBe('match') // 归一后匹配，而非替换
  })

  it('2) 连续缺句：乙本缺「有朋自遠方來」表现为连续 gap，后续不错位', async () => {
    const [jia, yi] = await buildSampleManuscripts()
    const cfg = defaultNormConfig()
    const { alignment } = computePairAlignment(jia, yi, cfg, [], [])
    const cols = alignment.segments.flatMap((s) => s.columns)
    const jiaNorm = normalize(jia, cfg)
    const firstGap = cols.findIndex((c) => c.kind === 'gapB')
    expect(firstGap).toBeGreaterThan(-1)
    const gapRun: string[] = []
    for (let i = firstGap; i < cols.length && cols[i].kind === 'gapB'; i++) {
      gapRun.push(jiaNorm.tokens[cols[i].a!].norm)
    }
    expect(gapRun.join('')).toBe('有朋自遠方來')
    // 缺句后的「樂」字仍与乙本「樂」对齐
    const leA = jiaNorm.tokens.find((t) => t.norm === '樂')!.tIndex
    const leCol = cols.find((c) => c.a === leA)
    expect(leCol?.b).not.toBeNull()
    expect(normalize(yi, cfg).tokens[leCol!.b!].norm).toBe('樂')
  })

  it('3) 重复短句歧义：甲本「溫故而知新」两见，乙本一见，存在同分多方案', async () => {
    const [jia, yi] = await buildSampleManuscripts()
    const cfg = defaultNormConfig()
    const { alignment } = computePairAlignment(jia, yi, cfg, [], [])
    const groups = alignment.segments.flatMap((s) => s.ambiguousGroups)
    expect(groups.length).toBeGreaterThan(0)
    expect(groups.some((g) => g.alternatives.length >= 2)).toBe(true)
  })

  it('4) 整段迁移：丙本移段被检出，且新位置可回查', async () => {
    const [jia, , bing] = await buildSampleManuscripts()
    const cfg = defaultNormConfig()
    const { moves } = computePairAlignment(jia, bing, cfg, [], [])
    const found = moves.find((m) => {
      const text = normalize(bing, cfg).tokens
        .slice(m.insertRun.start, m.insertRun.end + 1)
        .map((t) => t.norm)
        .join('')
      return text.includes('君子食')
    })
    expect(found).toBeDefined()
    expect(found!.status).toBe('suggested')
  })

  it('5) 新版本插字：丁本衍字作为 gap 进入参考列，新增内容不消失', async () => {
    const mss = await buildSampleManuscripts()
    const [jia, , , ding] = mss
    const cfg = defaultNormConfig()
    const { alignment } = computePairAlignment(jia, ding, cfg, [], [])
    const cols = alignment.segments.flatMap((s) => s.columns)
    // 甲无丁有
    const gapA = cols.filter((c) => c.kind === 'gapA')
    expect(gapA.length).toBeGreaterThanOrEqual(2) // 多一「時」、多一「而」
    const built = buildMultiColumns(
      jia.id,
      normalize(jia, cfg).tokens,
      [
        {
          versionId: ding.id,
          tokens: normalize(ding, cfg).tokens,
          pair: alignment
        }
      ]
    )
    // 丁本所有 token 都必须在多版本列或新增段中出现
    const covered = new Set<number>()
    for (const col of built.columns) {
      const t = col.cells[ding.id]
      if (t !== null && t !== undefined) covered.add(t)
    }
    for (const p of built.inserted) for (let t = p.tokenRange[0]; t <= p.tokenRange[1]; t++) covered.add(t)
    expect(covered.size).toBe(normalize(ding, cfg).tokens.length)
  })

  it('参考本之外的新增段落不会因不在参考本中而消失', async () => {
    const [jia, yi] = await buildSampleManuscripts()
    const cfg = defaultNormConfig()
    const { alignment } = computePairAlignment(jia, yi, cfg, [], [])
    const built = buildMultiColumns(
      jia.id,
      normalize(jia, cfg).tokens,
      [{ versionId: yi.id, tokens: normalize(yi, cfg).tokens, pair: alignment }]
    )
    const yiTokens = normalize(yi, cfg).tokens
    const covered = new Set<number>()
    for (const col of built.columns) {
      const t = col.cells[yi.id]
      if (t !== null && t !== undefined) covered.add(t)
    }
    for (const p of built.inserted) for (let t = p.tokenRange[0]; t <= p.tokenRange[1]; t++) covered.add(t)
    expect(covered.size).toBe(yiTokens.length)
  })
})
