import { describe, expect, it } from 'vitest'
import { parseRawText, splitCodePoints } from '../src/core/codepoint'
import { buildManuscript } from '../src/core/pipeline'
import { defaultNormConfig, normalize } from '../src/core/normalize'

describe('码点与页行坐标', () => {
  it('按 Unicode 码点拆字，代理对安全', () => {
    expect(splitCodePoints('abc').length).toBe(3)
    const rare = '𤔡' // 扩展 B 区，UTF-16 双代理
    expect(splitCodePoints(rare).length).toBe(1)
  })

  it('保留页/行/字坐标，\\f 分页、\\n 分行', async () => {
    const ms = await buildManuscript('t1', '测试本', '', '甲乙\n丙丁\f戊')
    expect(ms.chars[0].coord).toEqual({ page: 'P1', line: 1, charInLine: 0 })
    expect(ms.chars[2].coord).toEqual({ page: 'P1', line: 2, charInLine: 0 })
    expect(ms.chars[4].coord.page).toBe('P2')
  })

  it('篇章标记码点标为 mark，不进入比较字符', async () => {
    const ms = await buildManuscript('t2', '本', '', '〖篇：學而〗\n學而時習')
    const parsed = parseRawText(ms.rawText)
    expect(parsed.chapters).toHaveLength(1)
    const tokens = normalize(ms, defaultNormConfig()).tokens
    expect(tokens.map((t) => t.norm).join('')).toBe('學而時習')
  })

  it('指纹为正文 SHA-256，正文改动指纹变化', async () => {
    const a = await buildManuscript('a', 'a', '', '同一段文字')
    const b = await buildManuscript('b', 'b', '', '同一段文宇')
    expect(a.fingerprint).toHaveLength(64)
    expect(a.fingerprint).not.toBe(b.fingerprint)
  })
})

describe('规范化与反查', () => {
  it('异体对照后原文区间仍可反查，标点被忽略但未删除', async () => {
    const cfg = defaultNormConfig()
    const ms = await buildManuscript('v', '異寫本', '', '學而旹習，之又')
    const r = normalize(ms, cfg)
    const shi = r.tokens.find((t) => t.norm === '時')!
    expect(shi).toBeDefined()
    expect(shi.variantApplied).toBe(true)
    expect(ms.chars.slice(shi.srcStart, shi.srcEnd).map((c) => c.code).join('')).toBe('旹')
    // 标点被忽略但原码点仍在
    const punct = ms.chars.find((c) => c.kind === 'punct')!
    expect(punct).toBeDefined()
    expect(r.tokenOfCp.get(punct.cpIndex)).toBe(null)
  })

  it('一字对多字合文对照不丢失反查区间', async () => {
    const cfg = defaultNormConfig()
    cfg.variantMap = { 叚借: '假借' }
    const ms = await buildManuscript('v2', '合文本', '', '叚借之法')
    const r = normalize(ms, cfg)
    const merged = r.tokens.find((t) => t.norm === '假借')!
    expect(merged.srcEnd - merged.srcStart).toBe(2)
    expect(merged.orig).toBe('叚借')
  })
})
