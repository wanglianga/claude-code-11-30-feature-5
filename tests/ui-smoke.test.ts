// @vitest-environment jsdom
// 界面冒烟：引文迁移面板能渲染四类案例与提交按钮状态（不依赖后端）
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import CitationPanel from '../src/components/CitationPanel.vue'
import { useCollationStore } from '../src/stores/collation'

describe('引文迁移面板', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('载入四类案例后渲染标题与结论标签', async () => {
    setActivePinia(createPinia())
    const wrapper = mount(CitationPanel)
    // 找到“載入四類案例”按钮并点击
    const btn = wrapper.findAll('button').find((b) => b.text().includes('載入四類案例'))
    expect(btn).toBeTruthy()
    await btn!.trigger('click')
    await nextTick()
    const html = wrapper.text()
    expect(html).toContain('重複引句')
    expect(html).toContain('改字移段')
    expect(html).toContain('二處拆分')
    expect(html).toContain('錨點刪除')
    expect(html).toContain('拆分關聯')
    expect(html).toContain('未解決')
    wrapper.unmount()
  })

  it('改稿演示使既有候选失效（修订号前进）', async () => {
    const store = useCollationStore()
    await store.loadSample()
    const target = store.multiColumns[0].id
    store.submitDecision(target, 'adopt-version', { chosenVersionId: store.referenceId!, reason: 'r' })
    const block = store.draftBlocks.find((b) => b.columnId === target)!
    const cit = store.registerCitation({
      label: '冒烟引文',
      purpose: '校記',
      blockId: block.id,
      fromCharId: block.chars[0].id,
      toCharId: block.chars[0].id,
      versionId: store.referenceId!,
      tokenStart: 0,
      tokenEnd: 0,
      anchorColumnIds: [target]
    })!
    store.computeCitationMigration(cit.id)
    const before = store.draftRevision
    const wrapper = mount(CitationPanel)
    const btn = wrapper.findAll('button').find((b) => b.text().includes('改稿演示'))
    await btn!.trigger('click')
    await nextTick()
    expect(store.draftRevision).toBeGreaterThan(before)
    expect(store.citationMigrations[cit.id].stale).toBe(true)
    expect(wrapper.text()).toContain('候選已失效')
    wrapper.unmount()
  })
})
