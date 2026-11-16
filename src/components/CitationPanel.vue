<script setup lang="ts">
// 引文迁移面板：记录引文（采用稿范围 + 底本锚点 + 前后文 + 用途 + 旧修订），
// 两条路径计算迁移，展示唯一结论 / 未解决候选，并遵守失效与并发拒绝。
import { computed, ref } from 'vue'
import { useCollationStore } from '../stores/collation'
import { statusLabel, summarizeMigration } from '../core/citation'
import type { MigrationResult } from '../core/types'

const store = useCollationStore()
const message = ref('')
const showRegister = ref(false)
const label = ref('')
const purpose = ref('論點支撐')
const note = ref('')
const blockId = ref('')
const fromCharId = ref('')
const toCharId = ref('')
const versionId = ref('')
const tokenStart = ref(0)
const tokenEnd = ref(0)
const activeCase = ref<string>('')

const selectedBlock = computed(() => store.draftBlocks.find((b) => b.id === blockId.value))
const caseRows = ref<{ title: string; expected: string; citationId: string; result: MigrationResult }[]>([])
const conflict = ref('')

const rows = computed(() => store.citationCandidates)

function openRegister() {
  showRegister.value = !showRegister.value
  if (!blockId.value && store.draftBlocks.length) {
    blockId.value = store.draftBlocks[0].id
    const b = store.draftBlocks[0]
    fromCharId.value = b.chars[0]?.id ?? ''
    toCharId.value = b.chars[b.chars.length - 1]?.id ?? ''
  }
  if (!versionId.value) versionId.value = store.referenceId ?? store.manuscripts[0]?.id ?? ''
  tokenStart.value = 0
  tokenEnd.value = Math.min(3, (store.tokensOf(versionId.value).length || 1) - 1)
}

function saveCitation() {
  if (!label.value || !blockId.value) {
    message.value = '請填寫引文標題並選擇所在塊'
    return
  }
  const cit = store.registerCitation({
    label: label.value,
    purpose: purpose.value,
    note: note.value,
    blockId: blockId.value,
    fromCharId: fromCharId.value,
    toCharId: toCharId.value,
    versionId: versionId.value,
    tokenStart: tokenStart.value,
    tokenEnd: tokenEnd.value,
    anchorColumnIds: []
  })
  if (!cit) {
    message.value = '所選字符區間無效（需同一塊內，且起止順序正確）'
    return
  }
  message.value = `已記錄引文「${cit.label}」：範圍 ${cit.span.charIds.length} 字，記錄修訂 r${cit.recordedAtRevision}`
  label.value = ''
  note.value = ''
  tokenEnd.value = 0
  showRegister.value = false
}

function computeOne(citationId: string) {
  conflict.value = ''
  const r = store.computeCitationMigration(citationId)
  message.value = r ? summarizeMigration(r) : '找不到該引文'
}

function computeAll() {
  conflict.value = ''
  const out = store.computeAllCitationMigrations()
  message.value = out.length ? `已重算 ${out.length} 條引文的遷移候選` : '尚無引文可計算'
}

function commit(citationId: string) {
  conflict.value = ''
  try {
    const updated = store.commitCitationMigration(citationId)
    message.value = `已提交：「${updated.label}」→ ${statusLabel(updated.status)}，引用版本 v${updated.revision}`
  } catch (e) {
    conflict.value = e instanceof Error ? e.message : String(e)
  }
}

function loadCases() {
  caseRows.value = store.loadCitationCases().map((c) => ({
    title: c.title,
    expected: c.expected,
    citationId: c.citation.id,
    result: c.result
  }))
  activeCase.value = ''
}

function openCase(id: string) {
  activeCase.value = activeCase.value === id ? '' : id
}

/** 演示“上下文再次修改使候选失效”：在稿前插入人工句，修订前进 */
function mutateContext() {
  store.insertManualSentence(0, '校勘員新增句')
  message.value = `采用稿已改至 r${store.draftRevision}，既有迁移候选按规则标记为失效，需重新计算`
}

function pathLabel(p: MigrationResult['path']): string {
  return p === 'ops' ? '操作鏈推導' : p === 'realign' ? '局部重對齊' : '無'
}

