// 采用稿编辑：通过操作记录（DraftOp）维护原文锚点。
// 每个采用稿字符持有稳定 id 与原文锚点（对齐列 + 底本字符引用），
// 删除承载批注的文字时批注转为“待重定位”，绝不自动挂到旁边一句。
import type {
  Annotation,
  CharacterRef,
  Decision,
  DraftBlock,
  DraftChar,
  DraftOp
} from './types'
import { rid } from './ids'

export function makeChar(text: string, anchor: DraftChar['anchor']): DraftChar {
  return { id: rid('dc'), text, anchor }
}

export function blockFromDecision(decision: Decision, text: string, refs: CharacterRef[]): DraftBlock {
  const chars = Array.from(text).map((code) =>
    makeChar(code, { type: 'column', columnId: decision.targetId, refs })
  )
  return {
    id: rid('blk'),
    columnId: decision.targetId,
    decisionId: decision.id,
    chars
  }
}

export function manualBlock(text: string): DraftBlock {
  return { id: rid('blk'), chars: Array.from(text).map((code) => makeChar(code, { type: 'manual' })), manual: true }
}

export interface DraftState {
  blocks: DraftBlock[]
  ops: DraftOp[]
  annotations: Annotation[]
}

function logOp(ops: DraftOp[], type: DraftOp['type'], args: Record<string, unknown>): void {
  ops.push({ id: rid('op'), type, args, at: Date.now() })
}

/** 校勘员在采用稿前面加一句：插入新块，既有字符 id 与锚点不变，批注不会挪错 */
export function insertBlockAt(state: DraftState, index: number, block: DraftBlock): void {
  state.blocks.splice(index, 0, block)
  logOp(state.ops, 'insert-block', { index, blockId: block.id })
}

export function appendBlock(state: DraftState, block: DraftBlock): void {
  insertBlockAt(state, state.blocks.length, block)
}

export function deleteBlock(state: DraftState, blockId: string): void {
  const idx = state.blocks.findIndex((b) => b.id === blockId)
  if (idx < 0) return
  const removed = state.blocks[idx]
  orphanAnnotations(state, removed.chars.map((c) => c.id))
  state.blocks.splice(idx, 1)
  logOp(state.ops, 'delete-block', { blockId, charIds: removed.chars.map((c) => c.id) })
}

/** 在块内插入文字（校勘员增补），新字符为 manual 锚点，不影响既有字符标识 */
export function insertChars(state: DraftState, blockId: string, at: number, text: string): void {
  const block = state.blocks.find((b) => b.id === blockId)
  if (!block) return
  const add = Array.from(text).map((code) => makeChar(code, { type: 'manual' }))
  block.chars.splice(at, 0, ...add)
  logOp(state.ops, 'insert-chars', { blockId, at, charIds: add.map((c) => c.id) })
}

/** 删除文字：按稳定 id 命中（不用下标），承载批注则令批注待重定位 */
export function deleteChars(state: DraftState, blockId: string, charIds: string[]): void {
  const block = state.blocks.find((b) => b.id === blockId)
  if (!block) return
  const kill = new Set(charIds)
  orphanAnnotations(state, charIds)
  block.chars = block.chars.filter((c) => !kill.has(c.id))
  logOp(state.ops, 'delete-chars', { blockId, charIds })
}

export function replaceBlock(state: DraftState, blockId: string, next: DraftBlock): void {
  const idx = state.blocks.findIndex((b) => b.id === blockId)
  if (idx < 0) return
  const oldIds = state.blocks[idx].chars.map((c) => c.id)
  const newIds = new Set(next.chars.map((c) => c.id))
  const gone = oldIds.filter((id) => !newIds.has(id))
  orphanAnnotations(state, gone)
  state.blocks.splice(idx, 1, next)
  logOp(state.ops, 'replace-block', { blockId, nextBlockId: next.id, removedCharIds: gone })
}

export function moveBlock(state: DraftState, blockId: string, toIndex: number): void {
  const idx = state.blocks.findIndex((b) => b.id === blockId)
  if (idx < 0) return
  const [block] = state.blocks.splice(idx, 1)
  const target = Math.max(0, Math.min(toIndex, state.blocks.length))
  state.blocks.splice(target, 0, block)
  logOp(state.ops, 'move-block', { blockId, toIndex: target })
}

function orphanAnnotations(state: DraftState, removedCharIds: string[]): void {
  for (const id of removedCharIds) {
    for (const ann of state.annotations) {
      if (ann.status === 'active' && ann.charIds.includes(id)) {
        ann.status = 'pending-relocation'
        ann.orphanedFrom = [...new Set([...ann.orphanedFrom, id])]
        ann.charIds = ann.charIds.filter((x) => x !== id)
      }
    }
  }
}

/** 批注重挂必须显式指定新字符，系统不自动挂靠 */
export function relocateAnnotation(state: DraftState, annotationId: string, newCharIds: string[]): void {
  const ann = state.annotations.find((a) => a.id === annotationId)
  if (!ann || ann.status !== 'pending-relocation') return
  const live = new Set(state.blocks.flatMap((b) => b.chars.map((c) => c.id)))
  ann.charIds = newCharIds.filter((id) => live.has(id))
  ann.status = ann.charIds.length ? 'active' : 'pending-relocation'
  if (ann.status === 'active') ann.orphanedFrom = []
}

export function addAnnotation(state: DraftState, charIds: string[], content: string): Annotation {
  const ann: Annotation = {
    id: rid('ann'),
    charIds,
    content,
    status: 'active',
    orphanedFrom: [],
    at: Date.now()
  }
  state.annotations.push(ann)
  return ann
}

export function draftPlainText(blocks: DraftBlock[]): string {
  return blocks.map((b) => b.chars.map((c) => c.text).join('')).join('')
}
