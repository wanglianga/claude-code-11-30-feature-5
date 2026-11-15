// 对齐门面：篇章+锚点分段 → 段内 DP（可配置代价）→ 同分歧义枚举
// → 长文分块与重叠接缝核验 → 移段候选 → 参考本多版本列。
import type {
  AlignAnchor,
  AlignColumn,
  AlignmentRevision,
  AmbiguityAlternative,
  AmbiguityGroup,
  CellKind,
  InsertedPassage,
  MultiColumn,
  NormConfig,
  NormToken,
  PairAlignment,
  PairOp
} from '../types'
import { backtrace, enumerateOptimalPaths, runDp, type Costs } from './dp'
import { fnv1a, rid } from '../ids'

export class CanceledError extends Error {
  constructor() {
    super('alignment-canceled')
    this.name = 'CanceledError'
  }
}

export interface CancelSignal {
  canceled: boolean
}

export interface SegmentPlan {
  id: string
  aRange: [number, number]
  bRange: [number, number]
  forcedPairs: [number, number][]
  forcedGapA: Set<number>
  forcedGapB: Set<number>
  chapter?: string
}

/** 篇章边界 + 人工锚点把两条 token 序列切成独立段；锚点在段内作为强制配对约束 */
export function planSegments(
  a: NormToken[],
  b: NormToken[],
  chapterBoundsA: number[],
  chapterBoundsB: number[],
  anchors: AlignAnchor[],
  revisions: AlignmentRevision[]
): SegmentPlan[] {
  const cutsA = uniqueSorted([0, a.length, ...chapterBoundsA, ...anchors.map((x) => x.a)])
  const cutsB = uniqueSorted([0, b.length, ...chapterBoundsB, ...anchors.map((x) => x.b)])
  const segCount = Math.max(cutsA.length - 1, cutsB.length - 1)
  const plans: SegmentPlan[] = []
  for (let k = 0; k < segCount; k++) {
    const a0 = cutsA[Math.min(k, cutsA.length - 2)]
    const a1 = cutsA[Math.min(k + 1, cutsA.length - 1)]
    const b0 = cutsB[Math.min(k, cutsB.length - 2)]
    const b1 = cutsB[Math.min(k + 1, cutsB.length - 1)]
    if (a1 <= a0 && b1 <= b0) continue
    const forcedPairs: [number, number][] = anchors
      .filter((x) => x.a >= a0 && x.a < a1 && x.b >= b0 && x.b < b1)
      .map((x) => [x.a, x.b])
    const forcedGapA = new Set<number>()
    const forcedGapB = new Set<number>()
    for (const rv of revisions) {
      if (rv.pin.kind === 'gapB' && rv.pin.a >= a0 && rv.pin.a < a1) forcedGapA.add(rv.pin.a)
      if (rv.pin.kind === 'gapA' && rv.pin.b >= b0 && rv.pin.b < b1) forcedGapB.add(rv.pin.b)
      if ((rv.pin.kind === 'match' || rv.pin.kind === 'sub') && rv.pin.a >= a0 && rv.pin.a < a1) {
        forcedPairs.push([rv.pin.a, rv.pin.b])
      }
    }
    plans.push({
      id: rid('seg'),
      aRange: [a0, Math.max(a0, a1 - 1)],
      bRange: [b0, Math.max(b0, b1 - 1)],
      forcedPairs,
      forcedGapA,
      forcedGapB
    })
  }
  return plans
}

function uniqueSorted(xs: number[]): number[] {
  return [...new Set(xs)].sort((p, q) => p - q)
}

function opKey(op: PairOp): string {
  return JSON.stringify(op)
}

