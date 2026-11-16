// 两份本地导出文件的合并：
//  - 彼此不相交的修改自动合入；
//  - 同一异文的相反取舍、移动范围重叠等冲突逐项列出，必须逐项选择，
//    不允许“后导入整份覆盖”。
import type {
  Citation,
  Decision,
  DraftBlock,
  MigrationResult,
  MoveCandidate,
  ProjectPackage
} from './types'
import { CorruptPackageError } from './package'

export type ConflictKind =
  | 'opposite-decision'
  | 'overlapping-move'
  | 'same-block-edit'
  | 'citation-diverged'

export interface MergeConflict {
  id: string
  kind: ConflictKind
  target: string
  description: string
  baseSummary: string
  incomingSummary: string
  resolution?: 'base' | 'incoming'
}

export interface MergeOutcome {
  merged: ProjectPackage
  conflicts: MergeConflict[]
  autoMerged: string[]
}

export function detectConflicts(base: ProjectPackage, incoming: ProjectPackage): MergeConflict[] {
  const conflicts: MergeConflict[] = []

  // 1. 同一异文（同一 target）的相反取舍
  const baseDecisions = new Map(base.decisions.map((d) => [d.targetId, d]))
  for (const inc of incoming.decisions) {
    const bs = baseDecisions.get(inc.targetId)
    if (bs && !sameDecision(bs, inc)) {
      conflicts.push({
        id: `cf_dec_${inc.targetId}`,
        kind: 'opposite-decision',
        target: inc.targetId,
        description: `同一异文列存在相反取舍`,
        baseSummary: summarizeDecision(bs),
        incomingSummary: summarizeDecision(inc)
      })
    }
  }

  // 2. 移动范围重叠（同一对版本）；两份包中 id 相同且未改动的候选不算冲突
  for (const im of incoming.moves) {
    for (const bm of base.moves) {
      if (im.id === bm.id) continue
      if (bm.baseVersionId === im.baseVersionId && bm.otherVersionId === im.otherVersionId && rangesOverlap(bm, im)) {
        conflicts.push({
          id: `cf_move_${im.id}`,
          kind: 'overlapping-move',
          target: im.id,
          description: '移段候选的原文/新位置范围重叠',
          baseSummary: `甲${bm.deleteRun.start}-${bm.deleteRun.end} → 乙${bm.insertRun.start}-${bm.insertRun.end}`,
          incomingSummary: `甲${im.deleteRun.start}-${im.deleteRun.end} → 乙${im.insertRun.start}-${im.insertRun.end}`
        })
      }
    }
  }

  // 3. 采用稿同一块（锚定同一列）被两边分别修改
  const baseByColumn = new Map(base.draftBlocks.filter((b) => b.columnId).map((b) => [b.columnId!, b]))
  for (const ib of incoming.draftBlocks) {
    if (!ib.columnId) continue
    const bb = baseByColumn.get(ib.columnId)
    if (bb && blockText(bb) !== blockText(ib)) {
      conflicts.push({
        id: `cf_blk_${ib.columnId}`,
        kind: 'same-block-edit',
        target: ib.columnId,
        description: '同一出处列的采用稿文字被两边分别修改',
        baseSummary: blockText(bb),
        incomingSummary: blockText(ib)
      })
    }
  }
  // 4. 引文：同一引文被两边分别迁移/改稿（引用版本不同）必须逐项选择
  const baseCitations = new Map((base.citations ?? []).map((c) => [c.id, c]))
  for (const ic of incoming.citations ?? []) {
    const bc = baseCitations.get(ic.id)
    if (!bc) continue
    if (bc.revision !== ic.revision && !sameCitation(bc, ic)) {
      conflicts.push({
        id: `cf_cit_${ic.id}`,
        kind: 'citation-diverged',
        target: ic.id,
        description: '同一引文被两邊分別遷移或改寫',
        baseSummary: `版本 ${bc.revision}：${bc.span.text}（${citationLabel(bc.status)}）`,
        incomingSummary: `版本 ${ic.revision}：${ic.span.text}（${citationLabel(ic.status)}）`
      })
    }
  }
  return conflicts
}

