// 项目包：导出可重新导入的完整工程；导入时逐项校验，损坏分块绝不假装恢复成功。
import type {
  Annotation,
  CheckReport,
  Decision,
  DraftBlock,
  DraftOp,
  InsertedPassage,
  Manuscript,
  MoveCandidate,
  MultiColumn,
  NormConfig,
  PairAlignment,
  ProjectPackage
} from './types'
import { checksumOf, sha256Hex } from './hash'
import { normalize } from './normalize'
import { fnv1a } from './ids'

export interface ProjectData {
  project: { name: string; description: string }
  manuscripts: Manuscript[]
  normConfig: NormConfig
  referenceId: string
  pairAlignments: PairAlignment[]
  multiColumns: MultiColumn[]
  insertedPassages: InsertedPassage[]
  moves: MoveCandidate[]
  decisions: Decision[]
  draftBlocks: DraftBlock[]
  ops: DraftOp[]
  annotations: Annotation[]
}

export async function exportPackage(data: ProjectData): Promise<ProjectPackage> {
  const manuscript: Record<string, string> = {}
  for (const ms of data.manuscripts) manuscript[ms.id] = await sha256Hex(ms.rawText)

  const chunk: Record<string, string> = {}
  for (const pair of data.pairAlignments) {
    const msA = data.manuscripts.find((m) => m.id === pair.versionA)!
    for (const seg of pair.segments) {
      const na = normalize(msA, data.normConfig).tokens
      const msB = data.manuscripts.find((m) => m.id === pair.versionB)!
      const nb = normalize(msB, data.normConfig).tokens
      const sa = na.slice(seg.aRange[0], seg.aRange[1] + 1).map((t) => t.norm).join('')
      const sb = nb.slice(seg.bRange[0], seg.bRange[1] + 1).map((t) => t.norm).join('')
      chunk[seg.id] = fnv1a(`${sa}::${sb}`)
    }
  }

  const payload = {
    format: 'guji-collation-package' as const,
    formatVersion: 1 as const,
    exportedAt: new Date().toISOString(),
    project: data.project,
    manuscripts: data.manuscripts,
    normConfig: data.normConfig,
    referenceId: data.referenceId,
    pairAlignments: data.pairAlignments,
    multiColumns: data.multiColumns,
    insertedPassages: data.insertedPassages,
    moves: data.moves,
    decisions: data.decisions,
    draftBlocks: data.draftBlocks,
    ops: data.ops,
    annotations: data.annotations,
    checksums: { manuscript, chunk, overall: '' }
  }
  const { checksums, ...rest } = payload
  const overall = await checksumOf(rest)
  return { ...payload, checksums: { ...checksums, overall } }
}

export class CorruptPackageError extends Error {
  constructor(public readonly problems: string[]) {
    super(`项目包校验失败：${problems.join('；')}`)
    this.name = 'CorruptPackageError'
  }
}