/** 在一段内做 DP，并把同分多路径包装成歧义组（不固定取左侧隐藏） */
export function alignRegion(
  a: NormToken[],
  b: NormToken[],
  plan: SegmentPlan,
  costs: Costs
): { columns: AlignColumn[]; cost: number; ambiguousGroups: AmbiguityGroup[]; seamVerified: boolean } {
  const [a0, a1] = plan.aRange
  const [b0, b1] = plan.bRange
  const sa = a.slice(a0, a1 + 1)
  const sb = b.slice(b0, b1 + 1)
  const local = (t: number, base: number) => t - base
  const constraints = {
    forcedPairs: plan.forcedPairs.map(([x, y]) => [local(x, a0), local(y, b0)] as [number, number]),
    forcedGapA: new Set([...plan.forcedGapA].map((x) => local(x, a0))),
    forcedGapB: new Set([...plan.forcedGapB].map((x) => local(x, b0)))
  }
  const r = runDp(sa, sb, costs, constraints)
  const { ops: localOps, tieCells } = backtrace(r)

  // 歧义组内备选 ops 在此统一转换为全局 token 下标（分块后也能直接反查）
  const ambiguousGroups = detectAmbiguities(r, sa, sb, tieCells, a0, b0)
  const globalOps = localOps.map((op): PairOp => {
    if (op.kind === 'match' || op.kind === 'sub') return { ...op, a: op.a + a0, b: op.b + b0 }
    if (op.kind === 'gapB') return { ...op, a: op.a + a0 }
    return { ...op, b: op.b + b0 }
  })
  const chosenOps = applyResolvedAmbiguities(globalOps, ambiguousGroups)

  const columns = chosenOps.map((op): AlignColumn => {
    if (op.kind === 'match' || op.kind === 'sub') {
      return { id: rid('col'), segId: plan.id, a: op.a, b: op.b, kind: op.kind }
    }
    if (op.kind === 'gapB') return { id: rid('col'), segId: plan.id, a: op.a, b: null, kind: 'gapB' }
    return { id: rid('col'), segId: plan.id, a: null, b: op.b, kind: 'gapA' }
  })
  return { columns, cost: r.cost, ambiguousGroups, seamVerified: true }
}

function detectAmbiguities(
  r: ReturnType<typeof runDp>,
  sa: NormToken[],
  sb: NormToken[],
  tieCells: number[],
  a0: number,
  b0: number
): AmbiguityGroup[] {
  if (tieCells.length === 0) return []
  const width = r.m + 1
  const ij = (cell: number) => [Math.floor(cell / width), cell % width] as const
  // 相邻分叉格合并为一个歧义区
  const groups: number[][] = []
  const sorted = [...tieCells].sort((p, q) => p - q)
  for (const cell of sorted) {
    const [i, j] = ij(cell)
    const last = groups[groups.length - 1]
    if (last) {
      const [pi, pj] = ij(last[last.length - 1])
      if (Math.abs(i - pi) + Math.abs(j - pj) <= 3) last.push(cell)
      else groups.push([cell])
    } else groups.push([cell])
  }

  const out: AmbiguityGroup[] = []
  for (const cells of groups) {
    const pts = cells.map(ij)
    const maxI = Math.max(...pts.map(([i]) => i))
    const minI = Math.min(...pts.map(([i]) => i))
    const maxJ = Math.max(...pts.map(([, j]) => j))
    const minJ = Math.min(...pts.map(([, j]) => j))
    const paths = enumerateOptimalPaths(r, Math.max(0, minI - 1), Math.max(0, minJ - 1), maxI, maxJ)
    const distinct = dedupePaths(paths)
    if (distinct.length < 2) continue
    const alternatives: AmbiguityAlternative[] = distinct.slice(0, 4).map((p, index) => ({
      index,
      label: describeAlternative(p.ops, sa, sb),
      cost: r.cost,
      // 转为全局 token 下标，供修订与反查直接使用
      ops: p.ops.map((op): PairOp => {
        if (op.kind === 'match' || op.kind === 'sub') return { ...op, a: op.a + a0, b: op.b + b0 }
        if (op.kind === 'gapB') return { ...op, a: op.a + a0 }
        return { ...op, b: op.b + b0 }
      })
    }))
    out.push({
      id: rid('amb'),
      aRange: [a0 + minI, a0 + maxI - 1],
      bRange: [b0 + minJ, b0 + maxJ - 1],
      alternatives
    })
  }
  return out
}

function dedupePaths(paths: { ops: PairOp[] }[]): { ops: PairOp[] }[] {
  const seen = new Set<string>()
  const out: { ops: PairOp[] }[] = []
  for (const p of paths) {
    const sig = p.ops.map(opKey).join('|')
    if (!seen.has(sig)) {
      seen.add(sig)
      out.push(p)
    }
  }
  return out
}

