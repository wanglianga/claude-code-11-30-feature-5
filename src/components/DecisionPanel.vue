<script setup lang="ts">
import { computed, ref } from 'vue'
import { useCollationStore } from '../stores/collation'
import { normOf } from '../ui/provenance'
import type { DecisionKind, MultiColumn } from '../core/types'

const store = useCollationStore()
const reason = ref('')
const synthesis = ref('')
const kind = ref<DecisionKind>('adopt-version')
const chosenVersion = ref<string>('')
const annotationText = ref('')
const selectedChars = ref<string[]>([])
const manualText = ref('')

const versionIds = computed(() => store.manuscripts.map((m) => m.id))

function cellText(col: MultiColumn, versionId: string): string {
  const t = col.cells[versionId]
  if (t === null || t === undefined) return '—'
  const ms = store.manuscriptById(versionId)
  if (!ms) return '—'
  return normOf(ms, store.normConfig).tokens[t]?.norm ?? '·'
}

function cellTitle(col: MultiColumn, versionId: string): string {
  const t = col.cells[versionId]
  if (t === null || t === undefined) return '該本無此列（缺字或移段）'
  const ms = store.manuscriptById(versionId)
  if (!ms) return ''
  const token = normOf(ms, store.normConfig).tokens[t]
  return token ? `原文「${token.orig}」 碼點[${token.srcStart},${token.srcEnd})` : ''
}

const decisionOf = computed(() => new Map(store.decisions.map((d) => [d.targetId, d])))

function decide(col: MultiColumn) {
  if (!reason.value) {
    alert('請填寫取捨理由（每項決定都會留存理由與出處）')
    return
  }
  store.submitDecision(col.id, kind.value, {
    chosenVersionId: kind.value === 'adopt-version' ? chosenVersion.value || versionIds.value[0] : undefined,
    synthesisText: kind.value === 'synthesis' ? synthesis.value : undefined,
    reason: reason.value
  })
  reason.value = ''
  synthesis.value = ''
}

function decidePassage(passageId: string) {
  if (!reason.value) {
    alert('請填寫取捨理由')
    return
  }
  store.submitDecision(passageId, kind.value, {
    chosenVersionId: kind.value === 'adopt-version' ? chosenVersion.value || versionIds.value[0] : undefined,
    synthesisText: kind.value === 'synthesis' ? synthesis.value : undefined,
    reason: reason.value
  })
  reason.value = ''
}

function toggleChar(id: string) {
  const i = selectedChars.value.indexOf(id)
  if (i >= 0) selectedChars.value.splice(i, 1)
  else selectedChars.value.push(id)
}

function saveAnnotation() {
  if (!selectedChars.value.length || !annotationText.value) return
  store.addAnnotation([...selectedChars.value], annotationText.value)
  annotationText.value = ''
  selectedChars.value = []
}

function relocateTargets(annId: string) {
  // 重掛到當前選中的字符
  if (!selectedChars.value.length) return
  store.relocateAnnotation(annId, [...selectedChars.value])
  selectedChars.value = []
}

/** 以所選首字為界拆塊：前半沿用原塊，後半成為關聯新塊，字符 id 全部保留 */
function splitAtSelection(block: { id: string; chars: { id: string }[] }) {
  const at = block.chars.findIndex((c) => c.id === selectedChars.value[0])
  if (at <= 0) return
  store.splitDraftBlock(block.id, at)
  selectedChars.value = []
}
</script>