export function mergePackages(
  base: ProjectPackage,
  incoming: ProjectPackage,
  resolutions: Record<string, 'base' | 'incoming'>
): MergeOutcome {
  const conflicts = detectConflicts(base, incoming)
  const unresolved = conflicts.filter((c) => !resolutions[c.id])
  if (unresolved.length) {
    throw new CorruptPackageError([`仍有 ${unresolved.length} 项冲突未逐项选择，拒绝合并`])
  }
  const pick = (id: string): 'base' | 'incoming' => resolutions[id]

  // 底本：按 id 合并，指纹不一致直接报错（同 id 不同正文不允许静默覆盖）
  const msMap = new Map(base.manuscripts.map((m) => [m.id, m]))
  const autoMerged: string[] = []
  for (const im of incoming.manuscripts) {
    const bm = msMap.get(im.id)
    if (!bm) {
      msMap.set(im.id, im)
      autoMerged.push(`新底本：${im.name}`)
    } else if (bm.fingerprint !== im.fingerprint) {
      throw new CorruptPackageError([`底本 ${im.name} 同 id 但指纹不同，无法合并`])
    }
  }

  // 决定：跳过冲突中判给 base 的 incoming 项
  const decisions: Decision[] = [...base.decisions]
  const baseTargetSet = new Map(base.decisions.map((d) => [d.targetId, d]))
  for (const inc of incoming.decisions) {
    const conflict = conflicts.find((c) => c.kind === 'opposite-decision' && c.target === inc.targetId)
    if (conflict) {
      if (pick(conflict.id) === 'incoming') {
        const idx = decisions.findIndex((d) => d.targetId === inc.targetId)
        decisions[idx] = inc
      }
      continue
    }
    if (!baseTargetSet.has(inc.targetId)) {
      decisions.push(inc)
      autoMerged.push(`不相交取舍：列 ${inc.targetId}`)
    }
  }

  // 移段
  const moves: MoveCandidate[] = [...base.moves]
  for (const im of incoming.moves) {
    const overlappingIdx = moves.findIndex(
      (bm) =>
        bm.baseVersionId === im.baseVersionId &&
        bm.otherVersionId === im.otherVersionId &&
        rangesOverlap(bm, im)
    )
    if (overlappingIdx >= 0) {
      const cf = conflicts.find((c) => c.kind === 'overlapping-move' && c.target === im.id)
      if (cf && pick(cf.id) === 'incoming') moves[overlappingIdx] = im
    } else {
      moves.push(im)
      autoMerged.push(`不相交移段：${im.id}`)
    }
  }

  // 采用稿块：按 columnId / id 去重，冲突按选择，不相交直接并入
  const blocks: DraftBlock[] = [...base.draftBlocks]
  const blockColIndex = new Map(blocks.map((b, i) => [b.columnId ?? b.id, i]))
  for (const ib of incoming.draftBlocks) {
    const key = ib.columnId ?? ib.id
    const existingIdx = blockColIndex.get(key)
    if (existingIdx === undefined) {
      blocks.push(ib)
      if (ib.columnId) autoMerged.push(`不相交采用稿块：列 ${ib.columnId}`)
      continue
    }
    const cf = conflicts.find((c) => c.kind === 'same-block-edit' && c.target === ib.columnId)
    if (cf && pick(cf.id) === 'incoming') blocks[existingIdx] = ib
  }

  // 批注、操作记录按 id 并集
  const annIds = new Set(base.annotations.map((a) => a.id))
  const annotations = [...base.annotations, ...incoming.annotations.filter((a) => !annIds.has(a.id))]
  const opIds = new Set(base.ops.map((o) => o.id))
  const ops = [...base.ops, ...incoming.ops.filter((o) => !opIds.has(o.id))]

  // 对齐配对按 key 并集（PairAlignment 无 id 字段，以 key 去重）
  const pairMap = new Map(base.pairAlignments.map((p) => [p.key, p]))
  for (const p of incoming.pairAlignments) if (!pairMap.has(p.key)) pairMap.set(p.key, p)

  // 引文按 id 合并：冲突逐项选择，不相交并入；引用版本高者不自动胜出
  const citations: Citation[] = [...(base.citations ?? [])]
  const citIndex = new Map(citations.map((c, i) => [c.id, i]))
  for (const ic of incoming.citations ?? []) {
    const at = citIndex.get(ic.id)
    if (at === undefined) {
      citations.push(ic)
      citIndex.set(ic.id, citations.length - 1)
      autoMerged.push(`新增引文：${ic.label}`)
      continue
    }
    const cf = conflicts.find((c) => c.kind === 'citation-diverged' && c.target === ic.id)
    if (cf && pick(cf.id) === 'incoming') citations[at] = ic
  }

  // 迁移结果按 citationId + 引用版本去重，保留两边各自的历史候选
  const migrations: MigrationResult[] = [...(base.citationMigrations ?? [])]
  const migKey = (m: MigrationResult) => `${m.citationId}@${m.citationRevision}@${m.draftRevision}`
  const migSeen = new Set(migrations.map(migKey))
  for (const m of incoming.citationMigrations ?? []) {
    if (migSeen.has(migKey(m))) continue
    migSeen.add(migKey(m))
    migrations.push(m)
  }

  const merged: ProjectPackage = {
    ...base,
    manuscripts: [...msMap.values()],
    decisions,
    moves,
    draftBlocks: blocks,
    annotations,
    ops,
    citations,
    citationMigrations: migrations,
    multiColumns: unionById(base.multiColumns, incoming.multiColumns),
    insertedPassages: unionById(base.insertedPassages, incoming.insertedPassages),
    pairAlignments: [...pairMap.values()],
    exportedAt: new Date().toISOString(),
    checksums: base.checksums // 合并后由调用方重新导出计算
  }
  return { merged, conflicts, autoMerged }
}