function describeAlternative(ops: PairOp[], sa: NormToken[], sb: NormToken[]): string {
  const pair = ops.find((o) => o.kind === 'match' || o.kind === 'sub')
  const gap = ops.find((o) => o.kind === 'gapA' || o.kind === 'gapB')
  if (pair && (pair.kind === 'match' || pair.kind === 'sub')) {
    return `「${sa[pair.a]?.norm ?? ''}」對「${sb[pair.b]?.norm ?? ''}」`
  }
  if (gap) return gap.kind === 'gapA' ? `乙本多出「${sb[gap.b]?.norm ?? ''}」` : `甲本多出「${sa[gap.a]?.norm ?? ''}」`
  return '同分方案'
}

function applyResolvedAmbiguities(ops: PairOp[], groups: AmbiguityGroup[]): PairOp[] {
  // 已人工确认的歧义组用所选方案替换对应区段；未确认保留机器首选，但标记为待确认
  let result = ops
  for (const g of groups) {
    if (!g.resolved) continue
    const chosen = g.alternatives[g.resolved.chosenIndex]
    if (!chosen) continue
    const aSet = new Set(g.aRange)
    const bSet = new Set(g.bRange)
    const head = result.filter((op) => {
      const a = 'a' in op ? op.a : -1
      const b = 'b' in op ? op.b : -1
      return !aSet.has(a) && !bSet.has(b)
    })
    result = [...head, ...chosen.ops]
  }
  return result
}

// ---------- 分块 + 重叠接缝核验 ----------

export interface ChunkOutcome {
  columns: AlignColumn[]
  ambiguousGroups: AmbiguityGroup[]
  cost: number
  seamVerified: boolean
  chunkHash: string
}

interface AlignWindow {
  aRange: [number, number]
  bRange: [number, number]
  core: [number, number] // 本窗口独有的 A 核心区（相邻核心互不相交）
  cols: AlignColumn[]
  groups: AmbiguityGroup[]
}

/**
 * 长段分块：A 序列切成互不相交的“核心区”，每个核心外加 overlapSize 重叠窗口做 DP。
 * B token 按相邻核心边界 A token 的配对位置划分归属区间，保证每个 A/B token 只出现一次；
 * 接缝处两窗口对同一 A token 的配对必须一致，不一致则合并两窗口重算，
 * 从而不会把块边界造成的缺字误报为异文。
 */
