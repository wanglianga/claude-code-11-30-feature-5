// Unicode 码点级工具：拆字、字类判定、页行坐标解析
import type { CharCoord, CharKind, OriginalChar } from './types'

const PUNCT_CHARS = new Set(
  '。，、；：？！·…—–-「」『』（）()《》〈〉“”‘’﹏﹐﹑﹒﹔﹕﹖﹗．﹐﹑｡，．·￩￫'.split('')
)

/** 篇章边界标记，形如 〖篇：學而〗 */
const CHAPTER_RE = /〖篇：([^〗]+)〗/g

export function splitCodePoints(s: string): string[] {
  // Array.from 按码点迭代，可正确处理代理对（如扩展 B 区汉字）
  return Array.from(s)
}

export function isPunctuation(code: string): boolean {
  return PUNCT_CHARS.has(code)
}

export function classify(code: string): CharKind {
  if (isPunctuation(code)) return 'punct'
  return 'text'
}

export interface ChapterHint {
  name: string
  beforeCpIndex: number // 标记之后第一个码点的序号
}

export interface ParsedRaw {
  chars: OriginalChar[]
  chapters: ChapterHint[]
  pageLineAt: (cpIndex: number) => CharCoord
}

/**
 * 原始转写约定（纯文本、可人工编写）：
 *  - \f 分页；页号按出现顺序记为 P1、P2…
 *  - \n 分行；行号每页从 1 开始
 *  - 〖篇：名〗 为篇章边界标记，本身不计入比较字符
 * 其余每个 Unicode 码点均原样保留，含标点
 */
export function parseRawText(rawText: string): ParsedRaw {
  const chars: OriginalChar[] = []
  const chapters: ChapterHint[] = []
  const coordByCp: CharCoord[] = []

  const pages = rawText.split('\f')
  let cpIndex = 0
  pages.forEach((page, pi) => {
    const pageId = `P${pi + 1}`
    const lines = page.split('\n')
    lines.forEach((line, li) => {
      const lineNo = li + 1
      let charInLine = 0
      for (const code of splitCodePoints(line)) {
        const coord: CharCoord = { page: pageId, line: lineNo, charInLine }
        coordByCp[cpIndex] = coord
        chars.push({ cpIndex, code, kind: classify(code), coord })
        cpIndex += 1
        charInLine += 1
      }
    })
  })

  // 第二遍：识别篇章标记，把标记码点改为 mark，并记录边界
  const joined = rawText
  let match: RegExpExecArray | null
  CHAPTER_RE.lastIndex = 0
  while ((match = CHAPTER_RE.exec(joined)) !== null) {
    const markerStart = match.index
    const markerCp = splitCodePoints(joined.slice(0, markerStart)).length
    const markerLen = splitCodePoints(match[0]).length
    for (let i = markerCp; i < markerCp + markerLen && i < chars.length; i++) {
      chars[i].kind = 'mark'
    }
    chapters.push({ name: match[1].trim(), beforeCpIndex: markerCp + markerLen })
  }

  return {
    chars,
    chapters,
    pageLineAt: (i: number) => coordByCp[i]
  }
}

/** 原文码点区间 -> 字符串（区间 [start, end)） */
export function sliceByCp(rawText: string, start: number, end: number): string {
  const cps = splitCodePoints(rawText)
  return cps.slice(start, end).join('')
}

export function coordLabel(c: CharCoord): string {
  return `${c.page} 第${c.line}行 第${c.charInLine + 1}字`
}
