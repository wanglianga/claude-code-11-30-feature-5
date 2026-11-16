import { describe, expect, it } from 'vitest'
import {
  addAnnotation,
  appendBlock,
  deleteChars,
  draftPlainText,
  insertBlockAt,
  manualBlock,
  relocateAnnotation,
  type DraftState
} from '../src/core/draft'

function state(): DraftState {
  return { blocks: [], ops: [], annotations: [] }
}

describe('采用稿操作记录与锚点', () => {
  it('稿前插句不改变既有字符标识，批注不挪错', () => {
    const s = state()
    const first = manualBlock('原文甲')
    appendBlock(s, first)
    const originalIds = first.chars.map((c) => c.id)
    const ann = addAnnotation(s, [originalIds[0]], '校記')
    insertBlockAt(s, 0, manualBlock('新增一句'))
    // 字符 id 不依赖下标，插句后仍然有效
    expect(s.blocks[1].chars.map((c) => c.id)).toEqual(originalIds)
    expect(s.annotations[0].id).toBe(ann.id)
    expect(s.annotations[0].status).toBe('active')
    expect(s.ops).toHaveLength(2)
  })

  it('删除承载批注的文字使批注待重定位，不自动挂旁句', () => {
    const s = state()
    const block = manualBlock('甲乙丙')
    appendBlock(s, block)
    const yiId = block.chars[1].id
    addAnnotation(s, [yiId], '關於乙字')
    deleteChars(s, block.id, [yiId])
    const ann = s.annotations[0]
    expect(ann.status).toBe('pending-relocation')
    expect(ann.orphanedFrom).toContain(yiId)
    expect(ann.charIds).not.toContain(yiId)
    // 没有自动挂到相邻的甲或丙
    expect(ann.charIds.length).toBe(0)
  })

  it('批注必须显式重挂到现存字符', () => {
    const s = state()
    const block = manualBlock('甲乙丙')
    appendBlock(s, block)
    const yiId = block.chars[1].id
    const bingId = block.chars[2].id
    addAnnotation(s, [yiId], 'x')
    deleteChars(s, block.id, [yiId])
    relocateAnnotation(s, s.annotations[0].id, [bingId])
    expect(s.annotations[0].status).toBe('active')
    expect(s.annotations[0].charIds).toEqual([bingId])
  })

  it('操作记录可还原编辑顺序', () => {
    const s = state()
    appendBlock(s, manualBlock('甲'))
    insertBlockAt(s, 0, manualBlock('乙'))
    expect(s.ops.map((o) => o.type)).toEqual(['insert-block', 'insert-block'])
    expect(draftPlainText(s.blocks)).toBe('乙甲')
  })
})
