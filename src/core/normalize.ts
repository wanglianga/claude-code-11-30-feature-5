// 规范化：标点忽略 + 异体对照。
// 关键约束：每个比较字符（NormToken）都携带其在原文中的码点区间 [srcStart, srcEnd)，
// 规范化“一字对应多字”时区间覆盖多个原码点，反查不丢失。
import type { Manuscript, NormConfig, NormToken, OriginalChar } from './types'
import { isPunctuation } from './codepoint'

export interface NormResult {
  tokens: NormToken[]
  /** token 序号 -> 原文码点区间（便于 O(1) 反查） */
  sourceOf: (tIndex: number) => { start: number; end: number; orig: string }
  /** 原码点序号 -> 覆盖它的 token 序号（被忽略标点返回 null） */
  tokenOfCp: Map<number, number | null>
  ignoredCp: number[]
}

/**
 * 生成比较字符序列：
 * 1. mark（篇章标记）永不进入比较；
 * 2. 开启标点忽略时，标点被跳过但记录在相邻 token 的 ignoredPunct 计数中，原码点不删除；
 * 3. 异体对照支持“多字 -> 一字”：当连续若干原文码点整体映射到同一规范形时合并为一个 token，
 *    srcStart/srcEnd 覆盖全部原码点；
 * 4. 未命中映射的码点各自成 token，规范化形即原字。
 */
export function normalize(ms: Manuscript, cfg: NormConfig): NormResult {
  const tokens: NormToken[] = []
  const tokenOfCp = new Map<number, number | null>()
  const ignoredCp: number[] = []

  const textChars: OriginalChar[] = ms.chars.filter((c) => c.kind !== 'mark')

  const pushToken = (group: OriginalChar[], norm: string, variantApplied: boolean, punctCount: number) => {
    const tIndex = tokens.length
    tokens.push({
      tIndex,
      norm,
      srcStart: group[0].cpIndex,
      srcEnd: group[group.length - 1].cpIndex + 1,
      orig: group.map((g) => g.code).join(''),
      variantApplied,
      ignoredPunct: punctCount
    })
    for (const g of group) tokenOfCp.set(g.cpIndex, tIndex)
  }

  let i = 0
  while (i < textChars.length) {
    const ch = textChars[i]

    if (cfg.ignorePunctuation && ch.kind === 'punct') {
      tokenOfCp.set(ch.cpIndex, null)
      ignoredCp.push(ch.cpIndex)
      i += 1
      continue
    }

    // 尝试多码点异体对照：取最长可命中的连续非标点片段
    const merged = matchVariantGroup(textChars, i, cfg)
    if (merged) {
      const { end, norm } = merged
      const group = textChars.slice(i, end)
      const punctCount = group.filter((g) => g.kind === 'punct').length
      pushToken(group, norm, true, punctCount)
      i = end
      continue
    }

    const norm = cfg.variantMap[ch.code] ?? ch.code
    pushToken([ch], norm, norm !== ch.code, 0)
    i += 1
  }

  return {
    tokens,
    sourceOf: (t: number) => {
      const tk = tokens[t]
      return { start: tk.srcStart, end: tk.srcEnd, orig: tk.orig }
    },
    tokenOfCp,
    ignoredCp
  }
}

interface VariantMatch {
  end: number // textChars 中的排他终点
  norm: string
}

/** 最长匹配：原文连续片段（允许夹着被忽略的标点）整体出现在异体对照中 */
function matchVariantGroup(chars: OriginalChar[], start: number, cfg: NormConfig): VariantMatch | null {
  for (let len = Math.min(6, chars.length - start); len >= 2; len--) {
    const group = chars.slice(start, start + len)
    if (group.some((g) => g.kind === 'mark')) continue
    const key = group
      .filter((g) => !(cfg.ignorePunctuation && g.kind === 'punct'))
      .map((g) => g.code)
      .join('')
    const mapped = cfg.variantMap[key]
    if (mapped !== undefined) return { end: start + len, norm: mapped }
  }
  const single = cfg.variantMap[chars[start].code]
  return single !== undefined ? { end: start + 1, norm: single } : null
}

/** 反查：token -> 坐标区间描述 */
export function tokenProvenance(ms: Manuscript, tk: NormToken): {
  text: string
  orig: string
  start: { page: string; line: number; charInLine: number }
  end: { page: string; line: number; charInLine: number }
} {
  const startCh = ms.chars.find((c) => c.cpIndex === tk.srcStart)!
  const endCh = ms.chars.find((c) => c.cpIndex === tk.srcEnd - 1)!
  return {
    text: tk.norm,
    orig: tk.orig,
    start: startCh.coord,
    end: endCh.coord
  }
}

export function defaultNormConfig(): NormConfig {
  return {
    ignorePunctuation: true,
    variantMap: {
      旹: '時',
      峯: '峰',
      羣: '群',
      无: '無',
      礼: '禮',
      炁: '氣',
      灋: '法',
      '叚借': '假借' // 示例：两字合文对照（一字对多字反查）
    },
    costs: { insert: 1, delete: 1, substitute: 2 },
    moveThreshold: 0.62,
    chunkSize: 24,
    overlapSize: 6
  }
}

export { isPunctuation }
