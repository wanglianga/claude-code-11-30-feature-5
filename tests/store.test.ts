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

  it('引文：登记 → 迁移 → 改稿失效 → 重算 → 提交；导出/导入保留结论', async () => {
    const store = useCollationStore()
    await store.loadSample()
    const target = store.multiColumns[0].id
    store.submitDecision(target, 'adopt-version', { chosenVersionId: store.referenceId!, reason: '取甲本' })
    const block = store.draftBlocks.find((b) => b.columnId === target)!
    const citation = store.registerCitation({
      label: '首句引文',
      purpose: '論點支撐',
      blockId: block.id,
      fromCharId: block.chars[0].id,
      toCharId: block.chars[Math.min(3, block.chars.length - 1)].id,
      versionId: store.referenceId!,
      tokenStart: 0,
      tokenEnd: 0,
      anchorColumnIds: [target]
    })!
    expect(citation).toBeTruthy()
    expect(citation.revision).toBe(1)

    // 计算：位置未变 → 有效候选
    const result = store.computeCitationMigration(citation.id)!
    expect(result.path).toBe('ops')
    expect(store.canCommitCitation(citation.id)).toBe(true)

    // 改稿使候选失效
    store.insertManualSentence(0, '新增句')
    expect(store.canCommitCitation(citation.id)).toBe(false)
    expect(store.citationMigrations[citation.id].stale).toBe(true)
    expect(() => store.commitCitationMigration(citation.id)).toThrow(/候選已失效|失效/)

    // 重算后可提交
    const again = store.computeCitationMigration(citation.id)!
    expect(again.status).toBe('moved')
    const committed = store.commitCitationMigration(citation.id)
    expect(committed.revision).toBe(2)
    expect(committed.history).toHaveLength(1)

    // 导出/导入保留引文与迁移结论
    const text = await store.exportProject()
    const report = await store.importProject(text)
    expect(report.ok).toBe(true)
    expect(store.citations).toHaveLength(1)
    expect(store.citations[0].label).toBe('首句引文')
    // 已提交的结论保存在引用自身，导出/导入后仍可回查
    expect(store.citations[0].lastMigration?.status).toBe('moved')
  })

  it('对齐重算后校勘列 id 保持稳定，引文锚点不失联', async () => {
    const store = useCollationStore()
    await store.loadSample()
    const before = store.multiColumns.map((c) => c.id)
    await store.rerunAll()
    const after = store.multiColumns.map((c) => c.id)
    expect(after).toEqual(before)
  })

  it('内置四类案例在 store 中给出规定结论', () => {
    const store = useCollationStore()
    const rows = store.loadCitationCases()
    const byTitle = new Map(rows.map((r) => [r.title, r.result]))
    expect(byTitle.get('重複引句')?.status).toBe('unresolved')
    expect(byTitle.get('二處拆分')?.status).toBe('split')
    expect(byTitle.get('錨點刪除')?.status).toBe('unresolved')
    const textMove = byTitle.get('改字移段')!
    expect(textMove.path).toBe('ops')
    expect(textMove.status).toBe('text-changed')
  })
})