function unionById<T extends { id: string }>(a: T[], b: T[]): T[] {
  const seen = new Map(a.map((x) => [x.id, x]))
  for (const item of b) if (!seen.has(item.id)) seen.set(item.id, item)
  return [...seen.values()]
}

function sameDecision(a: Decision, b: Decision): boolean {
  return a.kind === b.kind && a.chosenVersionId === b.chosenVersionId && a.synthesisText === b.synthesisText
}

function sameCitation(a: Citation, b: Citation): boolean {
  return (
    a.textFingerprint === b.textFingerprint &&
    a.status === b.status &&
    a.recordedAtRevision === b.recordedAtRevision &&
    a.span.charIds.join(',') === b.span.charIds.join(',')
  )
}

function citationLabel(status: Citation['status']): string {
  const map: Record<Citation['status'], string> = {
    moved: '位置變化',
    'text-changed': '文字變化',
    split: '拆分關聯',
    deleted: '刪除',
    unresolved: '未解決'
  }
  return map[status]
}

function summarizeDecision(d: Decision): string {
  if (d.kind === 'adopt-version') return `采用 ${d.chosenVersionId ?? '?'}`
  if (d.kind === 'synthesis') return `合成：${d.synthesisText ?? ''}`
  return '暂不取舍'
}

function blockText(b: DraftBlock): string {
  return b.chars.map((c) => c.text).join('')
}

function rangesOverlap(a: MoveCandidate, b: MoveCandidate): boolean {
  const d = a.deleteRun.start <= b.deleteRun.end && b.deleteRun.start <= a.deleteRun.end
  const i = a.insertRun.start <= b.insertRun.end && b.insertRun.start <= a.insertRun.end
  return d || i
}