export function chunkedAlign(
  a: NormToken[],
  b: NormToken[],
  plan: SegmentPlan,
  cfg: NormConfig,
  signal: CancelSignal
): ChunkOutcome {
  const [a0, a1] = plan.aRange
  const [b0, b1] = plan.bRange
  const lenA = a1 - a0 + 1
  const lenB = b1 - b0 + 1
  const { chunkSize, overlapSize } = cfg
  if (lenA <= chunkSize && lenB <= chunkSize) {
    const one = alignRegion(a, b, plan, cfg.costs)
    return { ...one, chunkHash: hashRegion(a, b, a0, a1, b0, b1) }
  }

  const coreSize = Math.max(1, chunkSize - overlapSize)
  const cores: [number, number][] = []
  for (let s = a0; s <= a1; s += coreSize) cores.push([s, Math.min(a1, s + coreSize - 1)])

  const mapB = (aPos: number) =>
    b0 + Math.round(((aPos - a0) / Math.max(1, lenA)) * lenB)

  const buildWindow = (core: [number, number], index: number): AlignWindow => {
    const as = index === 0 ? a0 : Math.max(a0, core[0] - overlapSize)
    const ae = index === cores.length - 1 ? a1 : Math.min(a1, core[1] + overlapSize)
    const bs = index === 0 ? b0 : Math.max(b0, mapB(as) - overlapSize)
    const be = index === cores.length - 1 ? b1 : Math.min(b1, mapB(ae) + overlapSize)
    const subPlan: SegmentPlan = {
      ...plan,
      id: `${plan.id}#c${index}`,
      aRange: [as, ae],
      bRange: [bs, Math.max(bs, be)],
      forcedPairs: plan.forcedPairs.filter(([x, y]) => x >= as && x <= ae && y >= bs && y <= be),
      forcedGapA: new Set([...plan.forcedGapA].filter((x) => x >= as && x <= ae)),
      forcedGapB: new Set([...plan.forcedGapB].filter((x) => x >= bs && x <= be))
    }
    const r = alignRegion(a, b, subPlan, cfg.costs)
    return { aRange: [as, ae], bRange: [bs, Math.max(bs, be)], core, cols: r.columns, groups: r.ambiguousGroups }
  }

  let windows: AlignWindow[] = cores.map((core, k) => {
    if (signal.canceled) throw new CanceledError()
    return buildWindow(core, k)
  })

  // 接缝核验 + 合并窗口修复
  let seamVerified = true
  let guard = 0
  let i = 1
  while (i < windows.length && guard < windows.length + 4) {
    if (signal.canceled) throw new CanceledError()
    guard += 1
    if (windowsAgree(windows[i - 1], windows[i])) {
      i += 1
      continue
    }
    seamVerified = false
    const prev = windows[i - 1]
    const cur = windows[i]
    const mergedPlan: SegmentPlan = {
      ...plan,
      id: `${plan.id}#seam${i}`,
      aRange: [prev.aRange[0], cur.aRange[1]],
      bRange: [Math.min(prev.bRange[0], cur.bRange[0]), Math.max(prev.bRange[1], cur.bRange[1])],
      forcedPairs: [],
      forcedGapA: new Set(),
      forcedGapB: new Set()
    }
    const repaired = alignRegion(a, b, mergedPlan, cfg.costs)
    const mergedWindow: AlignWindow = {
      aRange: mergedPlan.aRange,
      bRange: mergedPlan.bRange,
      core: [prev.core[0], cur.core[1]],
      cols: repaired.columns,
      groups: repaired.ambiguousGroups
    }
    windows.splice(i - 1, 2, mergedWindow)
    seamVerified = true // 合并窗重算后核验通过
    i = Math.max(1, i - 1)
  }

  // B token 归属切点：窗口 k-1 与 k 之间，取前一窗口核心末个 A token 的 B 配对位置
  const cuts: (number | null)[] = []
  for (let k = 0; k < windows.length - 1; k++) {
    const lastCoreA = windows[k].core[1]
    const partner = windows[k].cols.find((c) => c.a === lastCoreA && c.b !== null)
    cuts.push(partner ? partner.b! : null)
  }

  const mergedCols: AlignColumn[] = []
  const mergedGroups: AmbiguityGroup[] = []
  windows.forEach((w, k) => {
    const ownBLow = k === 0 ? b0 : (cuts[k - 1] ?? w.bRange[0]) + 1
    const ownBHigh = k === windows.length - 1 ? b1 : cuts[k] ?? w.bRange[1]
    for (const c of w.cols) {
      if (c.a !== null) {
        if (c.a >= w.core[0] && c.a <= w.core[1]) mergedCols.push(c)
      } else if (c.b !== null && c.b >= ownBLow && c.b <= ownBHigh) {
        mergedCols.push(c)
      }
    }
    mergedGroups.push(...w.groups)
  })

  return {
    // 保持窗口拼装顺序：gapA 列不能按 token 排序，否则连续增删片段被打散，移段检测失效
    columns: mergedCols,
    ambiguousGroups: mergedGroups,
    cost: mergedCols.reduce((s, c) => s + (c.kind === 'sub' ? cfg.costs.substitute : c.kind.startsWith('gap') ? 1 : 0), 0),
    seamVerified,
    chunkHash: hashRegion(a, b, a0, a1, b0, b1)
  }
}

/** 两窗口重叠 A 区中的同一 A token，配对 B 与类型必须一致 */
function windowsAgree(w1: AlignWindow, w2: AlignWindow): boolean {
  const overlapStart = Math.max(w1.aRange[0], w2.aRange[0])
  const overlapEnd = Math.min(w1.aRange[1], w2.aRange[1])
  if (overlapEnd < overlapStart) return true
  const partnerOf = (w: AlignWindow) => {
    const m = new Map<number, { b: number | null; kind: string }>()
    for (const c of w.cols) if (c.a !== null && c.a >= overlapStart && c.a <= overlapEnd) m.set(c.a, { b: c.b, kind: c.kind })
    return m
  }
  const p1 = partnerOf(w1)
  const p2 = partnerOf(w2)
  if (p1.size !== p2.size) return false
  for (const [a, v] of p1) {
    const w = p2.get(a)
    if (!w || w.b !== v.b || w.kind !== v.kind) return false
  }
  return true
}

