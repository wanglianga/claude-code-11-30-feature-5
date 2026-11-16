// 引文迁移的内置演示案例（虚构文本，全部由输入计算，非预排结论）。
//
// 覆盖四类必须检查的情形：
//  1) 重复引句：同一典故在新稿出现多处 → 操作链中断后重对齐必须停在“未解决”，列出全部候选。
//  2) 改字移段：改动一字并把整块移到别处 → 操作链可组合移动与插删，给出“位置变化”。
//  3) 二处拆分：把一段块拆成两处 → 旧引文变“拆分关联”，两段按块序重组。
//  4) 锚点删除：底本锚点所在列被删/合并 → 操作链中断，结果不得自动改换出处。
//
// 每个案例返回“记录时的引用 + 之后的采用稿操作 + 现行采用稿”，交由 citation.ts 计算。
import type {
  Citation,
  CitationBaseAnchor,
  DraftBlock,
  DraftOp
} from './types'
import { manualBlock } from './draft'
import { registerCitation, nextDraftRevision, citationTextFingerprint } from './citation'
import { rid } from './ids'

export type CitationCaseId = 'repeat' | 'text-move' | 'split' | 'anchor-deleted'

export interface CitationCase {
  id: CitationCaseId
  title: string
  description: string
  expected: string
  citation: Citation
  ops: DraftOp[]
  blocks: DraftBlock[]
  columnIds: string[]
  baseTokenCounts: Record<string, number>
}

function op(
  ops: DraftOp[],
  type: DraftOp['type'],
  args: Record<string, unknown>
): DraftOp {
  const o: DraftOp = { id: rid('op'), type, args, rev: nextDraftRevision(ops), at: 1700000000000 + ops.length }
  ops.push(o)
  return o
}

function chars(text: string): DraftBlock['chars'] {
  return Array.from(text).map((code) => ({
    id: rid('dc'),
    text: code,
    anchor: { type: 'manual' as const }
  }))
}

function block(text: string): DraftBlock {
  return { id: rid('blk'), chars: chars(text), manual: true }
}

function anchorOf(versionId: string, start: number, end: number, text: string): CitationBaseAnchor {
  return { versionId, tokenStart: start, tokenEnd: end, text }
}

/** 1) 重复引句：编辑链不完整（旧块被删除却无对应操作），重对齐面对两处相同典故 → 未解决 */
function repeatCase(): CitationCase {
  const oldBlock = manualBlock('好學近乎知')
  const other = manualBlock('正文起首')
  const blocks = [other, oldBlock]
  // 记录时：r0，尚未有任何操作
  const citation = registerCitation({
    label: '《論語》好學條',
    purpose: '論點支撐',
    blocks,
    span: { blockIds: [oldBlock.id], charIds: oldBlock.chars.map((c) => c.id) },
    baseAnchors: [anchorOf('ms-lunyu', 10, 14, '好學近乎知')],
    anchorColumnIds: ['mcol-lunyu-10'],
    context: { before: '正文起首', after: '' },
    draftRevision: 0
  })

  const ops: DraftOp[] = []
  // 新稿另插两块，各含同一典故；旧块的删除发生在别处，未进入本工程操作链
  const a = block('子曰好學近乎知也')
  op(ops, 'insert-block', { index: 0, blockId: a.id, block: a })
  const b = block('或曰好學近乎知者')
  op(ops, 'insert-block', { index: 1, blockId: b.id, block: b })
  const newBlocks: DraftBlock[] = [a, b]

  return {
    id: 'repeat',
    title: '重複引句',
    description: '舊引「好學近乎知」在新稿出現兩處，舊塊已不在操作鏈可解釋範圍。',
    expected: '未解決：兩處完全相同的候選，不得擇相似度較高者替換出處',
    citation,
    ops,
    blocks: newBlocks,
    columnIds: ['mcol-lunyu-10', 'mcol-lunyu-5'],
    baseTokenCounts: { 'ms-lunyu': 80 }
  }
}

