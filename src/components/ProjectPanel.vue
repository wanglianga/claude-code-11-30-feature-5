<script setup lang="ts">
import { ref } from 'vue'
import { useCollationStore } from '../stores/collation'
import { downloadText, readTextFile } from '../ui/files'
import { exportAdoptedMarkdown } from '../core/exportAdopted'
import type { MergeConflict } from '../core/merge'

const store = useCollationStore()
const importInput = ref<HTMLInputElement | null>(null)
const mergeInput = ref<HTMLInputElement | null>(null)
const conflicts = ref<MergeConflict[]>([])
const mergeText = ref('')
const autoMerged = ref<string[]>([])
const message = ref('')

async function doExport() {
  const text = await store.exportProject()
  downloadText(`guji-project-${Date.now()}.json`, text)
}

async function doExportAdopted() {
  const md = exportAdoptedMarkdown(
    store.projectName,
    store.manuscripts,
    store.normConfig,
    store.draftBlocks,
    store.decisions,
    store.citations
  )
  downloadText(`adopted-with-provenance-${Date.now()}.md`, md, 'text/markdown')
}

async function onImport(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0]
  if (!file) return
  const text = await readTextFile(file)
  try {
    const report = await store.importProject(text)
    message.value = report.ok
      ? `導入成功，一致性核驗通過（${report.warnings.length} 條提示）`
      : `導入完成但存在不一致：${report.errors.join('；')}`
  } catch (e) {
    message.value = `導入被拒（損壞分塊不假裝恢復）：${e instanceof Error ? e.message : String(e)}`
  } finally {
    ;(ev.target as HTMLInputElement).value = ''
  }
}

async function onPickMerge(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0]
  if (!file) return
  mergeText.value = await readTextFile(file)
  try {
    conflicts.value = store.previewMerge(mergeText.value)
  } catch (e) {
    message.value = e instanceof Error ? e.message : String(e)
    conflicts.value = []
    mergeText.value = ''
  }
  autoMerged.value = []
  ;(ev.target as HTMLInputElement).value = ''
}

async function doMerge() {
  const unresolved = conflicts.value.filter((c) => !c.resolution)
  if (unresolved.length) {
    message.value = `還有 ${unresolved.length} 項衝突未逐項選擇，不能整份覆蓋合入`
    return
  }
  const resolutions: Record<string, 'base' | 'incoming'> = {}
  for (const c of conflicts.value) if (c.resolution) resolutions[c.id] = c.resolution
  autoMerged.value = await store.resolveMerge(mergeText.value, resolutions)
  message.value = `合併完成：自動合入 ${autoMerged.value.length} 項不相交修改，衝突均已逐項選擇`
  conflicts.value = []
  mergeText.value = ''
}

function verify() {
  const r = store.verifyNow()
  message.value = r.ok
    ? `核驗通過：正文、對齊、批註互相一致（${r.warnings.length} 條提示）`
    : `核驗發現問題：${r.errors.join('；')}`
}

/** 损坏演示：导出后故意改写一个底本码点并破坏整体校验和 */
async function exportTamperedDemo() {
  const pkg = JSON.parse(await store.exportProject())
  const target = pkg.manuscripts[0]
  const cps = Array.from(target.rawText)
  if (cps.length > 4) cps[4] = cps[4] === 'X' ? 'Y' : 'X'
  target.rawText = cps.join('')
  // 不重算任何 checksums，模拟传输/存储损坏
  downloadText(`guji-tampered-demo-${Date.now()}.json`, JSON.stringify(pkg, null, 2))
  message.value = '已下載被篡改的示例包；重新導入它應被拒絕。'
}
</script>

<template>
  <section class="panel">
    <h2>項目包與合并（純本地文件，無服務端）</h2>
    <div class="row">
      <button class="primary" @click="doExport">導出可重新導入的項目包（.json）</button>
      <button class="primary" @click="doExportAdopted">導出帶出處的采用稿（.md）</button>
      <button class="ghost" @click="importInput?.click()">導入項目包</button>
      <input ref="importInput" type="file" accept="application/json" hidden @change="onImport" />
      <button class="ghost" @click="mergeInput?.click()">選擇第二份包做合并</button>
      <input ref="mergeInput" type="file" accept="application/json" hidden @change="onPickMerge" />
      <button class="ghost" @click="verify">立即核驗一致性</button>
      <button class="ghost" @click="exportTamperedDemo">下載損壞示例包</button>
    </div>

    <p v-if="message" class="tag info" style="margin-top: 10px">{{ message }}</p>

    <div v-if="store.lastReport" style="margin-top: 10px">
      <h3>最近一次核驗報告（{{ store.lastReport.checkedAt }}）</h3>
      <p>
        <span class="tag" :class="store.lastReport.ok ? 'ok' : 'err'">
          {{ store.lastReport.ok ? '一致' : '不一致' }}
        </span>
      </p>
      <ul class="tight" v-if="store.lastReport.errors.length">
        <li v-for="(e, i) in store.lastReport.errors" :key="'e' + i" class="tag err">{{ e }}</li>
      </ul>
      <ul class="tight" v-if="store.lastReport.warnings.length">
        <li v-for="(w, i) in store.lastReport.warnings" :key="'w' + i" class="tag warn">{{ w }}</li>
      </ul>
    </div>

    <div v-if="conflicts.length" class="dialog-mask">
      <div class="dialog">
        <h2>合并衝突逐項選擇</h2>
        <p class="muted">不相交修改會自動合入；以下衝突必須逐項選擇，不允許後導入整份覆蓋。</p>
        <table>
          <thead><tr><th>類型</th><th>說明</th><th>當前工程</th><th>導入包</th><th>取捨</th></tr></thead>
          <tbody>
            <tr v-for="c in conflicts" :key="c.id">
              <td>
                <span class="tag warn">
                  {{ c.kind === 'opposite-decision' ? '相反取舍' : c.kind === 'overlapping-move' ? '移段重疊' : c.kind === 'citation-diverged' ? '引文分歧' : '同塊改動' }}
                </span>
              </td>
              <td>{{ c.description }}</td>
              <td>{{ c.baseSummary }}</td>
              <td>{{ c.incomingSummary }}</td>
              <td>
                <label style="margin-right: 8px">
                  <input type="radio" :name="c.id" value="base" @change="c.resolution = 'base'" /> 保留當前
                </label>
                <label>
                  <input type="radio" :name="c.id" value="incoming" @change="c.resolution = 'incoming'" /> 采用導入
                </label>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="row" style="margin-top: 12px">
          <button class="primary" @click="doMerge">按逐項選擇執行合并</button>
        </div>
      </div>
    </div>

    <ul v-if="autoMerged.length" class="tight" style="margin-top: 10px">
      <li v-for="(m, i) in autoMerged" :key="i" class="tag ok">{{ m }}</li>
    </ul>
  </section>
</template>
