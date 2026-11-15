<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useCollationStore } from '../stores/collation'
import { normOf, provenance, type ProvenanceInfo } from '../ui/provenance'
import type { AlignColumn, AmbiguityGroup } from '../core/types'

const store = useCollationStore()
const selectedOther = ref<string>('')
const popup = ref<{ x: number; y: number; info: ProvenanceInfo } | null>(null)
const activeGroup = ref<AmbiguityGroup | null>(null)
const anchorMode = ref(false)
const pickedA = ref<number | null>(null)

const refId = computed(() => store.referenceId ?? '')
const refMs = computed(() => store.manuscriptById(refId.value))
const otherMs = computed(() =>
  selectedOther.value ? store.manuscriptById(selectedOther.value) : undefined
)

// 进入页面或底本列表变化后，默认选中第一个非参考本
watch(
  () => store.manuscripts.map((m) => m.id).join(','),
  () => {
    if (!selectedOther.value) {
      const first = store.manuscripts.find((m) => m.id !== refId.value)
      if (first) selectedOther.value = first.id
    }
  },
  { immediate: true }
)

const pairKey = computed(() =>
  refMs.value && otherMs.value ? store.pairKey(refMs.value.id, otherMs.value.id) : null
)
const pair = computed(() => (pairKey.value ? store.pairs[pairKey.value] : undefined))

const columns = computed<AlignColumn[]>(() =>
  pair.value?.alignment?.segments.flatMap((s) => s.columns) ?? []
)
const groups = computed(() =>
  pair.value?.alignment?.segments.flatMap((s) => s.ambiguousGroups) ?? []
)

const groupOfColumn = computed(() => {
  const m = new Map<string, AmbiguityGroup>()
  for (const g of groups.value) {
    for (const col of columns.value) {
      const inA = col.a !== null && col.a >= g.aRange[0] && col.a <= g.aRange[1]
      const inB = col.b !== null && col.b >= g.bRange[0] && col.b <= g.bRange[1]
      if (inA || inB) m.set(col.id, g)
    }
  }
  return m
})

function chooseOther(id: string) {
  selectedOther.value = id
}

function showProvenance(versionId: string, tIndex: number | null, ev: MouseEvent) {
  if (tIndex === null) {
    popup.value = null
    return
  }
  const ms = store.manuscriptById(versionId)
  if (!ms) return
  const n = normOf(ms, store.normConfig)
  const token = n.tokens[tIndex]
  if (!token) return
  popup.value = { x: ev.clientX + 12, y: ev.clientY + 12, info: provenance(ms, token) }
}

function hideProvenance() {
  popup.value = null
}

function cellClass(col: AlignColumn): string {
  if (groupOfColumn.value.has(col.id)) return 'amb'
  if (col.kind === 'match') return 'match'
  if (col.kind === 'sub') return 'sub'
  if (col.kind === 'gapA' || col.kind === 'gapB') return 'gap'
  return ''
}

function charAt(versionId: string, tIndex: number | null): string {
  if (tIndex === null) return '—'
  const ms = store.manuscriptById(versionId)
  if (!ms) return '—'
  return normOf(ms, store.normConfig).tokens[tIndex]?.norm ?? '·'
}

function openGroup(g: AmbiguityGroup) {
  activeGroup.value = g
}

async function chooseAlternative(g: AmbiguityGroup, index: number) {
  if (!pairKey.value) return
  store.confirmAmbiguity(pairKey.value, g.id, index, '人工確認同分方案')
  activeGroup.value = null
}

function cellClick(side: 'A' | 'B', t: number | null) {
  if (!anchorMode.value || t === null || !pairKey.value || !otherMs.value || !refMs.value) return
  if (side === 'A') {
    pickedA.value = t
  } else if (pickedA.value !== null) {
    store.addAnchor(refMs.value.id, otherMs.value.id, pickedA.value, t, '人工錨點')
    pickedA.value = null
  }
}

const seamWarnings = computed(() =>
  pair.value?.alignment?.segments.filter((s) => !s.seamVerified) ?? []
)
</script>

