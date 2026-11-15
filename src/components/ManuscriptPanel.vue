<script setup lang="ts">
import { ref } from 'vue'
import { useCollationStore } from '../stores/collation'
import { normOf } from '../ui/provenance'

const store = useCollationStore()
const showAdd = ref(false)
const name = ref('')
const note = ref('')
const rawText = ref('')
const busy = ref(false)

async function addAsNew() {
  if (!name.value || !rawText.value) return
  busy.value = true
  try {
    await store.importNewManuscript(name.value, note.value, rawText.value)
    showAdd.value = false
    name.value = ''
    note.value = ''
    rawText.value = ''
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="panel">
    <h2>底本管理（本地虛構轉寫，按 Unicode 碼點保存）</h2>
    <table>
      <thead>
        <tr>
          <th>版本</th><th>版本說明</th><th>碼點數</th><th>比較字符</th><th>文件指紋 SHA-256</th><th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="ms in store.manuscripts" :key="ms.id">
          <td>
            <strong>{{ ms.name }}</strong>
            <span v-if="ms.id === store.referenceId" class="pill">參考本</span>
          </td>
          <td class="muted">{{ ms.note }}</td>
          <td>{{ ms.chars.length }}</td>
          <td>{{ normOf(ms, store.normConfig).tokens.length }}</td>
          <td class="fingerprint mono">{{ ms.fingerprint.slice(0, 24) }}…</td>
          <td>
            <button
              class="ghost"
              :disabled="ms.id === store.referenceId"
              @click="store.setReference(ms.id)"
            >設為參考本</button>
          </td>
        </tr>
      </tbody>
    </table>

    <div class="row" style="margin-top: 10px">
      <button class="primary" @click="showAdd = !showAdd">
        {{ showAdd ? '收起' : '導入新底本（觸發複核）' }}
      </button>
      <span class="muted">新底本到來會先重算對齊，再把已確認決定逐條標為「仍有效 / 待複核」，舊依據保留。</span>
    </div>

    <div v-if="showAdd" class="col" style="margin-top: 10px">
      <input v-model="name" placeholder="版本名稱，如：戊本" />
      <input v-model="note" placeholder="版本說明" />
      <textarea v-model="rawText" placeholder="貼上轉寫文本（\\f 分頁、\\n 分行、〖篇：名〗 分段）"></textarea>
      <div>
        <button class="primary" :disabled="busy" @click="addAsNew">導入並複核</button>
      </div>
    </div>

    <div v-if="store.recheckReport" style="margin-top: 12px">
      <h3>新底本複核結論</h3>
      <table>
        <thead><tr><th>決定</th><th>狀態</th><th>原因</th></tr></thead>
        <tbody>
          <tr v-for="r in store.recheckReport" :key="r.decisionId">
            <td class="mono">{{ r.decisionId.slice(-8) }}</td>
            <td>
              <span class="tag" :class="r.status === 'valid' ? 'ok' : 'warn'">
                {{ r.status === 'valid' ? '仍有效' : '待複核' }}
              </span>
            </td>
            <td>{{ r.reason }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
