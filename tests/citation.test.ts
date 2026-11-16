import { describe, expect, it } from 'vitest'
import {
  CitationConflictError,
  commitMigration,
  computeMigration,
  currentDraftRevision,
  isMigrationCurrent,
  markMigrationsStale,
  registerCitation,
  strongestTier,
  locateCitation,
  lcsSimilarity
} from '../src/core/citation'
import { buildCitationCases } from '../src/core/citationCases'
import { appendBlock, insertBlockAt, insertChars, manualBlock, type DraftState } from '../src/core/draft'
import type { Citation, DraftBlock, DraftOp, MigrationResult } from '../src/core/types'

const OP_BASE = 1000

function op(ops: DraftOp[], type: DraftOp['type'], args: Record<string, unknown>): DraftOp {
  const o = { id: `op_${ops.length}`, type, args, rev: ops.length + 1, at: OP_BASE + ops.length }
  ops.push(o)
  return o
}

function cite(blocks: DraftBlock[], charIds: string[]): Citation {
  return registerCitation({
    label: '测试引文',
    purpose: '論點支撐',
    blocks,
    span: { blockIds: [blocks[0].id], charIds },
    baseAnchors: [{ versionId: 'ms-jia', tokenStart: 1, tokenEnd: 3, text: '甲乙丙' }],
    anchorColumnIds: ['col-1'],
    context: { before: '', after: '' },
    draftRevision: 0
  })
}

function move(blocks: DraftBlock[], blockId: string, toIndex: number): DraftBlock[] {
  const idx = blocks.findIndex((b) => b.id === blockId)
  const [b] = blocks.splice(idx, 1)
  blocks.splice(toIndex, 0, b)
  return blocks
}

describe('引文迁移：操作链推导', () => {
  it('插句与移段可组合推导“位置变化”，新旧指纹一致', () => {
    const target = manualBlock('甲乙丙')
    const lead = manualBlock('首句')
    const tail = manualBlock('末句')
    const blocks = [lead, target, tail]
    const citation = cite(blocks, target.chars.map((c) => c.id))

    const ops: DraftOp[] = []
    const inserted = manualBlock('新增句')
    op(ops, 'insert-block', { index: 0, blockId: inserted.id, block: inserted })
    const afterInsert = [inserted, lead, target, tail]
    move(afterInsert, target.id, 3)
    op(ops, 'move-block', { blockId: target.id, toIndex: 3 })

    const result = computeMigration({ citation, blocks: afterInsert, ops, columnIds: ['col-1'] })
    expect(result.path).toBe('ops')
    expect(result.status).toBe('moved')
    expect(result.segments[0].text).toBe('甲乙丙')
    expect(result.newFingerprint).toBe(result.oldFingerprint)
    expect(result.opChain.length).toBe(2)
    expect(result.opChain[1]).toContain('移動塊')
    expect(result.explanation.join('')).toContain('位置發生移動')
  })

  it('改字（删字 + 插字）给出“文字变化”与新旧指纹', () => {
    const target = manualBlock('甲乙丙')
    const blocks = [target]
    const citation = cite(blocks, target.chars.map((c) => c.id))

    const ops: DraftOp[] = []
    const yi = target.chars[1]
    const replacement = manualBlock('丁').chars[0]
    target.chars.splice(1, 1, replacement)
    op(ops, 'delete-chars', { blockId: target.id, charIds: [yi.id] })
    op(ops, 'insert-chars', { blockId: target.id, at: 1, chars: [replacement], charIds: [replacement.id] })

    const result = computeMigration({ citation, blocks, ops, columnIds: ['col-1'] })
    expect(result.status).toBe('text-changed')
    // 删字 + 插字：替换字虽为新 id，也并入范围，结论反映新稿实际读法
    expect(result.segments[0].text).toBe('甲丁丙')
    expect(result.segments[0].charIds).toContain(replacement.id)
    expect(result.newFingerprint).not.toBe(result.oldFingerprint)
    expect(result.explanation.join('')).toContain('指紋')
  })

  it('拆分块给出“拆分关联”，两段按块序重组且字符标识不丢', () => {
    const target = manualBlock('甲乙丙丁')
    const blocks = [target]
    const citation = cite(blocks, target.chars.map((c) => c.id))

    const ops: DraftOp[] = []
    const head: DraftBlock = { ...target, chars: target.chars.slice(0, 2) }
    const tail: DraftBlock = { ...target, id: 'blk_tail', chars: target.chars.slice(2) }
    op(ops, 'split-block', { blockId: target.id, at: 2, tailBlockId: tail.id })

    const result = computeMigration({ citation, blocks: [head, tail], ops, columnIds: ['col-1'] })
    expect(result.status).toBe('split')
    expect(result.segments).toHaveLength(2)
    expect(result.segments.map((s) => s.text).join('')).toBe('甲乙丙丁')
    expect(result.segments.flatMap((s) => s.charIds)).toEqual(citation.span.charIds)
    expect(result.explanation.join('')).toContain('保留原出處')
  })

  it('引文整段被删：结论为删除，新指纹为空串指纹', () => {
    const target = manualBlock('甲乙丙')
    const other = manualBlock('其他')
    const citation = cite([target, other], target.chars.map((c) => c.id))
    const ops: DraftOp[] = []
    op(ops, 'delete-chars', { blockId: target.id, charIds: target.chars.map((c) => c.id) })
    const blocks = [{ ...target, chars: [] }, other]
    const result = computeMigration({ citation, blocks, ops, columnIds: ['col-1'] })
    expect(result.status).toBe('deleted')
    expect(result.segments).toHaveLength(0)
    expect(result.newFingerprint).not.toBe(result.oldFingerprint)
    // 落定的“删除”会写入空范围；未解决的才保留旧范围
    const committed = commitMigration(citation, result, currentDraftRevision(ops))
    expect(committed.status).toBe('deleted')
    expect(committed.span.charIds).toHaveLength(0)
    expect(committed.textFingerprint).toBe(result.newFingerprint)
  })
})

