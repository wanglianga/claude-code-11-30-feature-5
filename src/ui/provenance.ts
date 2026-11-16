// 界面层出处查询：比较字符 -> 原文码点区间 -> 页行坐标
import type { Manuscript, NormToken } from '../core/types'
import { normalize, type NormResult } from '../core/normalize'
import { coordLabel } from '../core/codepoint'

export interface ProvenanceInfo {
  versionName: string
  orig: string
  norm: string
  variantApplied: boolean
  ignoredPunct: number
  cpRange: [number, number]
  startLabel: string
  endLabel: string
}

const cache = new WeakMap<Manuscript, NormResult>()

export function normOf(ms: Manuscript, cfg: Parameters<typeof normalize>[1]): NormResult {
  let n = cache.get(ms)
  if (!n) {
    n = normalize(ms, cfg)
    cache.set(ms, n)
  }
  return n
}

export function provenance(ms: Manuscript, token: NormToken): ProvenanceInfo {
  const startCh = ms.chars.find((c) => c.cpIndex === token.srcStart)
  const endCh = ms.chars.find((c) => c.cpIndex === token.srcEnd - 1)
  return {
    versionName: ms.name,
    orig: token.orig,
    norm: token.norm,
    variantApplied: token.variantApplied,
    ignoredPunct: token.ignoredPunct,
    cpRange: [token.srcStart, token.srcEnd],
    startLabel: startCh ? coordLabel(startCh.coord) : '—',
    endLabel: endCh ? coordLabel(endCh.coord) : '—'
  }
}
