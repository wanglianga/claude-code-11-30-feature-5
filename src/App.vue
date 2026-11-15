<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useCollationStore } from './stores/collation'
import ManuscriptPanel from './components/ManuscriptPanel.vue'
import ConfigPanel from './components/ConfigPanel.vue'
import CollationView from './components/CollationView.vue'
import MovePanel from './components/MovePanel.vue'
import DecisionPanel from './components/DecisionPanel.vue'
import ProjectPanel from './components/ProjectPanel.vue'

const store = useCollationStore()
const tab = ref<'manuscripts' | 'config' | 'collation' | 'moves' | 'draft' | 'project'>('collation')
const booting = ref(true)
const bootError = ref('')

onMounted(async () => {
  try {
    const restored = await store.restoreFromStorage()
    if (!restored) await store.loadSample()
  } catch (e) {
    bootError.value = e instanceof Error ? e.message : String(e)
  } finally {
    booting.value = false
  }
})
</script>

<template>
  <header class="app-header">
    <h1>古籍多版本校勘工作台</h1>
    <span class="muted">Vue3 + TypeScript + Pinia · 純瀏覽器本地運行 · 不接 OCR / 外部模型 / 服務端</span>
    <nav class="tabs" style="margin-left: auto">
      <button :class="{ active: tab === 'manuscripts' }" @click="tab = 'manuscripts'">底本</button>
      <button :class="{ active: tab === 'config' }" @click="tab = 'config'">規範化配置</button>
      <button :class="{ active: tab === 'collation' }" @click="tab = 'collation'">校勘對齊</button>
      <button :class="{ active: tab === 'moves' }" @click="tab = 'moves'">移段</button>
      <button :class="{ active: tab === 'draft' }" @click="tab = 'draft'">取捨與采用稿</button>
      <button :class="{ active: tab === 'project' }" @click="tab = 'project'">項目包</button>
    </nav>
  </header>

  <main>
    <div v-if="booting" class="panel muted">正在載入示例工程並執行 WebWorker 對齊…</div>
    <div v-else-if="bootError" class="panel">
      <span class="tag err">初始化失敗：{{ bootError }}</span>
      <button class="primary" style="margin-left: 10px" @click="store.loadSample()">重載示例</button>
    </div>
    <template v-else>
      <ManuscriptPanel v-if="tab === 'manuscripts'" />
      <ConfigPanel v-else-if="tab === 'config'" />
      <CollationView v-else-if="tab === 'collation'" />
      <MovePanel v-else-if="tab === 'moves'" />
      <DecisionPanel v-else-if="tab === 'draft'" />
      <ProjectPanel v-else-if="tab === 'project'" />
    </template>
  </main>
</template>