describe('引文迁移：局部重对齐', () => {
  it('操作链中断 + 唯一精确命中 → 位置变化，沿用原出处处', () => {
    const target = manualBlock('甲乙丙')
    const citation = cite([target], target.chars.map((c) => c.id))
    const newBlocks = [manualBlock('前言'), manualBlock('後語甲乙丙')]
    // 操作链为空（旧块消失却无记录）→ 中断
    const result = computeMigration({ citation, blocks: newBlocks, ops: [], columnIds: ['col-1'] })
    expect(result.path).toBe('realign')
    expect(result.status).toBe('moved')
    expect(result.interrupted).toBeTruthy()
    expect(result.segments[0].text).toBe('甲乙丙')
    expect(result.segments[0].baseRange).toEqual([1, 3])
  })

  it('操作链中断 + 唯一近似命中（改字）+ 上下文吻合 → 文字变化', () => {
    const original = manualBlock('前文甲乙丙後文')
    const citation = registerCitation({
      label: '测试引文',
      purpose: '論點支撐',
      blocks: [original],
      span: { blockIds: [original.id], charIds: original.chars.slice(2, 5).map((c) => c.id) },
      baseAnchors: [{ versionId: 'ms-jia', tokenStart: 1, tokenEnd: 3, text: '甲乙丙' }],
      anchorColumnIds: ['col-1'],
      context: { before: '前文', after: '後文' },
      draftRevision: 0
    })
    const newBlock = manualBlock('前文甲丁丙後文')
    const result = computeMigration({ citation, blocks: [newBlock], ops: [], columnIds: ['col-1'] })
    expect(result.path).toBe('realign')
    expect(result.status).toBe('text-changed')
    expect(result.segments[0].text).toBe('甲丁丙')
    expect(result.newFingerprint).not.toBe(result.oldFingerprint)
  })

  it('重复典故产生多个完全相同的候选 → 停在未解决，不按最高相似度替换出处', () => {
    const target = manualBlock('甲乙丙')
    const citation = cite([target], target.chars.map((c) => c.id))
    const blocks = [manualBlock('子曰甲乙丙也'), manualBlock('或曰甲乙丙者')]
    const result = computeMigration({ citation, blocks, ops: [], columnIds: ['col-1'] })
    expect(result.status).toBe('unresolved')
    expect(result.segments).toHaveLength(0)
    const exact = result.candidates.filter((c) => c.similarity === 1)
    expect(exact.length).toBeGreaterThanOrEqual(2)
    expect(result.newFingerprint).toBe(result.oldFingerprint)
    expect(result.explanation.join('')).toContain('不按最高相似度替換出處')
  })

  it('近似候选不止一个（0.8 与 0.6 并存）→ 不得挑最高，停在未解决', () => {
    const original = manualBlock('前文甲乙丙後文')
    const citation = registerCitation({
      label: '测试引文',
      purpose: '訓詁',
      blocks: [original],
      span: { blockIds: [original.id], charIds: original.chars.slice(2, 5).map((c) => c.id) },
      baseAnchors: [{ versionId: 'ms-jia', tokenStart: 1, tokenEnd: 3, text: '甲乙丙' }],
      anchorColumnIds: ['col-1'],
      context: { before: '前文', after: '後文' },
      draftRevision: 0
    })
    // 第一处改动一字（相似 2/3），第二处改动更多但仍 ≥0.6 且上下文吻合
    const blocks = [manualBlock('前文甲丁丙後文'), manualBlock('前文甲乙丁後文')]
    const result = computeMigration({ citation, blocks, ops: [], columnIds: ['col-1'] })
    expect(result.status).toBe('unresolved')
    expect(result.segments).toHaveLength(0)
    expect(result.candidates.length).toBeGreaterThanOrEqual(2)
  })

  it('锚点所在校勘列被删/合并 → 中断且不得自动沿用出处处', () => {
    const target = manualBlock('甲乙丙')
    const citation = cite([target], target.chars.map((c) => c.id))
    const blocks = [manualBlock('甲乙丙')]
    const result = computeMigration({ citation, blocks, ops: [], columnIds: ['col-other'] })
    expect(result.status).toBe('unresolved')
    expect(result.interrupted).toContain('校勘列')
    expect(result.explanation.join('')).toContain('出處不可沿用')
  })

  it('底本锚点越界（原锚点被删/合并）也触发中断', () => {
    const target = manualBlock('甲乙丙')
    const citation = cite([target], target.chars.map((c) => c.id))
    const result = computeMigration({
      citation,
      blocks: [target],
      ops: [],
      columnIds: ['col-1'],
      baseTokenCounts: { 'ms-jia': 2 }
    })
    expect(result.interrupted).toContain('越界')
  })
})

