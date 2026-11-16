// 新底本到来后的复核：
//  先比较受影响的锚点；已确认决定逐条标出“仍有效 / 待复核”；
//  旧采用稿与旧依据（basisSnapshot）继续保存，不回滚、不覆盖。
import type {
  AlignAnchor,
  CharacterRef,
  Decision,
  Manuscript,
  MultiColumn,
  NormConfig
} from './types'
import { normalize } from './normalize'

export interface RecheckItem {
  decisionId: string
  status: 'valid' | 'review'
  reason: string
  affectedRefs: CharacterRef[]
}

export interface RecheckReport {
  items: RecheckItem[]
  affectedAnchors: AlignAnchor[]
  newVersionId: string
}

/** 由 store 提供：返回某底本某比较字符的规范字形 */
export type NormLookup = (versionId: string, tIndex: number) => string | undefined

/**
 * @param newMs 新导入底本
 * @param columns 当前多版本列（新本尚未写入 cells）
 * @param decisions 已确认决定
 * @param anchors 现存人工锚点
 * @param normOf 规范化字形查询
 */
export function recheckOnNewManuscript(
  newMs: Manuscript,
  columns: MultiColumn[],
  decisions: Decision[],
  anchors: AlignAnchor[],
  pairExistsFor: (versionId: string) => boolean,
  normOf: NormLookup
): RecheckReport {
  const affectedAnchors: AlignAnchor[] = []
  const items: RecheckItem[] = []

  // 与新本尚无对齐关系时，现存人工锚点全部需要复核
  if (!pairExistsFor(newMs.id)) {
    affectedAnchors.push(...anchors)
  }

  for (const d of decisions) {
    if (d.state !== 'confirmed') continue
    const affectedRefs: CharacterRef[] = []
    let valid = true
    const reasons: string[] = []

    for (const ref of d.bindings) {
      const col = columns.find((c) => c.id === d.targetId)
      if (!col) {
        valid = false
        reasons.push('出处列缺失')
        affectedRefs.push(ref)
        continue
      }
      const cell = col.cells[newMs.id]
      if (cell === undefined || cell === null) {
        valid = false
        reasons.push(`新本「${newMs.name}」在该列无对应文字（可能缺句或移段）`)
        affectedRefs.push(ref)
        continue
      }
      const oldNorm = normOf(ref.versionId, ref.tIndex)
      const newNorm = normOf(newMs.id, cell)
      if (oldNorm !== undefined && newNorm !== undefined && oldNorm !== newNorm) {
        valid = false
        reasons.push(`新本同位文字为「${newNorm}」，与依据「${oldNorm}」不同`)
        affectedRefs.push(ref)
      }
    }

    items.push({
      decisionId: d.id,
      status: valid ? 'valid' : 'review',
      reason: valid ? '新本同位文字一致，决定仍有效' : reasons.join('；'),
      affectedRefs
    })
  }

  return { items, affectedAnchors, newVersionId: newMs.id }
}

/** 将复核结论写回决定；旧依据快照保留 */
export function applyRecheck(decisions: Decision[], report: RecheckItem[]): void {
  const map = new Map(report.map((r) => [r.decisionId, r]))
  for (const d of decisions) {
    const item = map.get(d.id)
    if (!item) continue
    if (!d.basisSnapshot) d.basisSnapshot = JSON.parse(JSON.stringify(d.bindings))
    d.validity = item.status
  }
}

export function defaultNormLookup(
  manuscripts: Manuscript[],
  cfg: NormConfig
): NormLookup {
  const cache = new Map<string, string[]>()
  for (const ms of manuscripts) {
    cache.set(ms.id, normalize(ms, cfg).tokens.map((t) => t.norm))
  }
  return (versionId, tIndex) => cache.get(versionId)?.[tIndex]
}