function statusClass(s: string): string {
  if (s === 'unresolved') return 'err'
  if (s === 'deleted') return 'warn'
  if (s === 'split') return 'info'
  return 'ok'
}

function segBlockName(id: string): string {
  const i = store.draftBlocks.findIndex((b) => b.id === id)
  return i >= 0 ? `塊 #${i + 1}` : id
}
</script>

<template>
  <section class="panel">
    <h2>引文遷移（舊引文在新稿重新定位；自動結論必須唯一）</h2>
    <p class="muted">
      每條舊引用保存：原採用稿範圍（穩定字符標識）、底本 token 錨點、前後文、用途、記錄時的舊修訂。
      遷移結果只可能是「位置變化／文字變化／拆分關聯／刪除／未解決」之一，並攜帶新舊文本指紋。
      操作鏈完整時直接推導，速度快、解釋精確；錨點被刪或列被合併則中斷，改走局部重對齊。
      多個等強候選一律停在「未解決」，絕不按最高相似度替換出處。
    </p>

    <div class="row">
      <button class="primary" @click="openRegister">{{ showRegister ? '收起記錄表單' : '記錄一條引文' }}</button>
      <button class="ghost" @click="computeAll">重算全部遷移候選</button>
      <button class="ghost" @click="loadCases">載入四類案例（重複引句／改字移段／二處拆分／錨點刪除）</button>
      <button class="ghost" @click="mutateContext">改稿演示（使候選失效）</button>
      <span class="muted">現行採用稿修訂：r{{ store.draftRevision }}</span>
    </div>

    <div v-if="message" class="tag info" style="margin-top: 10px">{{ message }}</div>
    <div v-if="conflict" class="tag err" style="margin-top: 10px">提交被拒：{{ conflict }}</div>

    <div v-if="showRegister" class="col" style="margin-top: 12px; border: 1px solid var(--line); padding: 10px; border-radius: 6px">
      <div class="row">
        <input v-model="label" placeholder="引文標題，如：《論語》好學條" style="width: 240px" />
        <input v-model="purpose" placeholder="用途：論點支撐／訓詁／校記" style="width: 200px" />
        <input v-model="note" placeholder="附註（可空）" style="width: 220px" />
      </div>
      <div class="row">
        <select v-model="blockId">
          <option v-for="(b, i) in store.draftBlocks" :key="b.id" :value="b.id">
            塊 #{{ i + 1 }}｜{{ b.chars.map((c) => c.text).join('').slice(0, 16) }}
          </option>
        </select>
        <select v-if="selectedBlock" v-model="fromCharId">
          <option v-for="(c, i) in selectedBlock.chars" :key="c.id" :value="c.id">
            起 #{{ i + 1 }} {{ c.text }}
          </option>
        </select>
        <select v-if="selectedBlock" v-model="toCharId">
          <option v-for="(c, i) in selectedBlock.chars" :key="c.id" :value="c.id">
            止 #{{ i + 1 }} {{ c.text }}
          </option>
        </select>
      </div>
      <div class="row">
        <select v-model="versionId">
          <option v-for="ms in store.manuscripts" :key="ms.id" :value="ms.id">{{ ms.name }}</option>
        </select>
        <label class="muted">底本 token 起
          <input v-model.number="tokenStart" type="number" min="0" style="width: 80px" />
        </label>
        <label class="muted">止
          <input v-model.number="tokenEnd" type="number" min="0" style="width: 80px" />
        </label>
        <span class="muted">錨點文字：{{ store.tokensOf(versionId).slice(tokenStart, tokenEnd + 1).map((t) => t.norm).join('') || '—' }}</span>
        <button class="primary" @click="saveCitation">保存引文</button>
      </div>
    </div>

    <h3>現有引文與遷移候選</h3>
    <table v-if="rows.length">
      <thead>
        <tr>
          <th>引文</th><th>用途</th><th>舊範圍／指紋</th><th>底本錨點</th>
          <th>遷移結論</th><th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.citation.id">
          <td>
            <strong>{{ row.citation.label }}</strong>
            <div class="muted">{{ row.citation.note || '—' }}｜引用 v{{ row.citation.revision }}｜記錄 r{{ row.citation.recordedAtRevision }}</div>
          </td>
          <td>{{ row.citation.purpose }}</td>
          <td>
            「{{ row.citation.span.text }}」
            <div class="muted mono">{{ row.citation.textFingerprint }}</div>
          </td>
          <td class="muted mono">
            <div v-for="a in row.citation.baseAnchors" :key="a.versionId + a.tokenStart">
              {{ store.manuscriptById(a.versionId)?.name ?? a.versionId }} [{{ a.tokenStart }}, {{ a.tokenEnd }}]「{{ a.text }}」
            </div>
          </td>
          <td>
            <template v-if="row.result">
              <span class="tag" :class="statusClass(row.result.status)">
                {{ statusLabel(row.result.status) }}
              </span>
              <span class="tag" :class="row.applied ? 'ok' : row.current ? 'ok' : 'err'" style="margin-left: 4px">
                {{ row.applied ? '已提交' : row.current ? '候選有效' : '候選已失效' }}
              </span>
              <div v-if="row.result.stale" class="tag warn" style="margin-left: 4px">已改稿，需重算</div>
              <div class="muted">{{ pathLabel(row.result.path) }}</div>
              <div class="muted mono">{{ row.result.oldFingerprint }} → {{ row.result.newFingerprint }}</div>
              <ul class="tight">
                <li v-for="(e, i) in row.result.explanation" :key="i" class="muted">{{ e }}</li>
              </ul>
              <div v-if="row.result.segments.length">
                <div v-for="(s, i) in row.result.segments" :key="i" class="muted">
                  片段 {{ i + 1 }}：{{ segBlockName(s.blockId) }} [{{ s.start }}, {{ s.end }}]「{{ s.text }}」
                  <span class="mono">{{ s.fingerprint }}</span>
                  <span v-if="s.baseRange">｜錨點 [{{ s.baseRange[0] }}, {{ s.baseRange[1] }}]</span>
                </div>
              </div>
              <div v-if="row.result.candidates.length" class="muted">
                候選（不自動擇優）：
                <div v-for="(c, i) in row.result.candidates" :key="i" class="mono">
                  {{ segBlockName(c.blockId) }} [{{ c.start }}, {{ c.end }}]「{{ c.text }}」{{ (c.similarity * 100).toFixed(1) }}%
                </div>
              </div>
            </template>
            <span v-else class="muted">尚未計算</span>
          </td>
          <td>
            <button class="ghost" @click="computeOne(row.citation.id)">計算遷移</button>
            <button
              class="primary"
              :disabled="!store.canCommitCitation(row.citation.id)"
              @click="commit(row.citation.id)"
            >提交結論</button>
            <button class="ghost" @click="store.removeCitation(row.citation.id)">移除引文</button>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-else class="muted">尚無引文。可先「記錄一條引文」，或點「載入四類案例」查看內置演示。</div>

    <template v-if="caseRows.length">
      <h3>四類案例（全部由輸入計算，非預排結論）</h3>
      <table>
        <thead>
          <tr><th>案例</th><th>預期規則</th><th>計算結論</th><th>差異說明</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="c in caseRows" :key="c.citationId">
            <td><strong>{{ c.title }}</strong></td>
            <td class="muted">{{ c.expected }}</td>
            <td>
              <span class="tag" :class="statusClass(c.result.status)">{{ statusLabel(c.result.status) }}</span>
              <span class="tag info" style="margin-left: 4px">{{ pathLabel(c.result.path) }}</span>
              <div class="muted mono">{{ c.result.oldFingerprint }} → {{ c.result.newFingerprint }}</div>
            </td>
            <td>
              <button class="ghost" @click="openCase(c.citationId)">
                {{ activeCase === c.citationId ? '收起' : '查看' }}
              </button>
            </td>
            <td>
              <ul v-if="activeCase === c.citationId" class="tight">
                <li v-for="(e, i) in c.result.explanation" :key="i" class="muted">{{ e }}</li>
                <li v-for="(s, i) in c.result.segments" :key="'s' + i" class="mono">
                  片段 {{ i + 1 }}「{{ s.text }}」{{ s.fingerprint }}
                </li>
                <li v-for="(cd, i) in c.result.candidates" :key="'c' + i" class="mono">
                  候選「{{ cd.text }}」{{ (cd.similarity * 100).toFixed(1) }}%
                </li>
              </ul>
            </td>
          </tr>
        </tbody>
      </table>
    </template>
  </section>
</template>
