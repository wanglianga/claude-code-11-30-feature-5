// 引文迁移核心：旧引文在新稿上重新定位。
//
// 两条路径：
//  1) 操作链推导（ops）：引文记录时的采用稿修订 → 校验之后的插/删字、移块、拆块记录连续完整，
//     再按稳定字符标识由现行采用稿直接得出新范围。速度快、可逐操作解释；
//     若旧文字消失却无对应操作、操作跳号，或底本锚点所在列被删/合并，则中断。
//  2) 局部重对齐（realign）：操作链中断时，用旧前后文 + 底本出处 + 字词差异在新稿中比对。
//     能恢复改写后的引文；但典故重复产生多个等强候选时必须停在 unresolved，
//     绝不按最高相似度替换出处。
//
// 全链路约束：
//  - 自动结论必须唯一。任何等强候选、锚点失衡、消失无记录都不自动裁决。
//  - 新旧文本指纹随结论一并给出；指纹不同即文字变化，不允许谎称原位一致。
//  - 引用版本（revision）与采用稿修订（recordedAtRevision）分开保存：
//    审阅上下文再次改稿会让迁移候选失效；并发任务以旧引用版本提交会被拒绝。
import type {
  Citation,
  CitationBaseAnchor,
  CitationSpan,
  CitationStatus,
  DraftBlock,
  DraftOp,
  MigrationCandidate,
  MigrationResult,
  MigrationSegment
} from './types'
import { fnv1a, rid } from './ids'

export const STALE_MIGRATION_ERROR = 'citation-migration-stale'
export const CONFLICT_MIGRATION_ERROR = 'citation-migration-conflict'

export class CitationConflictError extends Error {
  constructor(
    message: string,
    public readonly code: 'stale' | 'conflict'
  ) {
    super(message)
    this.name = 'CitationConflictError'
  }
}

// ---------- 指纹与文本 ----------

/** 引文文本指纹（FNV-1a 32 位；引文级用途，非安全场景，与项目包分块校验同法） */
export function citationTextFingerprint(text: string): string {
  return fnv1a(text)
}

export function spanText(blocks: DraftBlock[], charIds: string[]): string {
  const byId = new Map<string, string>()
  for (const b of blocks) for (const c of b.chars) byId.set(c.id, c.text)
  return charIds.map((id) => byId.get(id) ?? '').join('')
}

/** 采用稿修订号：沿用操作记录里最大的 rev；无记录时取 0 */
export function currentDraftRevision(ops: DraftOp[]): number {
  let rev = 0
  for (const op of ops) if (typeof op.rev === 'number' && op.rev > rev) rev = op.rev
  return rev
}

export function nextDraftRevision(ops: DraftOp[]): number {
  return currentDraftRevision(ops) + 1
}

// ---------- 引文登记 ----------

/**
 * 按稳定字符标识记录旧引文的采用稿范围：给出其中任一字符，向前后扩展同块连续字符，
 * 得到不依赖下标的字符 id 列表；跨块范围应显式传入全部字符。
 */
export function resolveSpan(
  blocks: DraftBlock[],
  seedCharId: string,
  opts: { blockId?: string; direction?: 'both' | 'forward' | 'backward' } = {}
): { blockId: string; charIds: string[] } | null {
  const block = opts.blockId
    ? blocks.find((b) => b.id === opts.blockId)
    : blocks.find((b) => b.chars.some((c) => c.id === seedCharId))
  if (!block) return null
  const at = block.chars.findIndex((c) => c.id === seedCharId)
  if (at < 0) return null
  const dir = opts.direction ?? 'both'
  const from = dir === 'forward' ? at : 0
  const to = dir === 'backward' ? at : block.chars.length - 1
  return { blockId: block.id, charIds: block.chars.slice(from, to + 1).map((c) => c.id) }
}

export interface RegisterCitationInput {
  label: string
  purpose: string
  note?: string
  blocks: DraftBlock[]
  span: { blockIds: string[]; charIds: string[] }
  baseAnchors: CitationBaseAnchor[]
  anchorColumnIds: string[]
  context: { before: string; after: string }
  /** 记录时的采用稿修订（旧修订） */
  draftRevision: number
}