<template>
  <section class="panel">
    <h2>參考本對齊列與取捨決定（三本以上先建參考列，新增段落不消失）</h2>
    <div class="grid-wrap">
      <table>
        <thead>
          <tr>
            <th>列</th>
            <th v-for="ms in store.manuscripts" :key="ms.id">{{ ms.name }}</th>
            <th>決定狀態</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="col in store.multiColumns" :key="col.id">
            <td class="muted mono">
              {{ col.refToken === null ? '新增段' : `#${col.refToken}` }}
            </td>
            <td
              v-for="ms in store.manuscripts"
              :key="ms.id"
              :class="cellText(col, ms.id) === '—' ? 'absent' : ''"
              :title="cellTitle(col, ms.id)"
            >
              {{ cellText(col, ms.id) }}
            </td>
            <td>
              <template v-if="decisionOf.get(col.id)">
                <span class="tag" :class="decisionOf.get(col.id)?.validity === 'review' ? 'warn' : 'ok'">
                  {{ decisionOf.get(col.id)?.kind === 'adopt-version'
                    ? `採 ${store.manuscriptById(decisionOf.get(col.id)!.chosenVersionId ?? '')?.name ?? ''}`
                    : decisionOf.get(col.id)?.kind === 'synthesis'
                      ? '合成'
                      : '暫不取舍' }}
                  {{ decisionOf.get(col.id)?.validity === 'review' ? '（待複核）' : '' }}
                </span>
                <div class="muted">{{ decisionOf.get(col.id)?.reason }}</div>
              </template>
              <span v-else class="muted">僅機器建議，未入采用稿</span>
            </td>
            <td>
              <select v-model="kind">
                <option value="adopt-version">採用某本</option>
                <option value="synthesis">合成文字</option>
                <option value="defer">暫不取舍</option>
              </select>
              <select v-if="kind === 'adopt-version'" v-model="chosenVersion">
                <option v-for="ms in store.manuscripts" :key="ms.id" :value="ms.id">{{ ms.name }}</option>
              </select>
              <input v-if="kind === 'synthesis'" v-model="synthesis" placeholder="合成文字" />
              <input v-model="reason" placeholder="理由（必填）" style="width: 150px" />
              <button class="primary" @click="decide(col)">提交決定</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <h3>參考本之外的新增段落（獨立保留，可單獨取捨）</h3>
    <table v-if="store.insertedPassages.length">
      <thead><tr><th>所屬版本</th><th>token 區間</th><th>操作</th></tr></thead>
      <tbody>
        <tr v-for="p in store.insertedPassages" :key="p.id">
          <td>{{ store.manuscriptById(p.ownerVersionId)?.name }}</td>
          <td class="mono">[{{ p.tokenRange[0] }}, {{ p.tokenRange[1] }}]；跨本歸組 {{ p.groupedWith.length }} 處</td>
          <td>
            <input v-model="reason" placeholder="理由" style="width: 150px" />
            <button class="primary" @click="decidePassage(p.id)">對新增段提交決定</button>
          </td>
        </tr>
      </tbody>
    </table>

    <h2 style="margin-top: 18px">采用稿編輯（操作記錄維護原文錨點）</h2>
    <div class="row">
      <input v-model="manualText" placeholder="在稿前新增一句（人工句，manual 錨點）" style="width: 300px" />
      <button class="ghost" @click="store.insertManualSentence(0, manualText); manualText = ''">稿前插句</button>
    </div>
    <table style="margin-top: 10px">
      <thead><tr><th>塊</th><th>文字（點選字符用於批註）</th><th>錨點</th><th></th></tr></thead>
      <tbody>
        <tr v-for="(block, bi) in store.draftBlocks" :key="block.id">
          <td class="muted">#{{ bi }}</td>
          <td class="diff-text">
            <span
              v-for="c in block.chars"
              :key="c.id"
              class="ch"
              :class="{ relocate: selectedChars.includes(c.id) }"
              :title="c.anchor.type === 'column' ? `出處列 ${c.anchor.columnId}` : '人工增补字'"
              @click="toggleChar(c.id)"
            >{{ c.text }}</span>
          </td>
          <td class="muted mono" style="max-width: 220px">
            {{ block.manual ? 'manual' : block.columnId ?? '—' }}
          </td>
          <td>
            <button class="ghost" @click="store.moveDraftBlock(block.id, Math.max(0, bi - 1))">上移</button>
            <button
              class="ghost"
              :disabled="selectedChars.length === 0 || !block.chars.some((c) => c.id === selectedChars[0])"
              :title="'以所選首字為界，將本塊拆為關聯兩段'"
              @click="splitAtSelection(block)"
            >拆塊</button>
            <button class="ghost" @click="store.removeDraftBlock(block.id)">刪塊</button>
          </td>
        </tr>
      </tbody>
    </table>

    <h3>批註（按穩定字符標識掛靠；刪字後轉待重定位，不自動掛旁句）</h3>
    <div class="row">
      <input v-model="annotationText" placeholder="批註內容" style="width: 280px" />
      <button class="primary" :disabled="!selectedChars.length" @click="saveAnnotation">
        掛到 {{ selectedChars.length }} 個所選字符
      </button>
    </div>
    <table style="margin-top: 8px">
      <thead><tr><th>狀態</th><th>內容</th><th>失依字符</th><th>重定位</th></tr></thead>
      <tbody>
        <tr v-for="ann in store.annotations" :key="ann.id">
          <td>
            <span class="tag" :class="ann.status === 'active' ? 'ok' : 'err'">
              {{ ann.status === 'active' ? '有效' : '待重定位' }}
            </span>
          </td>
          <td>{{ ann.content }}</td>
          <td class="mono">{{ ann.orphanedFrom.join(', ') || '—' }}</td>
          <td>
            <button
              v-if="ann.status === 'pending-relocation'"
              class="ghost"
              :disabled="!selectedChars.length"
              @click="relocateTargets(ann.id)"
            >重掛到所選字符</button>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
