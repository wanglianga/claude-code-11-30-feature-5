<script setup lang="ts">
import { computed } from 'vue'
import { useCollationStore } from '../stores/collation'
import { normOf } from '../ui/provenance'

const store = useCollationStore()

const allMoves = computed(() =>
  Object.values(store.pairs).flatMap((p) =>
    p.moves.map((m) => ({
      move: m,
      base: store.manuscriptById(m.baseVersionId),
      other: store.manuscriptById(m.otherVersionId)
    }))
  )
)

function runText(versionId: string, start: number, end: number): string {
  const ms = store.manuscriptById(versionId)
  if (!ms) return ''
  const tokens = normOf(ms, store.normConfig).tokens
  return tokens.slice(start, end + 1).map((t) => t.norm).join('')
}
</script>

<template>
  <section class="panel">
    <h2>移段候選（連續增刪片段依內容相似與上下文配對，人工確認）</h2>
    <p class="muted">
      系統只提出「可能為移段」的候選，不宣稱自動證明版本先後；確認後原位置與新位置均保留 token 區間可回查。
    </p>
    <table v-if="allMoves.length">
      <thead>
        <tr>
          <th>底本對</th><th>原位置內容（甲連續缺段）</th><th>新位置內容（乙連續增段）</th>
          <th>相似度</th><th>上下文</th><th>狀態</th><th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="({ move, base, other }) in allMoves" :key="move.id">
          <td>{{ base?.name }} → {{ other?.name }}</td>
          <td>
            「{{ runText(move.baseVersionId, move.deleteRun.start, move.deleteRun.end) }}」
            <div class="muted mono">token [{{ move.deleteRun.start }}, {{ move.deleteRun.end }}]</div>
          </td>
          <td>
            「{{ runText(move.otherVersionId, move.insertRun.start, move.insertRun.end) }}」
            <div class="muted mono">token [{{ move.insertRun.start }}, {{ move.insertRun.end }}]</div>
          </td>
          <td>{{ (move.similarity * 100).toFixed(0) }}%</td>
          <td class="muted">
            甲上下文：{{ move.context.beforeA }}｜{{ move.context.afterA }}<br />
            乙上下文：{{ move.context.beforeB }}｜{{ move.context.afterB }}
          </td>
          <td>
            <span class="tag" :class="move.status === 'confirmed' ? 'ok' : move.status === 'rejected' ? 'err' : 'warn'">
              {{ move.status === 'confirmed' ? '已確認移動' : move.status === 'rejected' ? '已否決' : '待人工確認' }}
            </span>
          </td>
          <td>
            <button class="ghost" :disabled="move.status === 'confirmed'" @click="store.confirmMove(move.id)">確認移動</button>
            <button class="ghost" :disabled="move.status === 'rejected'" @click="store.rejectMove(move.id)">否決</button>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-else class="muted">當前配對未檢出滿足閾值的連續增刪片段。</div>
  </section>
</template>