export function registerCitation(input: RegisterCitationInput): Citation {
  const text = spanText(input.blocks, input.span.charIds)
  const span: CitationSpan = {
    blockIds: [...input.span.blockIds],
    charIds: [...input.span.charIds],
    text
  }
  return {
    id: rid('cit'),
    label: input.label,
    purpose: input.purpose,
    note: input.note,
    span,
    baseAnchors: input.baseAnchors.map((a) => ({ ...a })),
    anchorColumnIds: [...input.anchorColumnIds],
    context: { ...input.context },
    recordedAtRevision: input.draftRevision,
    revision: 1,
    recordedAt: Date.now(),
    textFingerprint: citationTextFingerprint(text),
    status: 'moved',
    history: []
  }
}

// ---------- 操作链完整性校验 ----------

function short(id: string): string {
  return id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id
}

interface ChainCheck {
  trail: string[]
}

/**
 * 校验引文记录修订之后的操作链是否连续、且能解释旧文字的每一次消失。
 * 位置不靠重放求——稳定字符标识在现行采用稿中的实际位置就是真值；
 * 操作链只用于“是否可推导”的门槛与差异说明。
 * 返回 null 表示链不完整，调用方必须改走局部重对齐。
 */
export function verifyOpChain(
  citation: Citation,
  blocks: DraftBlock[],
  ops: DraftOp[]
): ChainCheck | null {
  const chain = ops.filter((op) => op.rev > citation.recordedAtRevision).sort((a, b) => a.rev - b.rev)
  const trail: string[] = []
  let expectRev = citation.recordedAtRevision + 1
  for (const op of chain) {
    if (op.rev !== expectRev) return null // 跳号或乱序：操作链断裂
    expectRev += 1
    trail.push(describeOp(op, blocks))
  }

  // 逐一核对旧字符：仍存在则无须解释；消失则必须有操作记录承载
  const live = new Set<string>()
  for (const b of blocks) for (const c of b.chars) live.add(c.id)
  const lost = citation.span.charIds.filter((id) => !live.has(id))
  if (lost.length) {
    const explained = new Set<string>()
    for (const op of chain) {
      if (op.type === 'delete-chars') {
        for (const id of (op.args.charIds as string[] | undefined) ?? []) explained.add(id)
      } else if (op.type === 'delete-block' || op.type === 'replace-block') {
        for (const id of (op.args.removedCharIds as string[] | undefined) ?? []) explained.add(id)
      }
    }
    if (lost.some((id) => !explained.has(id))) {
      // 旧文字消失了，但操作记录里找不到是谁删的：链不完整，不能声称精确推导
      return null
    }
  }
  return { trail }
}

function describeOp(op: DraftOp, blocks: DraftBlock[]): string {
  switch (op.type) {
    case 'insert-block': {
      const b = op.args.block as DraftBlock | undefined
      const text = b ? b.chars.map((c) => c.text).join('') : ''
      return `r${op.rev} 插入新塊「${text}」`
    }
    case 'delete-block':
      return `r${op.rev} 刪除塊 ${short(String(op.args.blockId))}`
    case 'insert-chars': {
      const chars = (op.args.chars as DraftBlock['chars'] | undefined) ?? []
      return `r${op.rev} 插入 ${chars.length} 字「${chars.map((c) => c.text).join('')}」`
    }
    case 'delete-chars': {
      const ids = (op.args.charIds as string[] | undefined) ?? []
      return `r${op.rev} 刪除 ${ids.length} 字`
    }
    case 'split-block': {
      const blockId = String(op.args.blockId)
      const block = blocks.find((b) => b.id === blockId)
      const at = Number(op.args.at ?? 0)
      const where = block ? `「${block.chars.slice(0, at).map((c) => c.text).join('')}」後` : `第 ${at} 字處`
      return `r${op.rev} 在 ${where}拆為關聯兩段`
    }
    case 'move-block':
      return `r${op.rev} 移動塊 ${short(String(op.args.blockId))} 至第 ${op.args.toIndex} 位`
    case 'replace-block':
      return `r${op.rev} 替換塊 ${short(String(op.args.blockId))}`
    default:
      return `r${op.rev} ${op.type}`
  }
}

