// 带出处的采用稿导出：正文之外，逐块列出每个采用文字可回查的底本与页行坐标。
import type { Decision, DraftBlock, Manuscript, NormConfig } from './types'
import { normalize } from './normalize'
import { coordLabel } from './codepoint'

export function exportAdoptedMarkdown(
  projectName: string,
  manuscripts: Manuscript[],
  normConfig: NormConfig,
  blocks: DraftBlock[],
  decisions: Decision[]
): string {
  const msById = new Map(manuscripts.map((m) => [m.id, m]))
  const decisionById = new Map(decisions.map((d) => [d.id, d]))
  const lines: string[] = []
  lines.push(`# ${projectName} · 采用稿（帶出處）`)
  lines.push('')
  lines.push(`> 生成時間：${new Date().toISOString()}`)
  lines.push('> 本稿每個采用塊均綁定底本比較字符，可經碼點區間回查原文頁行坐標。')
  lines.push('')
  lines.push('## 正文')
  lines.push('')
  blocks.forEach((b, i) => {
    lines.push(`${i + 1}. ${b.chars.map((c) => c.text).join('')}`)
  })
  lines.push('')
  lines.push('## 出處')
  lines.push('')

  blocks.forEach((b, i) => {
    const decision = b.decisionId ? decisionById.get(b.decisionId) : undefined
    const head = `### 塊 ${i + 1}「${b.chars.map((c) => c.text).join('')}」`
    lines.push(head)
    if (b.manual) {
      lines.push('- 屬性：校勘員人工增補（manual 錨點，不冒稱底本依據）')
      lines.push('')
      return
    }
    if (!decision) {
      lines.push('- 無綁定決定記錄')
      lines.push('')
      return
    }
    lines.push(`- 取捨：${decisionLabel(decision)}`)
    lines.push(`- 理由：${decision.reason || '（未填）'}`)
    const groups = new Map<string, number[]>()
    for (const ref of decision.bindings) {
      const arr = groups.get(ref.versionId) ?? []
      arr.push(ref.tIndex)
      groups.set(ref.versionId, arr)
    }
    for (const [versionId, tIndexes] of groups) {
      const ms = msById.get(versionId)
      if (!ms) continue
      const tokens = normalize(ms, normConfig).tokens
      for (const t of [...new Set(tIndexes)].sort((a, b2) => a - b2)) {
        const token = tokens[t]
        if (!token) continue
        const startCh = ms.chars.find((c) => c.cpIndex === token.srcStart)
        const endCh = ms.chars.find((c) => c.cpIndex === token.srcEnd - 1)
        lines.push(
          `- ${ms.name}：比較形「${token.norm}」原文「${token.orig}」` +
            ` 碼點[${token.srcStart},${token.srcEnd}) ` +
            `${startCh ? coordLabel(startCh.coord) : ''}${endCh && endCh !== startCh ? '–' + coordLabel(endCh.coord) : ''}` +
            `${token.variantApplied ? '（異體歸一，原寫法保留）' : ''}`
        )
      }
    }
    lines.push('')
  })

  lines.push('## 底本指紋')
  lines.push('')
  for (const ms of manuscripts) {
    lines.push(`- ${ms.name}：SHA-256 \`${ms.fingerprint}\``)
  }
  return lines.join('\n')
}

function decisionLabel(d: Decision): string {
  if (d.kind === 'adopt-version') return `采用版本 ${d.chosenVersionId ?? ''}`
  if (d.kind === 'synthesis') return `合成文字「${d.synthesisText ?? ''}」`
  return '暫不取舍'
}