/** 导入并严格校验；任何哈希/结构不符都抛出 CorruptPackageError，不做“假恢复” */
export async function importPackage(text: string): Promise<{ pkg: ProjectPackage; report: CheckReport }> {
  let pkg: ProjectPackage
  try {
    pkg = JSON.parse(text) as ProjectPackage
  } catch (e) {
    throw new CorruptPackageError([`JSON 无法解析：${e instanceof Error ? e.message : String(e)}`])
  }
  const problems: string[] = []
  if (pkg.format !== 'guji-collation-package' || pkg.formatVersion !== 1) {
    problems.push('格式标识或版本号不被支持')
  }
  if (!pkg.checksums || typeof pkg.checksums.overall !== 'string') {
    problems.push('缺少校验和区块')
  }

  // 1. 底本指纹：rawText 逐字哈希
  for (const ms of pkg.manuscripts ?? []) {
    const actual = await sha256Hex(ms.rawText)
    if (actual !== ms.fingerprint) problems.push(`底本 ${ms.name} 内嵌指纹不符（正文已被改动）`)
    const stored = pkg.checksums?.manuscript?.[ms.id]
    if (stored && actual !== stored) problems.push(`底本 ${ms.name} 包校验和不符（分块可能损坏）`)
    if (!stored) problems.push(`底本 ${ms.name} 缺少包校验和`)
  }

  // 2. 分块哈希：用包内配置重新规范化并逐段重算
  if (pkg.normConfig && pkg.manuscripts && pkg.pairAlignments) {
    const byId = new Map(pkg.manuscripts.map((m) => [m.id, m]))
    for (const pair of pkg.pairAlignments) {
      const msA = byId.get(pair.versionA)
      const msB = byId.get(pair.versionB)
      if (!msA || !msB) {
        problems.push(`对齐 ${pair.key} 引用了不存在的底本`)
        continue
      }
      const na = normalize(msA, pkg.normConfig).tokens
      const nb = normalize(msB, pkg.normConfig).tokens
      for (const seg of pair.segments) {
        const sa = na.slice(seg.aRange[0], seg.aRange[1] + 1).map((t) => t.norm).join('')
        const sb = nb.slice(seg.bRange[0], seg.bRange[1] + 1).map((t) => t.norm).join('')
        const actual = fnv1a(`${sa}::${sb}`)
        const stored = pkg.checksums?.chunk?.[seg.id]
        if (!stored) problems.push(`分块 ${seg.id} 缺少校验和`)
        else if (actual !== stored) problems.push(`分块 ${seg.id} 校验和不符（损坏分块，拒绝恢复）`)
      }
    }
  }

  // 3. 整体校验和
  if (pkg.checksums?.overall) {
    const { checksums, ...rest } = pkg
    const actual = await checksumOf(rest)
    if (actual !== pkg.checksums.overall) problems.push('项目包整体校验和不符')
  }

  if (problems.length) throw new CorruptPackageError(problems)

  const report = verifyConsistency(pkg)
  return { pkg, report }
}

/** 正文 / 对齐 / 批注互相一致的核验（打开项目时与导入后都可调用） */
export function verifyConsistency(pkg: ProjectPackage): CheckReport {
  const errors: string[] = []
  const warnings: string[] = []
  const msById = new Map((pkg.manuscripts ?? []).map((m) => [m.id, m]))
  const liveCharIds = new Set((pkg.draftBlocks ?? []).flatMap((b) => b.chars.map((c) => c.id)))
  const columnIds = new Set((pkg.multiColumns ?? []).map((c) => c.id))
  const passageIds = new Set((pkg.insertedPassages ?? []).map((p) => p.id))
  const decisionIds = new Set((pkg.decisions ?? []).map((d) => d.id))

  for (const d of pkg.decisions ?? []) {
    if (!columnIds.has(d.targetId) && !passageIds.has(d.targetId)) {
      errors.push(`决定 ${d.id} 指向不存在的校勘列/新增段 ${d.targetId}`)
    }
    for (const ref of d.bindings) {
      const ms = msById.get(ref.versionId)
      if (!ms) {
        errors.push(`决定 ${d.id} 绑定了不存在的底本 ${ref.versionId}`)
        continue
      }
      const tokenCount = normalize(ms, pkg.normConfig).tokens.length
      if (ref.tIndex < 0 || ref.tIndex >= tokenCount) {
        errors.push(`决定 ${d.id} 绑定字符越界：${ms.name}#${ref.tIndex}`)
      }
    }
  }

  for (const b of pkg.draftBlocks ?? []) {
    if (b.decisionId && !decisionIds.has(b.decisionId)) {
      warnings.push(`采用稿块 ${b.id} 引用的决定 ${b.decisionId} 不存在`)
    }
    for (const c of b.chars) {
      if (c.anchor.type === 'column' && !columnIds.has(c.anchor.columnId)) {
        errors.push(`采用稿字符 ${c.id} 的锚点列 ${c.anchor.columnId} 已不存在`)
      }
    }
  }

  for (const ann of pkg.annotations ?? []) {
    for (const id of ann.charIds) {
      if (!liveCharIds.has(id)) errors.push(`批注 ${ann.id} 挂靠的字符 ${id} 不在采用稿中`)
    }
    if (ann.status === 'pending-relocation' && ann.orphanedFrom.length === 0) {
      warnings.push(`批注 ${ann.id} 处于待重定位但缺少失依记录`)
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    checkedAt: new Date().toISOString()
  }
}
