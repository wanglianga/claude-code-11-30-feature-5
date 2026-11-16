// 纯计算管线：Worker 与单元测试共用，不依赖 DOM。
import type {
  AlignAnchor,
  AlignmentRevision,
  Manuscript,
  MoveCandidate,
  NormConfig,
  PairAlignment,
  SegmentAlign
} from './types'
import { parseRawText } from './codepoint'
import { fingerprint } from './hash'
import { normalize } from './normalize'
import {
  CanceledError,
  alignRegion,
  chunkedAlign,
  findRuns,
  pairRuns,
  planSegments,
  type CancelSignal
} from './align/align'
import { rid } from './ids'

export async function buildManuscript(
  id: string,
  name: string,
  note: string,
  rawText: string
): Promise<Manuscript> {
  const parsed = parseRawText(rawText)
  return {
    id,
    name,
    note,
    rawText,
    fingerprint: await fingerprint(rawText),
    chars: parsed.chars
  }
}

/** 篇章与页界（码点序号）转换为规范化 token 序号；两者都作为分段边界 */
function segmentTokenBounds(ms: Manuscript, tokenOfCp: Map<number, number | null>): number[] {
  const parsed = parseRawText(ms.rawText)
  const cpCuts = new Set<number>(parsed.chapters.map((c) => c.beforeCpIndex))
  // 每页第一个码点
  const pages = new Set(ms.chars.map((c) => c.coord.page))
  for (const page of pages) {
    const first = ms.chars.find((c) => c.coord.page === page)
    if (first) cpCuts.add(first.cpIndex)
  }
  const bounds: number[] = []
  const sortedCuts = [...cpCuts].sort((a, b) => a - b)
  for (const cutCp of sortedCuts) {
    let t: number | null = null
    for (const [cp, tk] of tokenOfCp) {
      if (cp >= cutCp && tk !== null) {
        t = tk
        break
      }
    }
    if (t !== null) bounds.push(t)
  }
  return [...new Set(bounds)].sort((a, b) => a - b)
}

export interface PipelineResult {
  alignment: PairAlignment
  moves: MoveCandidate[]
}

export function computePairAlignment(
  msA: Manuscript,
  msB: Manuscript,
  cfg: NormConfig,
  anchors: AlignAnchor[],
  revisions: AlignmentRevision[],
  signal: CancelSignal = { canceled: false },
  onProgress?: (done: number, total: number) => void
): PipelineResult {
  const normA = normalize(msA, cfg)
  const normB = normalize(msB, cfg)
  const boundsA = segmentTokenBounds(msA, normA.tokenOfCp)
  const boundsB = segmentTokenBounds(msB, normB.tokenOfCp)

  const plans = planSegments(normA.tokens, normB.tokens, boundsA, boundsB, anchors, revisions)
  const segments: SegmentAlign[] = []
  let done = 0
  for (const plan of plans) {
    if (signal.canceled) throw new CanceledError()
    const outcome = chunkedAlign(normA.tokens, normB.tokens, plan, cfg, signal)
    segments.push({
      id: plan.id,
      aRange: plan.aRange,
      bRange: plan.bRange,
      columns: outcome.columns,
      cost: outcome.cost,
      ambiguousGroups: outcome.ambiguousGroups,
      seamVerified: outcome.seamVerified,
      chunkHash: outcome.chunkHash
    })
    done += 1
    onProgress?.(done, plans.length)
  }

  // 移段检测：按段收集连续增删片段（保持段内相邻性），再跨段配对（整段迁移可跨越页/章边界）
  const delRuns = []
  const insRuns = []
  for (const seg of segments) {
    const runs = findRuns(seg.columns, normA.tokens, normB.tokens)
    delRuns.push(...runs.filter((r) => r.side === 'A'))
    insRuns.push(...runs.filter((r) => r.side === 'B'))
  }
  const movePairs = pairRuns(delRuns, insRuns, cfg.moveThreshold)
  const moves: MoveCandidate[] = movePairs.map((p) => ({
    id: rid('move'),
    baseVersionId: msA.id,
    otherVersionId: msB.id,
    deleteRun: { start: p.deleteRun.start, end: p.deleteRun.end },
    insertRun: { start: p.insertRun.start, end: p.insertRun.end },
    similarity: p.similarity,
    context: {
      beforeA: p.deleteRun.contextBefore,
      afterA: p.deleteRun.contextAfter,
      beforeB: p.insertRun.contextBefore,
      afterB: p.insertRun.contextAfter
    },
    status: 'suggested'
  }))

  const alignment: PairAlignment = {
    key: `${msA.id}::${msB.id}`,
    versionA: msA.id,
    versionB: msB.id,
    configSnapshot: JSON.parse(JSON.stringify(cfg)),
    anchors: JSON.parse(JSON.stringify(anchors)),
    revisions: JSON.parse(JSON.stringify(revisions)),
    segments,
    status: 'done',
    computedAt: Date.now()
  }
  return { alignment, moves }
}

export { alignRegion, CanceledError }
