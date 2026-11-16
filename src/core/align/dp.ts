// 序列对齐 DP 引擎。
// 设计要点：
//  - 代价可配置（插入/删除/替换）；同代价时保留全部最优前驱，不固定取左侧；
//  - 枚举同分对齐路径，形成歧义组供人工确认；
//  - 支持强制配对（锚点/修订）与强制缺字（gap 修订）约束。
import type { NormToken, PairOp } from '../types'

export const DEL = 1 // 前驱方向：删 A（甲有乙无 -> gapB）
export const INS = 2 // 前驱方向：插 B（甲无乙有 -> gapA）
export const DIAG = 4 // 前驱方向：配对（match/sub）

export interface Costs {
  insert: number
  delete: number
  substitute: number
}

export interface RegionConstraints {
  /** 强制配对：[aToken, bToken][]，区域内按序出现 */
  forcedPairs?: [number, number][]
  /** 强制为甲有乙无的 A token（不得参与 diag） */
  forcedGapA?: Set<number>
  /** 强制为甲无乙有的 B token */
  forcedGapB?: Set<number>
}

export interface DpResult {
  dp: Int32Array // 长度 (n+1)*(m+1)
  preds: Uint8Array // 方向位组合
  n: number
  m: number
  normA: string[]
  normB: string[]
  cost: number
}

const BIG = 1 << 30

export function runDp(a: NormToken[], b: NormToken[], costs: Costs, c: RegionConstraints = {}): DpResult {
  const n = a.length
  const m = b.length
  const dp = new Int32Array((n + 1) * (m + 1)).fill(BIG)
  const preds = new Uint8Array((n + 1) * (m + 1))
  const idx = (i: number, j: number) => i * (m + 1) + j
  const forcedPairB = new Map<number, number>()
  for (const [x, y] of c.forcedPairs ?? []) forcedPairB.set(x, y)
  const forcedBSet = new Set((c.forcedPairs ?? []).map(([, y]) => y))

  dp[idx(0, 0)] = 0
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (i === 0 && j === 0) continue
      let best = BIG
      let mask = 0
      // 删 A（甲有乙无）
      if (i > 0 && !forcedPairB.has(a[i - 1].tIndex)) {
        const v = dp[idx(i - 1, j)] + costs.delete
        if (v < best) {
          best = v
          mask = DEL
        } else if (v === best) mask |= DEL
      }
      // 插 B（甲无乙有）
      if (j > 0 && !forcedBSet.has(b[j - 1].tIndex)) {
        const v = dp[idx(i, j - 1)] + costs.insert
        if (v < best) {
          best = v
          mask = INS
        } else if (v === best) mask |= INS
      }
      // 配对
      if (i > 0 && j > 0) {
        const ta = a[i - 1].tIndex
        const tb = b[j - 1].tIndex
        const pairForbidden =
          (c.forcedGapA?.has(ta) ?? false) ||
          (c.forcedGapB?.has(tb) ?? false) ||
          (forcedPairB.has(ta) && forcedPairB.get(ta) !== tb) ||
          forcedBSet.has(tb)
        if (!pairForbidden) {
          const step = a[i - 1].norm === b[j - 1].norm ? 0 : costs.substitute
          const v = dp[idx(i - 1, j - 1)] + step
          if (v < best) {
            best = v
            mask = DIAG
          } else if (v === best) mask |= DIAG
        }
      }
      dp[idx(i, j)] = best
      preds[idx(i, j)] = mask
    }
  }
  return {
    dp,
    preds,
    n,
    m,
    normA: a.map((t) => t.norm),
    normB: b.map((t) => t.norm),
    cost: dp[idx(n, m)]
  }
}

function popcount(x: number): number {
  let v = x
  let k = 0
  while (v) {
    k += v & 1
    v >>= 1
  }
  return k
}

function diagOp(r: DpResult, i: number, j: number): PairOp {
  const ta = i - 1
  const tb = j - 1
  return r.normA[ta] === r.normB[tb]
    ? { kind: 'match', a: ta, b: tb }
    : { kind: 'sub', a: ta, b: tb }
}

/** 默认回溯：遇到多个最优前驱记录分叉格，路径本身仍取一条完整最优解 */
export function backtrace(r: DpResult): { ops: PairOp[]; tieCells: number[] } {
  const { preds, n, m } = r
  const idx = (i: number, j: number) => i * (m + 1) + j
  const ops: PairOp[] = []
  const tieCells: number[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    const mask = preds[idx(i, j)]
    if (popcount(mask) > 1) tieCells.push(idx(i, j))
    if (mask & DIAG) {
      ops.push(diagOp(r, i, j))
      i -= 1
      j -= 1
    } else if (mask & DEL) {
      ops.push({ kind: 'gapB', a: i - 1 })
      i -= 1
    } else {
      ops.push({ kind: 'gapA', b: j - 1 })
      j -= 1
    }
  }
  ops.reverse()
  return { ops, tieCells }
}

export interface OptimalPath {
  ops: PairOp[]
}

/**
 * 有界枚举区域内全部同分最优路径（DFS + 节点预算）。
 * 用于歧义组：重复句导致同分时给出可选范围，而不是固定取左侧隐藏歧义。
 */
export function enumerateOptimalPaths(
  r: DpResult,
  fromI: number,
  fromJ: number,
  toI: number,
  toJ: number,
  cap = 4,
  nodeBudget = 6000
): OptimalPath[] {
  const { preds } = r
  const width = r.m + 1
  const idx = (i: number, j: number) => i * width + j
  const results: PairOp[][] = []
  const seen = new Set<string>()
  let nodes = 0

  const dfs = (i: number, j: number, acc: PairOp[]) => {
    if (results.length >= cap || nodes > nodeBudget) return
    nodes += 1
    if (i === fromI && j === fromJ) {
      const path = [...acc].reverse()
      const sig = JSON.stringify(path)
      if (!seen.has(sig)) {
        seen.add(sig)
        results.push(path)
      }
      return
    }
    const mask = preds[idx(i, j)]
    if (mask & DIAG) {
      acc.push(diagOp(r, i, j))
      dfs(i - 1, j - 1, acc)
      acc.pop()
    }
    if (mask & DEL) {
      acc.push({ kind: 'gapB', a: i - 1 })
      dfs(i - 1, j, acc)
      acc.pop()
    }
    if (mask & INS) {
      acc.push({ kind: 'gapA', b: j - 1 })
      dfs(i, j - 1, acc)
      acc.pop()
    }
  }

  dfs(toI, toJ, [])
  return results.map((ops) => ({ ops }))
}
