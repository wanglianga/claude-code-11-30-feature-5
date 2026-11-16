// 带出处的采用稿导出：正文之外，逐块列出每个采用文字可回查的底本与页行坐标；
// 并列出每条引文的迁移结论、新旧指纹与操作链/中断原因。
import type { Citation, Decision, DraftBlock, Manuscript, NormConfig } from './types'
import { normalize } from './normalize'
import { coordLabel } from './codepoint'
import { statusLabel } from './citation'

export function exportAdoptedMarkdown(
  projectName: string,
  manuscripts: Manuscript[],
  normConfig: NormConfig,
  blocks: DraftBlock[],
  decisions: Decision[],
  citations: Citation[] = []
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

  if (citations.length) {
    lines.push('')
    lines.push('## 引文與遷移結論')
    lines.push('')
    for (const cit of citations) {
      lines.push(`### ${cit.label}（${cit.purpose}）`)
      lines.push(`- 遷移狀態：${statusLabel(cit.status)}`)
      lines.push(`- 現行範圍：${cit.span.text}｜指紋 \`${cit.textFingerprint}\`｜記錄修訂 r${cit.recordedAtRevision}`)
      for (const anchor of cit.baseAnchors) {
        const ms = msById.get(anchor.versionId)
        lines.push(
          `- 底本錨點：${ms?.name ?? anchor.versionId} token [${anchor.tokenStart}, ${anchor.tokenEnd}]「${anchor.text}」`
        )
      }
      lines.push(`- 舊前後文：${cit.context.before || '—'}｜${cit.context.after || '—'}`)
      const m = cit.lastMigration
      if (m) {
        lines.push(
          `- 最近遷移：${statusLabel(m.status)}（${m.path === 'ops' ? '操作鏈' : '局部重對齊'}）` +
            `｜舊指紋 \`${m.oldFingerprint}\` → 新指紋 \`${m.newFingerprint}\`` +
            (m.stale ? '｜候選已失效' : '')
        )
        if (m.interrupted) lines.push(`  - 操作鏈中斷：${m.interrupted}`)
        if (m.opChain.length) lines.push(`  - 操作鏈：${m.opChain.join(' → ')}`)
        for (const c of m.candidates) {
          lines.push(`  - 待定候選：塊 ${c.blockId} [${c.start}, ${c.end}]「${c.text}」相似度 ${(c.similarity * 100).toFixed(1)}%`)
        }
      }
      if (cit.history.length) {
        lines.push(`- 舊修訂記錄 ${cit.history.length} 條（保留不回寫）`)
      }
      lines.push('')
    }
  }
  return lines.join('\n')
}

function decisionLabel(d: Decision): string {
  if (d.kind === 'adopt-version') return `采用版本 ${d.chosenVersionId ?? ''}`
  if (d.kind === 'synthesis') return `合成文字「${d.synthesisText ?? ''}」`
  return '暫不取舍'
}