<template>
  <section class="panel">
    <h2>多版本校勘（按篇章與人工錨點分段，段內最小代價動態規劃對齊）</h2>
    <div class="row">
      <span>對照底本：</span>
      <button
        v-for="ms in store.manuscripts.filter((m) => m.id !== refId)"
        :key="ms.id"
        class="ghost"
        :class="{ primary: ms.id === selectedOther }"
        @click="chooseOther(ms.id)"
      >
        {{ ms.name }}
      </button>
      <label style="margin-left: 12px">
        <input type="checkbox" v-model="anchorMode" /> 錨點模式（先點甲字再點乙字）
      </label>
    </div>

    <div v-if="pair?.status === 'running'" style="margin: 10px 0">
      <div class="progress-bar"><div style="width: 60%"></div></div>
      <span class="muted">WebWorker 分塊計算中… {{ store.progress ? `${store.progress.done}/${store.progress.total}` : '' }}</span>
    </div>
    <div v-else-if="pair?.status === 'canceled'" class="tag warn">舊計算已取消，未覆蓋當前選擇</div>
    <div v-else-if="pair?.status === 'error'" class="tag err">計算出錯：{{ pair.error }}</div>
    <div v-if="seamWarnings.length" class="tag err" style="margin-left: 8px">
      有 {{ seamWarnings.length }} 個分塊接縫待核驗
    </div>

    <div v-if="otherMs && refMs" class="grid-wrap" style="margin-top: 12px" @mouseleave="hideProvenance">
      <div class="align-grid">
        <div class="align-row">
          <div
            v-for="col in columns"
            :key="col.id"
            class="cell"
            :class="cellClass(col)"
            @mouseenter="showProvenance(refMs.id, col.a, $event)"
            @click="cellClick('A', col.a)"
          >
            {{ charAt(refMs.id, col.a) }}
          </div>
        </div>
        <div class="align-row">
          <div
            v-for="col in columns"
            :key="col.id + '-b'"
            class="cell"
            :class="cellClass(col)"
            @mouseenter="showProvenance(otherMs.id, col.b, $event)"
            @click="cellClick('B', col.b)"
          >
            {{ charAt(otherMs.id, col.b) }}
          </div>
        </div>
      </div>
    </div>

    <div class="row" style="margin-top: 10px">
      <span class="muted">綠＝同文　橙＝異字（替換）　紅＝缺字/增字　紫＝同分歧義待確認　滑過字符查看原文頁行坐標與碼點區間</span>
    </div>

    <h3 v-if="groups.length">同分歧義（重複短句造成，逐項人工確認，不固定取左側）</h3>
    <div v-for="g in groups" :key="g.id" class="row" style="margin: 4px 0">
      <span class="tag info">歧義區 甲[{{ g.aRange }}] 乙[{{ g.bRange }}] {{ g.alternatives.length }} 個同分方案</span>
      <button class="ghost" @click="openGroup(g)">
        {{ g.resolved ? `已確認方案 ${g.resolved.chosenIndex}（可重選）` : '查看可選範圍' }}
      </button>
    </div>

    <h3 v-if="pair?.anchors.length">人工錨點</h3>
    <ul class="tight" v-if="pair?.anchors.length">
      <li v-for="a in pair.anchors" :key="a.id">
        甲 token {{ a.a }} ↔ 乙 token {{ a.b }}
        <button class="ghost" @click="refMs && otherMs && store.removeAnchor(refMs.id, otherMs.id, a.id)">移除</button>
      </li>
    </ul>

    <div v-if="popup" class="provenance" :style="{ left: popup.x + 'px', top: popup.y + 'px' }">
      <div><strong>{{ popup.info.versionName }}</strong> 原文出處</div>
      <div>原文碼點區間：<span class="mono">[{{ popup.info.cpRange[0] }}, {{ popup.info.cpRange[1] }})</span></div>
      <div>起：{{ popup.info.startLabel }}</div>
      <div>止：{{ popup.info.endLabel }}</div>
      <div>原文：「{{ popup.info.orig }}」→ 比較形：「{{ popup.info.norm }}」</div>
      <div v-if="popup.info.variantApplied" class="tag info">已應用異體對照（原文保留可反查）</div>
      <div v-if="popup.info.ignoredPunct" class="tag warn">區間內忽略標點 {{ popup.info.ignoredPunct }} 個（未刪除）</div>
    </div>

    <div v-if="activeGroup" class="dialog-mask" @click.self="activeGroup = null">
      <div class="dialog">
        <h2>同分歧義確認</h2>
        <p class="muted">下列方案總代價相同，機器不替您決定；確認後作為對齊修訂參與後續重算。</p>
        <table>
          <thead><tr><th>方案</th><th>說明</th><th>配對序列</th><th></th></tr></thead>
          <tbody>
            <tr v-for="alt in activeGroup.alternatives" :key="alt.index">
              <td>#{{ alt.index }}</td>
              <td>{{ alt.label }}</td>
              <td class="mono">
                <span v-for="(op, i) in alt.ops" :key="i">
                  <template v-if="op.kind === 'match' || op.kind === 'sub'">{{ charAt(refMs!.id, op.a) }}={{ charAt(otherMs!.id, op.b) }} </template>
                  <template v-else-if="op.kind === 'gapB'">{{ charAt(refMs!.id, op.a) }}=∅ </template>
                  <template v-else>∅={{ charAt(otherMs!.id, op.b) }} </template>
                </span>
              </td>
              <td><button class="primary" @click="chooseAlternative(activeGroup, alt.index)">採用此方案</button></td>
            </tr>
          </tbody>
        </table>
        <div style="margin-top: 10px"><button class="ghost" @click="activeGroup = null">關閉</button></div>
      </div>
    </div>
  </section>
</template>