/** 2) 改字移段：块被移到后面，块内改动一字 → 操作链给出“位置变化 + 文字变化” */
function textMoveCase(): CitationCase {
  const lead = manualBlock('篇首總論')
  const target = manualBlock('君子食無求飽居無求安')
  const tail = manualBlock('末章之句')
  const blocks = [lead, target, tail]
  const citation = registerCitation({
    label: '「君子食無求飽」引句',
    purpose: '訓詁',
    blocks,
    span: { blockIds: [target.id], charIds: target.chars.map((c) => c.id) },
    baseAnchors: [anchorOf('ms-jia', 30, 41, '君子食無求飽居無求安')],
    anchorColumnIds: ['mcol-jia-30'],
    context: { before: '篇首總論', after: '末章之句' },
    draftRevision: 0
  })

  const ops: DraftOp[] = []
  // 把目标块移到末尾（第 2 位）
  op(ops, 'move-block', { blockId: target.id, toIndex: 2 })
  // 改一字：飽 → 飽？不，改「安」为「康」，按稳定 id 替换块内字符
  const anIndex = target.chars.findIndex((c) => c.text === '安')
  const oldAn = target.chars[anIndex]
  const newAn = chars('康')[0]
  target.chars.splice(anIndex, 1, newAn)
  op(ops, 'delete-chars', { blockId: target.id, charIds: [oldAn.id] })
  op(ops, 'insert-chars', { blockId: target.id, at: anIndex, chars: [newAn], charIds: [newAn.id] })

  const newBlocks: DraftBlock[] = [lead, tail, target]

  return {
    id: 'text-move',
    title: '改字移段',
    description: '「君子食無求飽…」整塊移至篇末，且「安」改作「康」。',
    expected: '位置變化或文字變化：操作链完整时按插删与移段直接推导，并给出新旧指纹',
    citation,
    ops,
    blocks: newBlocks,
    columnIds: ['mcol-jia-30', 'mcol-jia-1'],
    baseTokenCounts: { 'ms-jia': 120 }
  }
}

/** 3) 二处拆分：块被拆成两处，旧引文变“拆分关联” */
function splitCase(): CitationCase {
  const target = manualBlock('博學之審問之慎思之明辨之')
  const blocks = [target]
  const citation = registerCitation({
    label: '「博學之…」四條',
    purpose: '校記',
    blocks,
    span: { blockIds: [target.id], charIds: target.chars.map((c) => c.id) },
    baseAnchors: [anchorOf('ms-zhongyong', 5, 18, '博學之審問之慎思之明辨之')],
    anchorColumnIds: ['mcol-zy-5'],
    context: { before: '', after: '' },
    draftRevision: 0
  })

  const ops: DraftOp[] = []
  // 在第 6 字处拆成两段（前段「博學之審問之」，后段「慎思之明辨之」）
  const tailBlockId = rid('blk')
  const tail: DraftBlock = { id: tailBlockId, chars: target.chars.slice(6), manual: true }
  op(ops, 'split-block', { blockId: target.id, at: 6, tailBlockId })
  const head: DraftBlock = { ...target, chars: target.chars.slice(0, 6) }
  const newBlocks = [head, tail]

  return {
    id: 'split',
    title: '二處拆分',
    description: '「博學之審問之／慎思之明辨之」被拆為兩處關聯片段。',
    expected: '拆分關聯：两段按块序重组，字符标识与批注都不丢，底本锚点保留待人工细分',
    citation,
    ops,
    blocks: newBlocks,
    columnIds: ['mcol-zy-5'],
    baseTokenCounts: { 'ms-zhongyong': 30 }
  }
}

/** 4) 锚点删除：底本锚点所在列被删/合并 → 操作链中断，绝不自动换出处 */
function anchorDeletedCase(): CitationCase {
  const target = manualBlock('道可道非常道')
  const blocks = [target]
  const citation = registerCitation({
    label: '「道可道」引句',
    purpose: '論點支撐',
    blocks,
    span: { blockIds: [target.id], charIds: target.chars.map((c) => c.id) },
    baseAnchors: [anchorOf('ms-laozi', 0, 5, '道可道非常道')],
    anchorColumnIds: ['mcol-laozi-0'],
    context: { before: '', after: '' },
    draftRevision: 0
  })

  // 锚点列 mcol-laozi-0 已被合并掉；文字在新稿中仍有两处（正文与注文），但出所处不可信
  const main = block('道可道非常道名可名非常名')
  const note = block('注曰道可道非常道')
  const newBlocks = [main, note]

  return {
    id: 'anchor-deleted',
    title: '錨點刪除',
    description: '底本錨點所在校勘列被刪/合併，新稿中仍見該句。',
    expected: '未解決：镜像文字仍命中也只列候选，出处在人工确认前不得沿用',
    citation,
    ops: [],
    blocks: newBlocks,
    columnIds: ['mcol-laozi-other'],
    baseTokenCounts: { 'ms-laozi': 60 }
  }
}

export function buildCitationCases(): CitationCase[] {
  return [repeatCase(), textMoveCase(), splitCase(), anchorDeletedCase()]
}

export { citationTextFingerprint }