// ---------- 锚点 ----------

/** 底本锚点区间是否仍然合法：起止颠倒或非法即中断 */
export function anchorBroken(anchor: CitationBaseAnchor): string | null {
  if (!Number.isFinite(anchor.tokenStart) || !Number.isFinite(anchor.tokenEnd)) return '錨點區間非法'
  if (anchor.tokenEnd < anchor.tokenStart) return '錨點區間起止顛倒'
  return null
}

// ---------- 局部重对齐 ----------

interface Located {
  blockId: string
  start: number
  end: number
  text: string
  similarity: number
  byContext: boolean
}

/**
 * 在新稿中搜索旧引文：以引文文字为主体，前后文作为弱约束。
 * 精确命中与近似命中分别返回；调用方只在唯一等强时自动采用。
 */
export function locateCitation(
  blocks: DraftBlock[],
  oldText: string,
  oldContext: { before: string; after: string }
): { exact: Located[]; near: Located[] } {
  const exact: Located[] = []
  const near: Located[] = []
  for (const block of blocks) {
    const chars = block.chars
    const joined = chars.map((c) => c.text).join('')
    if (!joined) continue
    // 精确子串：多处重复全部列出，不取最优
    let from = 0
    while (oldText.length > 0) {
      const at = joined.indexOf(oldText, from)
      if (at < 0) break
      const start = cpLen(joined.slice(0, at))
      const end = start + cpLen(oldText) - 1
      exact.push({
        blockId: block.id,
        start,
        end,
        text: oldText,
        similarity: 1,
        byContext: matchesContext(joined, at, oldText.length, oldContext)
      })
      from = at + Math.max(1, oldText.length)
    }
    // 近似窗口：改字后长度通常相近，滑窗取最高相似
    const win = cpLen(oldText)
    if (!win) continue
    for (let start = 0; start + win <= chars.length; start++) {
      const windowText = chars.slice(start, start + win).map((c) => c.text).join('')
      if (windowText === oldText) continue
      const sim = lcsSimilarity(oldText, windowText)
      if (sim < 0.5) continue
      near.push({
        blockId: block.id,
        start,
        end: start + win - 1,
        text: windowText,
        similarity: sim,
        byContext: windowMatchesContext(chars, start, win, oldContext)
      })
    }
  }
  return { exact, near: dedupeLocations(near) }
}

