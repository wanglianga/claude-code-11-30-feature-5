import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useCollationStore } from '../src/stores/collation'
import { CorruptPackageError } from '../src/core/package'

// Node 环境无 localStorage / Worker：store 会自动走同步计算管线，persist 静默失败
describe('Pinia 端到端主链路', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => setActivePinia(createPinia()))

  it('加载样例 → 全部配对完成 → 多版本列覆盖所有底本 token', async () => {
    const store = useCollationStore()
    await store.loadSample()
    expect(store.manuscripts).toHaveLength(4)
    for (const key of Object.keys(store.pairs)) {
      expect(store.pairs[key].status).toBe('done')
    }
    // 丙本移段候选存在
    const allMoves = Object.values(store.pairs).flatMap((p) => p.moves)
    expect(allMoves.some((m) => m.similarity >= store.normConfig.moveThreshold)).toBe(true)
    // 每个底本的每个 token 都出现在多版本列或新增段中
    for (const ms of store.manuscripts) {
      const total = store.tokensOf(ms.id).length
      const covered = new Set<number>()
      for (const col of store.multiColumns) {
        const t = col.cells[ms.id]
        if (t !== null && t !== undefined) covered.add(t)
      }
      for (const p of store.insertedPassages) {
        if (p.ownerVersionId !== ms.id) continue
        for (let t = p.tokenRange[0]; t <= p.tokenRange[1]; t++) covered.add(t)
      }
      expect(covered.size).toBe(total)
    }
  })

  it('决定 → 采用稿带锚点 → 导出/导入保持一致', async () => {
    const store = useCollationStore()
    await store.loadSample()
    const target = store.multiColumns[0].id
    store.submitDecision(target, 'adopt-version', {
      chosenVersionId: store.referenceId!,
      reason: '测试理由'
    })
    expect(store.confirmedDecisions).toHaveLength(1)
    expect(store.draftBlocks.length).toBeGreaterThan(0)
    const block = store.draftBlocks.find((b) => b.columnId === target)!
    expect(block.chars[0].anchor.type).toBe('column')

    // 稿前插句不破坏锚点
    const beforeIds = block.chars.map((c) => c.id)
    store.insertManualSentence(0, '新增句')
    expect(store.draftBlocks[1].chars.map((c) => c.id)).toEqual(beforeIds)

    const text = await store.exportProject()
    const report = await store.importProject(text)
    expect(report.ok).toBe(true)
    expect(store.decisions[0].reason).toBe('测试理由')
  })

  it('两份包合并：不相交修改自动合入', async () => {
    const store = useCollationStore()
    await store.loadSample()
    const pkgA = await store.exportProject()
    const c1 = store.multiColumns[2].id
    store.submitDecision(c1, 'defer', { reason: '暂缺证据' })
    const pkgB = await store.exportProject()

    // 重置后导入 A，再合并 B
    await store.importProject(pkgA)
    const conflicts = store.previewMerge(pkgB)
    expect(conflicts).toHaveLength(0)
    const auto = await store.resolveMerge(pkgB, {})
    expect(auto.length).toBeGreaterThan(0)
    expect(store.decisions.some((d) => d.targetId === c1)).toBe(true)
  })

  it('损坏包导入被拒绝', async () => {
    const store = useCollationStore()
    await store.loadSample()
    const pkg = JSON.parse(await store.exportProject())
    pkg.manuscripts[0].rawText = pkg.manuscripts[0].rawText + '損壞'
    await expect(store.importProject(JSON.stringify(pkg))).rejects.toBeInstanceOf(CorruptPackageError)
  })
})