function hashRegion(a: NormToken[], b: NormToken[], a0: number, a1: number, b0: number, b1: number): string {
  const sa = a.slice(a0, a1 + 1).map((t) => t.norm).join('')
  const sb = b.slice(b0, b1 + 1).map((t) => t.norm).join('')
  return fnv1a(`${sa}::${sb}`)
}

// ---------- 移段候选 ----------

export interface Run {
  side: 'A' | 'B'
  start: number
  end: number // 含端点
  text: string
  contextBefore: string
  contextAfter: string
}

export function findRuns(columns: AlignColumn[], a: NormToken[], b: NormToken[]): Run[] {
  const runs: Run[] = []
  let cur: { side: 'A' | 'B'; tokens: number[] } | null = null
  const flush = (ctx: { before: string; after: string }) => {
    if (!cur || cur.tokens.length < 2) {
      cur = null
      return
    }
    const tokens = cur.tokens
    const src = cur.side === 'A' ? a : b
    runs.push({
      side: cur.side,
      start: tokens[0],
      end: tokens[tokens.length - 1],
      text: tokens.map((t) => src[t]?.norm ?? '').join(''),
      contextBefore: ctx.before,
      contextAfter: ctx.after
    })
    cur = null
  }
  columns.forEach((c, idx) => {
    const side: 'A' | 'B' | null = c.kind === 'gapB' ? 'A' : c.kind === 'gapA' ? 'B' : null
    if (side) {
      const t = side === 'A' ? c.a! : c.b!
      if (cur && cur.side === side) cur.tokens.push(t)
      else {
        flush({ before: '', after: '' })
        cur = { side, tokens: [t] }
      }
    } else {
      if (cur) {
        const before = neighborText(columns, idx, -1, a, b)
        const after = neighborText(columns, idx, 1, a, b)
        flush({ before, after })
      }
    }
  })
  flush({ before: '', after: '' })
  return runs
}

function neighborText(columns: AlignColumn[], idx: number, dir: -1 | 1, a: NormToken[], b: NormToken[]): string {
  const j = idx + dir
  const c = columns[j]
  if (!c) return ''
  if (c.a !== null) return a[c.a]?.norm ?? ''
  if (c.b !== null) return b[c.b]?.norm ?? ''
  return ''
}

export function lcsRatio(x: string, y: string): number {
  if (!x.length || !y.length) return 0
  const n = x.length
  const m = y.length
  const dp = new Uint16Array((n + 1) * (m + 1))
  const idx = (i: number, j: number) => i * (m + 1) + j
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[idx(i, j)] = x[i - 1] === y[j - 1] ? dp[idx(i - 1, j - 1)] + 1 : Math.max(dp[idx(i - 1, j)], dp[idx(i, j - 1)])
    }
  }
  return dp[idx(n, m)] / Math.max(n, m)
}

/** 连续增删片段配对为移段候选：内容相似 + 上下文一致，交人工确认 */
export function pairRuns(
  del: Run[],
  ins: Run[],
  threshold: number
): { deleteRun: Run; insertRun: Run; similarity: number }[] {
  const out: { deleteRun: Run; insertRun: Run; similarity: number }[] = []
  for (const d of del) {
    let best: { run: Run; score: number } | null = null
    for (const e of ins) {
      const content = lcsRatio(d.text, e.text)
      if (content < threshold) continue
      const ctx =
        (d.contextBefore && d.contextBefore === e.contextBefore ? 0.15 : 0) +
        (d.contextAfter && d.contextAfter === e.contextAfter ? 0.15 : 0)
      const score = Math.min(1, content + ctx)
      if (!best || score > best.score) best = { run: e, score }
    }
    if (best) out.push({ deleteRun: d, insertRun: best.run, similarity: best.score })
  }
  return out
}

/** 单段内检测（段内连续增删片段） */
export function detectMoves(
  columns: AlignColumn[],
  a: NormToken[],
  b: NormToken[],
  threshold: number
): { deleteRun: Run; insertRun: Run; similarity: number }[] {
  const runs = findRuns(columns, a, b)
  return pairRuns(runs.filter((r) => r.side === 'A'), runs.filter((r) => r.side === 'B'), threshold)
}

// ---------- 参考本多版本列 ----------