function dedupeLocations(list: Located[]): Located[] {
  const seen = new Set<string>()
  const out: Located[] = []
  for (const l of list) {
    const key = `${l.blockId}:${l.start}:${l.end}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(l)
  }
  return out
}

function cpLen(s: string): number {
  return Array.from(s).length
}

function matchesContext(joined: string, at: number, len: number, ctx: { before: string; after: string }): boolean {
  const before = joined.slice(0, at)
  const after = joined.slice(at + len)
  return (ctx.before !== '' && before.endsWith(ctx.before)) || (ctx.after !== '' && after.startsWith(ctx.after))
}

function windowMatchesContext(
  chars: DraftBlock['chars'],
  start: number,
  len: number,
  ctx: { before: string; after: string }
): boolean {
  const before = chars.slice(0, start).map((c) => c.text).join('')
  const after = chars.slice(start + len).map((c) => c.text).join('')
  return (ctx.before !== '' && before.endsWith(ctx.before)) || (ctx.after !== '' && after.startsWith(ctx.after))
}

/** 最长公共子序列相似度（以较长为分母，0..1） */
export function lcsSimilarity(x: string, y: string): number {
  const xs = Array.from(x)
  const ys = Array.from(y)
  if (!xs.length || !ys.length) return 0
  const dp = new Uint16Array((xs.length + 1) * (ys.length + 1))
  const at = (i: number, j: number) => i * (ys.length + 1) + j
  for (let i = 1; i <= xs.length; i++) {
    for (let j = 1; j <= ys.length; j++) {
      dp[at(i, j)] =
        xs[i - 1] === ys[j - 1]
          ? dp[at(i - 1, j - 1)] + 1
          : Math.max(dp[at(i - 1, j)], dp[at(i, j - 1)])
    }
  }
  return dp[at(xs.length, ys.length)] / Math.max(xs.length, ys.length)
}

/** 近似命中按相似度归并（千分位），只保留最高分同分组；分组多于一个 → 候选不唯一 */
export function strongestTier(located: Located[]): Located[] {
  if (!located.length) return []
  const best = Math.max(...located.map((l) => l.similarity))
  const key = (v: number) => Math.round(v * 1000)
  return located.filter((l) => key(l.similarity) === key(best))
}

// ---------- 迁移主入口 ----------

export interface MigrationInput {
  citation: Citation
  blocks: DraftBlock[]
  ops: DraftOp[]
  /** 现行校勘列 id；给出时用于判断锚点列是否被删/合并 */
  columnIds?: Set<string> | string[]
  /** 各底本现行比较字符数；锚点越界说明该段已被删除或合并 */
  baseTokenCounts?: Record<string, number>
  /** 新稿的采用稿修订号；默认取操作记录最大值 */
  draftRevision?: number
}

/**
 * 计算迁移结论，不修改传入对象。
 * 操作链完整即以其为准（可组合插删与移段，速度快且解释精确）；
 * 中断才走局部重对齐，多个等强候选一律 unresolved。
 */
export function computeMigration(input: MigrationInput): MigrationResult {
  const { citation, blocks, ops } = input
  const draftRevision = input.draftRevision ?? currentDraftRevision(ops)
  const colIds =
    input.columnIds instanceof Set
      ? input.columnIds
      : input.columnIds
        ? new Set(input.columnIds)
        : undefined

  const base: Omit<MigrationResult, 'path' | 'status' | 'segments' | 'explanation'> = {
    citationId: citation.id,
    citationRevision: citation.revision,
    recordedAtRevision: citation.recordedAtRevision,
    draftRevision,
    oldFingerprint: citation.textFingerprint,
    newFingerprint: citation.textFingerprint,
    opChain: [],
    candidates: [],
    computedAt: Date.now()
  }

  const interrupted = detectInterruptions(citation, colIds, input.baseTokenCounts)
  const anchorColumnGone = Boolean(
    colIds && colIds.size > 0 && citation.anchorColumnIds.length && !citation.anchorColumnIds.some((id) => colIds.has(id))
  )
  if (interrupted) {
    return runRealign({ ...input, draftRevision }, base, interrupted, anchorColumnGone)
  }

  const chain = verifyOpChain(citation, blocks, ops)
  if (!chain) {
    return runRealign(
      { ...input, draftRevision },
      base,
      '操作記錄有跳號，或舊文字消失卻無對應操作，無法組合重放',
      false
    )
  }

  return deriveFromOps(citation, blocks, ops, chain, base, draftRevision)
}

function detectInterruptions(
  citation: Citation,
  columnIds?: Set<string>,
  baseTokenCounts?: Record<string, number>
): string | null {
  for (const anchor of citation.baseAnchors) {
    const broken = anchorBroken(anchor)
    if (broken) return broken
    const count = baseTokenCounts?.[anchor.versionId]
    if (count !== undefined) {
      if (count === 0) return `底本「${anchor.versionId}」已無比較字符`
      if (anchor.tokenEnd >= count) return `底本錨點越界（區間止 ${anchor.tokenEnd} ≥ ${count}），原錨點可能已被刪除或合併`
    }
  }
  if (columnIds && columnIds.size > 0 && citation.anchorColumnIds.length) {
    const any = citation.anchorColumnIds.some((id) => columnIds.has(id))
    if (!any) return '錨點所在校勘列已被刪除或合併'
  }
  return null
}

interface GroupLoc {
  blockId: string
  start: number
  end: number
  charIds: string[]
}

/**
 * 操作链完整路径：按稳定字符标识在现行采用稿中分组。
 * 同块内被删字隔开的两段也视为拆分关联，按块序重组。
 */
function deriveFromOps(
  citation: Citation,
  blocks: DraftBlock[],
  ops: DraftOp[],
  chain: ChainCheck,
  base: Omit<MigrationResult, 'path' | 'status' | 'segments' | 'explanation'>,
  draftRevision: number
): MigrationResult {
  const ids = new Set(citation.span.charIds)
  const live = new Set<string>()
  for (const b of blocks) for (const c of b.chars) live.add(c.id)
  const lost = citation.span.charIds.filter((id) => !live.has(id))
  // 记录修订后由“插入文字”操作产生的新字符（按块归集）
  const insertedByBlock = new Map<string, Set<string>>()
  for (const op of ops) {
    if (op.rev <= citation.recordedAtRevision || op.type !== 'insert-chars') continue
    const blockId = String(op.args.blockId)
    const set = insertedByBlock.get(blockId) ?? new Set<string>()
    for (const c of (op.args.chars as DraftBlock['chars'] | undefined) ?? []) set.add(c.id)
    insertedByBlock.set(blockId, set)
  }
  // 每块被删掉的引文字数：只允许并入等量的紧邻新字符（替换字），
  // 不会把别处新添的句子也算进引文范围
  const lostByBlock = new Map<string, number>()
  const lostSet = new Set(lost)
  for (const op of ops) {
    if (op.rev <= citation.recordedAtRevision || op.type !== 'delete-chars') continue
    const blockId = String(op.args.blockId)
    const n = ((op.args.charIds as string[] | undefined) ?? []).filter((id) => lostSet.has(id)).length
    if (n) lostByBlock.set(blockId, (lostByBlock.get(blockId) ?? 0) + n)
  }
  const groups = groupByBlock(blocks, ids, { extendWith: insertedByBlock, maxExtend: lostByBlock })

  if (!groups.length) {
    return finalize({
      ...base,
      path: 'ops',
      status: 'deleted',
      segments: [],
      newFingerprint: citationTextFingerprint(''),
      opChain: chain.trail,
      explanation: [
        `舊引文 ${citation.span.charIds.length} 字已全部被刪除`,
        `記錄修訂 r${citation.recordedAtRevision} → 現行 r${draftRevision}，鏈上共 ${chain.trail.length} 步`,
        `指紋 ${base.oldFingerprint} → ${citationTextFingerprint('')}`,
        ...(chain.trail.length ? [`操作鏈：${chain.trail.join(' → ')}`] : [])
      ]
    })
  }

  // 底本锚点：拆分无法机械细分，保留原出处待人工逐段指定
  const anchorIndex = citation.baseAnchors.length ? 0 : null
  const anchor = anchorIndex === null ? null : citation.baseAnchors[anchorIndex]
  const segments: MigrationSegment[] = groups.map((g) => {
    const block = blocks.find((b) => b.id === g.blockId)!
    const text = g.charIds.map((id) => block.chars.find((c) => c.id === id)!.text).join('')
    return {
      blockId: g.blockId,
      start: g.start,
      end: g.end,
      charIds: g.charIds,
      text,
      fingerprint: citationTextFingerprint(text),
      baseAnchorIndex: anchorIndex,
      baseRange: anchor ? ([anchor.tokenStart, anchor.tokenEnd] as [number, number]) : null,
      ...(citation.baseAnchors.length > 1
        ? { ambiguousAnchors: citation.baseAnchors.map((_, i) => i).filter((i) => i !== 0) }
        : {})
    }
  })

  const newText = segments.map((s) => s.text).join('')
  const newFingerprint = citationTextFingerprint(newText)
  const textualChange = newText !== citation.span.text

  let status: CitationStatus
  if (segments.length > 1) status = 'split'
  else if (textualChange) status = 'text-changed'
  else status = 'moved'

  const explanation: string[] = [
    `操作鏈推導：r${citation.recordedAtRevision} → r${draftRevision}，共 ${chain.trail.length} 步`
  ]
  if (segments.length > 1) {
    explanation.push(`引文被拆為 ${segments.length} 處關聯片段，按塊序重組為「${newText}」`)
    explanation.push('拆分後底本錨點無法機械細分，保留原出處，待校勘員逐段指定')
  } else {
    const seg = segments[0]
    const oldBlock = citation.span.blockIds[0]
    if (oldBlock && oldBlock !== seg.blockId) {
      explanation.push(`所在塊由 ${short(oldBlock)} 變為 ${short(seg.blockId)}`)
    }
    if (citation.span.charIds[0] !== seg.charIds[0]) {
      explanation.push('塊內位置發生移動，穩定字符標識保持不變')
    }
    // 操作链中若有移动本块：块标识不变但位置变化，必须写明而不是只报“未变”
    const movedBlockIds = new Set(
      ops
        .filter((o) => o.rev > citation.recordedAtRevision && o.type === 'move-block')
        .map((o) => String(o.args.blockId))
    )
    const blockMoved = movedBlockIds.has(seg.blockId)
    if (blockMoved) explanation.push('引文所在塊被移段，塊標識不變但位置發生移動')
    if (!textualChange && !blockMoved && oldBlock === seg.blockId && citation.span.charIds[0] === seg.charIds[0]) {
      explanation.push('位置與文字均未變，僅確認現狀')
    }
  }
  if (textualChange) {
    explanation.push(`文字變化：舊「${citation.span.text}」→ 新「${newText}」`)
    explanation.push(`指紋 ${base.oldFingerprint} → ${newFingerprint}`)
  } else {
    explanation.push(`文字未變，指紋 ${base.oldFingerprint} 保持`)
  }
  if (chain.trail.length) explanation.push(`操作鏈：${chain.trail.join(' → ')}`)

  return finalize({
    ...base,
    path: 'ops',
    status,
    segments,
    newFingerprint,
    opChain: chain.trail,
    explanation
  })
}

/**
 * 操作链完整路径：按稳定字符标识在现行采用稿中分组。
 * 同一块内只取一个连续区间（首末目标字符之间都算引文范围），
 * 这样中间改字表现为“文字变化”而非误报拆分；只有跨块才构成“拆分关联”。
 *
 * extendWith 用于改字：旧字符被删、替换字是新 id，则把该块内紧邻区间边界、
 * 由插入操作产生的新字符并入范围，使结论文本完整反映“新稿现在读作什么”。
 */
function groupByBlock(
  blocks: DraftBlock[],
  ids: Set<string>,
  opts: { extendWith?: Map<string, Set<string>>; maxExtend?: Map<string, number> } = {}
): GroupLoc[] {
  const extendWith = opts.extendWith ?? new Map<string, Set<string>>()
  const maxExtend = opts.maxExtend ?? new Map<string, number>()
  const out: GroupLoc[] = []
  for (const b of blocks) {
    const indexes: number[] = []
    b.chars.forEach((c, i) => {
      if (ids.has(c.id)) indexes.push(i)
    })
    if (!indexes.length) continue
    const fresh = extendWith.get(b.id)
    let start = indexes[0]
    let end = indexes[indexes.length - 1]
    let budget = maxExtend.get(b.id) ?? 0
    if (fresh?.size && budget > 0) {
      // 并入紧贴区间左右边界、由插入操作产生的新字符；总数不超过本块被删的引文字数
      const before: number[] = []
      for (let i = start - 1; i >= 0 && fresh.has(b.chars[i].id) && before.length < budget; i--) before.push(i)
      start -= before.length
      budget -= before.length
      const after: number[] = []
      for (let i = end + 1; i < b.chars.length && fresh.has(b.chars[i].id) && after.length < budget; i++) after.push(i)
      end += after.length
    }
    out.push({
      blockId: b.id,
      start,
      end,
      charIds: b.chars.slice(start, end + 1).map((c) => c.id)
    })
  }
  return out
}

function runRealign(
  input: MigrationInput,
  base: Omit<MigrationResult, 'path' | 'status' | 'segments' | 'explanation'>,
  interrupted: string,
  anchorColumnGone: boolean
): MigrationResult {
  const { citation, blocks } = input
  const { exact, near } = locateCitation(blocks, citation.span.text, citation.context)

  if (exact.length === 1 && !anchorColumnGone) {
    return finalize(singleHit(base, blocks, interrupted, exact[0], citation))
  }
  if (exact.length > 0) {
    return unresolvedResult(base, interrupted, exact, near, anchorColumnGone)
  }

  if (anchorColumnGone) {
    return unresolvedResult(base, interrupted, exact, near, true)
  }
  // 只有在“全部合格候选唯一”时才自动采用。
  // 若 0.8 与 0.6 两个候选同时存在，挑 0.8 就是“取最高相似度”，明确禁止。
  const viable = near.filter((l) => l.similarity >= 0.6 && l.byContext)
  if (viable.length === 1) {
    return finalize(textChangeHit(base, blocks, interrupted, viable[0], citation))
  }
  return unresolvedResult(base, interrupted, exact, near, false)
}

function singleHit(
  base: Omit<MigrationResult, 'path' | 'status' | 'segments' | 'explanation'>,
  blocks: DraftBlock[],
  interrupted: string,
  hit: Located,
  citation: Citation
): MigrationResult {
  const block = blocks.find((b) => b.id === hit.blockId)!
  const charIds = block.chars.slice(hit.start, hit.end + 1).map((c) => c.id)
  const text = charIds.map((id) => block.chars.find((c) => c.id === id)!.text).join('')
  const anchor = anchorOf(citation)
  return {
    ...base,
    path: 'realign',
    status: 'moved',
    segments: [segment(hit.blockId, hit.start, hit.end, charIds, text, anchor)],
    newFingerprint: citationTextFingerprint(text),
    interrupted,
    explanation: [
      `操作鏈中斷：${interrupted}`,
      `局部重對齊唯一命中：塊 ${short(hit.blockId)} 第 ${hit.start}–${hit.end} 字`,
      `文字與舊稿一致（指紋 ${base.oldFingerprint}），未以相似度替換出處`,
      '位置為新稿中的實際區間，出處沿用原底本錨點'
    ]
  }
}

function textChangeHit(
  base: Omit<MigrationResult, 'path' | 'status' | 'segments' | 'explanation'>,
  blocks: DraftBlock[],
  interrupted: string,
  hit: Located,
  citation: Citation
): MigrationResult {
  const block = blocks.find((b) => b.id === hit.blockId)!
  const charIds = block.chars.slice(hit.start, hit.end + 1).map((c) => c.id)
  const text = charIds.map((id) => block.chars.find((c) => c.id === id)!.text).join('')
  const anchor = anchorOf(citation)
  return {
    ...base,
    path: 'realign',
    status: 'text-changed',
    segments: [segment(hit.blockId, hit.start, hit.end, charIds, text, anchor)],
    newFingerprint: citationTextFingerprint(text),
    interrupted,
    explanation: [
      `操作鏈中斷：${interrupted}`,
      `局部重對齊唯一近似命中：${(hit.similarity * 100).toFixed(1)}%，前後文至少一側吻合`,
      `文字變化：舊「${citation.span.text}」→ 新「${text}」`,
      `指紋 ${base.oldFingerprint} → ${citationTextFingerprint(text)}`,
      '候選唯一方自動套用；多候選情形一律停在未解決'
    ]
  }
}

function anchorOf(citation: Citation): { index: number; range: [number, number] } | null {
  const a = citation.baseAnchors[0]
  return a ? { index: 0, range: [a.tokenStart, a.tokenEnd] } : null
}

function segment(
  blockId: string,
  start: number,
  end: number,
  charIds: string[],
  text: string,
  anchor: { index: number; range: [number, number] } | null
): MigrationSegment {
  return {
    blockId,
    start,
    end,
    charIds,
    text,
    fingerprint: citationTextFingerprint(text),
    baseAnchorIndex: anchor ? anchor.index : null,
    baseRange: anchor ? anchor.range : null
  }
}

function unresolvedResult(
  base: Omit<MigrationResult, 'path' | 'status' | 'segments' | 'explanation'>,
  interrupted: string,
  exact: Located[],
  near: Located[],
  anchorColumnGone: boolean
): MigrationResult {
  const candidates = buildCandidates([...exact, ...near])
  const reason = anchorColumnGone
    ? '底本錨點所在校勘列已被刪除或合併，出處不可沿用'
    : exact.length > 1
      ? `新稿中有 ${exact.length} 處與舊引文完全相同，典故重複，無法唯一確定出處`
      : candidates.length > 0
        ? `有 ${candidates.length} 個等強候選，前後文不足以唯一判定`
        : '操作鏈中斷且新稿中未找到可用候選'
  return finalize({
    ...base,
    path: 'realign',
    status: 'unresolved',
    segments: [],
    newFingerprint: base.oldFingerprint,
    candidates,
    interrupted,
    explanation: [
      `操作鏈中斷：${interrupted}`,
      reason,
      '系統不按最高相似度替換出處，請校勘員人工指定'
    ]
  })
}

function buildCandidates(located: Located[]): MigrationCandidate[] {
  const seen = new Set<string>()
  const out: MigrationCandidate[] = []
  for (const l of located) {
    const key = `${l.blockId}:${l.start}:${l.end}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      blockId: l.blockId,
      start: l.start,
      end: l.end,
      text: l.text,
      similarity: l.similarity,
      fingerprint: citationTextFingerprint(l.text)
    })
  }
  return out.sort((a, b) => b.similarity - a.similarity)
}