describe('引文迁移：失效与并发', () => {
  it('审阅上下文再次修改：候选全部标为失效，不能提交', () => {
    const target = manualBlock('甲乙丙')
    const citation = cite([target], target.chars.map((c) => c.id))
    const result = computeMigration({ citation, blocks: [target], ops: [], columnIds: ['col-1'], draftRevision: 0 })
    expect(isMigrationCurrent(result, citation, 0)).toBe(true)
    // 采用稿前进到 r1
    const stale = markMigrationsStale([result], 1)
    expect(stale[0].stale).toBe(true)
    expect(isMigrationCurrent(stale[0], citation, 1)).toBe(false)
    expect(() => commitMigration(citation, stale[0], 1)).toThrow(CitationConflictError)
  })

  it('并发任务用旧引用版本提交被拒绝，不允许覆盖', () => {
    const target = manualBlock('甲乙丙')
    const citation = cite([target], target.chars.map((c) => c.id))
    const result = computeMigration({ citation, blocks: [target], ops: [], columnIds: ['col-1'] })
    expect(result.citationRevision).toBe(1)
    // 另一任务先提交，引用版本升到 2
    const first = commitMigration(citation, result, currentDraftRevision([]))
    expect(first.revision).toBe(2)
    // 本任务仍持旧版本 1 → 拒绝
    expect(() => commitMigration(first, result, 0)).toThrow(/拒絕覆蓋/)
  })

  it('提交成功后范围与指纹更新，旧修订进入历史', () => {
    const target = manualBlock('甲乙丙')
    const citation = cite([target], target.chars.map((c) => c.id))
    const ops: DraftOp[] = []
    op(ops, 'insert-block', { index: 0, blockId: 'x', block: manualBlock('前言') })
    const result = computeMigration({
      citation,
      blocks: [manualBlock('前言'), target],
      ops,
      columnIds: ['col-1']
    })
    const committed = commitMigration(citation, result, currentDraftRevision(ops))
    expect(committed.revision).toBe(2)
    expect(committed.history).toHaveLength(1)
    expect(committed.history[0].revision).toBe(1)
    expect(committed.lastMigration?.status).toBe('moved')
  })

  it('未解决结论可留档但不改写引文范围', () => {
    const target = manualBlock('甲乙丙')
    const citation = cite([target], target.chars.map((c) => c.id))
    const result: MigrationResult = computeMigration({
      citation,
      blocks: [manualBlock('甲乙丙'), manualBlock('甲乙丙')],
      ops: [],
      columnIds: ['col-other']
    })
    expect(result.status).toBe('unresolved')
    const committed = commitMigration(citation, result, 0)
    expect(committed.span.text).toBe('甲乙丙')
    expect(committed.span.charIds).toEqual(citation.span.charIds)
    expect(committed.status).toBe(citation.status)
  })
})

