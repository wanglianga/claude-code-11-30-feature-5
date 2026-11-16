<script setup lang="ts">
import { reactive } from 'vue'
import { useCollationStore } from '../stores/collation'

const store = useCollationStore()
const form = reactive({
  ignorePunctuation: store.normConfig.ignorePunctuation,
  insert: store.normConfig.costs.insert,
  delete: store.normConfig.costs.delete,
  substitute: store.normConfig.costs.substitute,
  moveThreshold: store.normConfig.moveThreshold,
  chunkSize: store.normConfig.chunkSize,
  overlapSize: store.normConfig.overlapSize,
  variantKey: '',
  variantValue: ''
})

async function apply() {
  store.updateConfig({
    ignorePunctuation: form.ignorePunctuation,
    costs: { insert: form.insert, delete: form.delete, substitute: form.substitute },
    moveThreshold: form.moveThreshold,
    chunkSize: form.chunkSize,
    overlapSize: form.overlapSize
  })
  await store.rerunAll()
}

function addVariant() {
  if (!form.variantKey || !form.variantValue) return
  const map = { ...store.normConfig.variantMap, [form.variantKey]: form.variantValue }
  store.updateConfig({ variantMap: map })
  form.variantKey = ''
  form.variantValue = ''
  void store.rerunAll()
}

function removeVariant(key: string) {
  const map = { ...store.normConfig.variantMap }
  delete map[key]
  store.updateConfig({ variantMap: map })
  void store.rerunAll()
}
</script>

<template>
  <section class="panel">
    <h2>規範化與對齊配置（可隨時調整，原文碼點永不改寫）</h2>
    <div class="row">
      <label>
        <input type="checkbox" v-model="form.ignorePunctuation" @change="apply" />
        忽略標點（保留原碼點，僅比較時跳過）
      </label>
    </div>
    <div class="row" style="margin-top: 8px">
      <label>插入代價 <input type="number" min="1" v-model.number="form.insert" style="width: 70px" /></label>
      <label>刪除代價 <input type="number" min="1" v-model.number="form.delete" style="width: 70px" /></label>
      <label>替換代價 <input type="number" min="1" v-model.number="form.substitute" style="width: 70px" /></label>
      <label>移段閾值 <input type="number" min="0" max="1" step="0.01" v-model.number="form.moveThreshold" style="width: 70px" /></label>
      <label>分塊大小 <input type="number" min="8" v-model.number="form.chunkSize" style="width: 80px" /></label>
      <label>重疊區 <input type="number" min="2" v-model.number="form.overlapSize" style="width: 70px" /></label>
      <button class="primary" @click="apply">應用並重算</button>
    </div>

    <h3>異體對照表（支援多字對一字，反查區間不丟失）</h3>
    <div class="row">
      <span v-for="(v, k) in store.normConfig.variantMap" :key="k" class="pill">
        {{ k }} → {{ v }}
        <button class="ghost" style="padding: 0 6px; margin-left: 4px" @click="removeVariant(k as string)">×</button>
      </span>
    </div>
    <div class="row" style="margin-top: 8px">
      <input v-model="form.variantKey" placeholder="原寫法（可多字）" style="width: 140px" />
      <span>→</span>
      <input v-model="form.variantValue" placeholder="規範字形" style="width: 120px" />
      <button class="ghost" @click="addVariant">新增對照</button>
    </div>
    <p class="muted" style="margin-top: 6px">
      關閉異體對照即可看到「旹/時」「无/無」這類本需研究的寫法差異；打開後差異收斂，但每個比較字符仍帶原文區間。
    </p>
  </section>
</template>