function finalize(result: MigrationResult): MigrationResult {
  return { ...result, stale: false }
}

// ---------- 失效与并发 ----------

/** 审阅上下文再次修改：现有迁移候选失效，须重新计算 */
export function markMigrationsStale(
  migrations: MigrationResult[],
  draftRevision: number
): MigrationResult[] {
  return migrations.map((m) => ({ ...m, stale: m.draftRevision !== draftRevision }))
}

export function isMigrationCurrent(
  result: MigrationResult,
  citation: Citation,
  draftRevision: number
): boolean {
  return (
    result.citationRevision === citation.revision &&
    result.draftRevision === draftRevision &&
    !result.stale
  )
}

/**
 * 并发任务提交：携带旧引用版本、或基于旧采用稿修订的结果一律拒绝，不得覆盖。
 * 通过后引用版本 +1，历史追加旧修订记录；未解决的结论不改写现行范围。
 */
export function commitMigration(
  citation: Citation,
  result: MigrationResult,
  draftRevision: number
): Citation {
  if (result.citationRevision !== citation.revision) {
    throw new CitationConflictError(
      `引用已更新到版本 ${citation.revision}，本任務基於版本 ${result.citationRevision}，拒絕覆蓋`,
      'conflict'
    )
  }
  if (result.draftRevision !== draftRevision) {
    throw new CitationConflictError(
      `采用稿已修改到修訂 r${draftRevision}，本任務基於 r${result.draftRevision}，候選已失效`,
      'stale'
    )
  }
  const accepted = result.status !== 'unresolved'
  const nextSpan: CitationSpan = {
    blockIds: result.segments.map((s) => s.blockId),
    charIds: result.segments.flatMap((s) => s.charIds),
    text: result.segments.map((s) => s.text).join('')
  }
  const record = {
    revision: citation.revision,
    at: Date.now(),
    status: result.status,
    span: accepted ? nextSpan : citation.span,
    textFingerprint: accepted ? result.newFingerprint : citation.textFingerprint,
    recordedAtRevision: citation.recordedAtRevision,
    note: result.explanation[result.explanation.length - 1] ?? ''
  }
  return {
    ...citation,
    revision: citation.revision + 1,
    status: accepted ? result.status : citation.status,
    lastMigration: result,
    history: [...citation.history, record],
    // 已落定结论（含“删除”→空范围）才改写现行范围；
    // 未解决只留档，绝不把旧范围换成候选位置
    ...(accepted
      ? {
          span: nextSpan,
          textFingerprint: result.newFingerprint,
          recordedAtRevision: result.draftRevision
        }
      : {})
  }
}

// ---------- 说明文本 ----------

export function statusLabel(status: CitationStatus): string {
  switch (status) {
    case 'moved':
      return '位置變化'
    case 'text-changed':
      return '文字變化'
    case 'split':
      return '拆分關聯'
    case 'deleted':
      return '刪除'
    default:
      return '未解決'
  }
}

/** 供 UI 渲染的差异摘要：结论 + 新旧指纹 + 操作链/候选 */
export function summarizeMigration(result: MigrationResult): string {
  const parts = [
    `${statusLabel(result.status)}（${result.path === 'ops' ? '操作鏈' : result.path === 'realign' ? '局部重對齊' : '無'}）`,
    `舊 ${result.oldFingerprint} → 新 ${result.newFingerprint}`
  ]
  if (result.interrupted) parts.push(`中斷：${result.interrupted}`)
  if (result.candidates.length) parts.push(`${result.candidates.length} 個候選待人工指定`)
  return parts.join('；')
}