describe('内置四类案例（重复引句、改字移段、二处拆分、锚点删除）', () => {
  const byId = new Map(buildCitationCases().map((c) => [c.id as string, c]))

  function run(id: string): MigrationResult {
    const c = byId.get(id)!
    return computeMigration({
      citation: c.citation,
      blocks: c.blocks,
      ops: c.ops,
      columnIds: new Set(c.columnIds),
      baseTokenCounts: c.baseTokenCounts,
      draftRevision: currentDraftRevision(c.ops)
    })
  }

  it('重複引句 → 未解決且候選唯一性不足（不择最高相似度）', () => {
    const r = run('repeat')
    expect(r.status).toBe('unresolved')
    expect(r.candidates.length).toBeGreaterThanOrEqual(2)
    expect(r.path).toBe('realign')
  })

  it('改字移段 → 操作链给出位置/文字变化，指纹随结论变化', () => {
    const r = run('text-move')
    expect(r.path).toBe('ops')
    expect(r.status).toBe('text-changed')
    expect(r.opChain.join(' ')).toContain('移動塊')
    expect(r.opChain.join(' ')).toContain('刪除 1 字')
    expect(r.segments[0].text).toBe('君子食無求飽居無求康')
    expect(r.newFingerprint).not.toBe(r.oldFingerprint)
    expect(r.explanation.join('')).toContain('位置發生移動')
  })

  it('二處拆分 → 拆分關聯，兩段按塊序重組', () => {
    const r = run('split')
    expect(r.status).toBe('split')
    expect(r.path).toBe('ops')
    expect(r.segments.length).toBe(2)
    expect(r.segments.map((s) => s.text).join('')).toBe('博學之審問之慎思之明辨之')
    expect(r.explanation.join('')).toContain('待校勘員逐段指定')
  })

  it('錨點刪除 → 未解決，出處不得沿用', () => {
    const r = run('anchor-deleted')
    expect(r.status).toBe('unresolved')
    expect(r.interrupted).toContain('校勘列')
  })
})

describe('定位工具', () => {
  it('精确命中与近似命中分开返回，重复命中全部列出', () => {
    const blocks = [manualBlock('甲乙丙'), manualBlock('甲乙丙')]
    const { exact } = locateCitation(blocks, '甲乙丙', { before: '', after: '' })
    expect(exact).toHaveLength(2)
  })
  it('等强候选按千分位归并，不因浮点抖动分裂', () => {
    const a = { blockId: 'x', start: 0, end: 2, text: 'x', similarity: 0.80001, byContext: true }
    const b = { blockId: 'y', start: 0, end: 2, text: 'y', similarity: 0.79999, byContext: true }
    expect(strongestTier([a, b])).toHaveLength(2)
  })

  it('LCS 相似度对称且对完全一致返回 1', () => {
    expect(lcsSimilarity('甲乙丙', '甲乙丙')).toBe(1)
    expect(lcsSimilarity('甲乙丙', '甲丁丙')).toBeCloseTo(2 / 3, 5)
  })

  it('记录后由操作插入的新字并入范围，结论文本反映新稿；无关新块不被并进', () => {
    const s: DraftState = { blocks: [], ops: [], annotations: [] }
    const target = manualBlock('甲乙丙')
    appendBlock(s, target)
    const citation = cite([target], target.chars.map((c) => c.id))
    // 记录后：块前置插句 + 块内中间插一字
    const lead = manualBlock('前言')
    insertBlockAt(s, 0, lead)
    insertChars(s, target.id, 1, '新')
    const result = computeMigration({ citation, blocks: s.blocks, ops: s.ops, columnIds: ['col-1'] })
    expect(result.status).toBe('text-changed')
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0].blockId).toBe(target.id)
    expect(result.segments[0].text).toBe('甲新乙丙')
    // 记录修订 r0 之后的全部操作都应进入链（首块插入、前置插句、块内插字）
    expect(result.opChain.length).toBeGreaterThanOrEqual(2)
  })
})