export interface MultiBuildResult {
  columns: MultiColumn[]
  inserted: InsertedPassage[]
}

/**
 * 以参考本 token 序建立对齐列；参考本之外的新增段落通过非参考本之间的二次对齐归组，
 * 绝不因“不在参考本中”而消失。
 */
export function buildMultiColumns(
  refId: string,
  refTokens: NormToken[],
  others: { versionId: string; tokens: NormToken[]; pair: PairAlignment }[]
): MultiBuildResult {
  const columns: MultiColumn[] = []
  const refMap = new Map<number, MultiColumn>()
  refTokens.forEach((t) => {
    const col: MultiColumn = {
      id: rid('mcol'),
      refToken: t.tIndex,
      cells: { [refId]: t.tIndex },
      kinds: { [refId]: 'ref' as CellKind }
    }
    columns.push(col)
    refMap.set(t.tIndex, col)
  })

  const insertedByOwner = new Map<string, InsertedPassage>()

  for (const o of others) {
    const refToOther = new Map<number, number>()
    const otherAligned = new Set<number>()
    for (const seg of o.pair.segments) {
      for (const c of seg.columns) {
        if (c.a !== null && c.b !== null) {
          refToOther.set(c.a, c.b)
          otherAligned.add(c.b)
        }
      }
    }
    for (const [refT, otherT] of refToOther) {
      const col = refMap.get(refT)
      if (col) {
        col.cells[o.versionId] = otherT
        col.kinds[o.versionId] = 'match'
      }
    }
    // 参考本中没有对应物的 token：新增段落，逐段保留
    const gaps: number[] = []
    o.tokens.forEach((t) => {
      if (!otherAligned.has(t.tIndex)) gaps.push(t.tIndex)
    })
    for (const run of toRuns(gaps)) {
      const key = `${o.versionId}:${run[0]}`
      const passage: InsertedPassage = {
        id: rid('ins'),
        ownerVersionId: o.versionId,
        tokenRange: [run[0], run[run.length - 1]],
        groupedWith: []
      }
      insertedByOwner.set(key, passage)
      const col: MultiColumn = {
        id: rid('mcol'),
        refToken: null,
        insertedPassageId: passage.id,
        cells: { [o.versionId]: run[0] },
        kinds: { [o.versionId]: 'absent' }
      }
      columns.push(col)
    }
  }

  // 非参考本之间再对齐一次，把同一新增段落跨本归组
  const inserted = [...insertedByOwner.values()]
  for (let i = 0; i < others.length; i++) {
    for (let j = i + 1; j < others.length; j++) {
      groupInserted(inserted, others[i], others[j], cfgOf(others[i].pair))
    }
  }
  return { columns, inserted }
}

function cfgOf(pair: PairAlignment): NormConfig {
  return pair.configSnapshot
}

function groupInserted(
  inserted: InsertedPassage[],
  x: { versionId: string; tokens: NormToken[] },
  y: { versionId: string; tokens: NormToken[] },
  cfg: NormConfig
): void {
  const xPassages = inserted.filter((p) => p.ownerVersionId === x.versionId)
  const yPassages = inserted.filter((p) => p.ownerVersionId === y.versionId)
  for (const xp of xPassages) {
    const xt = x.tokens.slice(xp.tokenRange[0], xp.tokenRange[1] + 1)
    let best: { p: InsertedPassage; score: number } | null = null
    for (const yp of yPassages) {
      const yt = y.tokens.slice(yp.tokenRange[0], yp.tokenRange[1] + 1)
      const r = runDp(xt, yt, cfg.costs)
      const score = 1 - r.cost / Math.max(1, xt.length + yt.length)
      if (score >= 0.5 && (!best || score > best.score)) best = { p: yp, score }
    }
    if (best) {
      xp.groupedWith.push({ versionId: y.versionId, tokenRange: best.p.tokenRange })
      best.p.groupedWith.push({ versionId: x.versionId, tokenRange: xp.tokenRange })
    }
  }
}

function toRuns(xs: number[]): number[][] {
  const out: number[][] = []
  let run: number[] = []
  for (const x of xs) {
    if (run.length && x !== run[run.length - 1] + 1) {
      out.push(run)
      run = []
    }
    run.push(x)
  }
  if (run.length) out.push(run)
  return out
}
