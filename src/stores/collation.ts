// 全局校勘状态（Pinia）。
// 关键纪律：
//  - 对齐请求单调递增，切换底本/取消后旧回包不得覆盖新选择；
//  - 未经确认的机器建议不生成 Decision，不进入采用稿；
//  - 采用稿编辑全部走 draft.ts 的操作记录，批注按稳定字符 id 挂靠。
import { defineStore } from 'pinia'
import { toRaw } from 'vue'
import type {
  AlignAnchor,
  AlignmentRevision,
  Annotation,
  CheckReport,
  Decision,
  DecisionKind,
  DraftBlock,
  Manuscript,
  MoveCandidate,
  MultiColumn,
  NormConfig,
  PairAlignment,
  ProjectPackage,
  InsertedPassage,
  CharacterRef
} from '../core/types'
import { defaultNormConfig, normalize } from '../core/normalize'
import { buildManuscript, computePairAlignment } from '../core/pipeline'
import { buildMultiColumns } from '../core/align/align'
import { AlignmentService, type AlignHandle } from '../services/alignmentService'
import { rid } from '../core/ids'
import { buildSampleManuscripts } from '../core/sample'
import {
  appendBlock,
  blockFromDecision,
  deleteBlock as draftDeleteBlock,
  deleteChars as draftDeleteChars,
  insertBlockAt,
  insertChars as draftInsertChars,
  manualBlock,
  moveBlock as draftMoveBlock,
  relocateAnnotation as draftRelocate,
  addAnnotation as draftAddAnnotation,
  type DraftState
} from '../core/draft'
import { exportPackage, importPackage, verifyConsistency, type ProjectData } from '../core/package'
import { detectConflicts, mergePackages, type MergeConflict } from '../core/merge'
import { applyRecheck, defaultNormLookup, recheckOnNewManuscript } from '../core/recheck'
import { sha256Hex } from '../core/hash'

const STORAGE_KEY = 'guji-collation-state-v1'

// 非响应式运行句柄：单例 store，模块级持有即可，避免被 Vue 代理
let service: AlignmentService | null = null
let activeHandle: AlignHandle | null = null

interface PairState {
  alignment: PairAlignment | null
  moves: MoveCandidate[]
  anchors: AlignAnchor[]
  status: 'idle' | 'running' | 'done' | 'canceled' | 'error'
  error?: string
}

interface CollationState {
  projectName: string
  projectDescription: string
  manuscripts: Manuscript[]
  normConfig: NormConfig
  referenceId: string | null
  pairs: Record<string, PairState>
  multiColumns: MultiColumn[]
  insertedPassages: InsertedPassage[]
  decisions: Decision[]
  draftBlocks: DraftBlock[]
  ops: DraftState['ops']
  annotations: Annotation[]
  selectedPairKey: string | null
  progress: { done: number; total: number } | null
  lastReport: CheckReport | null
  recheckReport: { decisionId: string; status: 'valid' | 'review'; reason: string }[] | null
}

function emptyPair(a: string, b: string, cfg: NormConfig): PairAlignment {
  return {
    key: `${a}::${b}`,
    versionA: a,
    versionB: b,
    configSnapshot: cloneDeep(cfg),
    anchors: [],
    revisions: [],
    segments: [],
    status: 'idle',
    computedAt: 0
  }
}

// 响应式 Proxy 不能 structuredClone / postMessage；边界统一脱代理深拷贝
function cloneDeep<T>(v: T): T {
  return JSON.parse(JSON.stringify(toRaw(v))) as T
}

export const useCollationStore = defineStore('collation', {
  state: (): CollationState => ({
    projectName: '古籍校勘示例工程',
    projectDescription: '虛構文本，僅用於演示多版本校勘流程',
    manuscripts: [],
    normConfig: defaultNormConfig(),
    referenceId: null,
    pairs: {},
    multiColumns: [],
    insertedPassages: [],
    decisions: [],
    draftBlocks: [],
    ops: [],
    annotations: [],
    selectedPairKey: null,
    progress: null,
    lastReport: null,
    recheckReport: null
  }),

  getters: {
    manuscriptById: (s) => (id: string) => s.manuscripts.find((m) => m.id === id),
    pairKey: () => (a: string, b: string) => `${a}::${b}`,
    tokensOf: (s) => (id: string) => {
      const ms = s.manuscripts.find((m) => m.id === id)
      return ms ? normalize(ms, s.normConfig).tokens : []
    },
    confirmedDecisions: (s) => s.decisions.filter((d) => d.state === 'confirmed'),
    pendingAnnotations: (s) => s.annotations.filter((a) => a.status === 'pending-relocation'),
    runningCount: (s) => Object.values(s.pairs).filter((p) => p.status === 'running').length
  },

  actions: {
    // ---------- 工程与底本 ----------

    async loadSample(): Promise<void> {
      this.$reset()
      this.manuscripts = await buildSampleManuscripts()
      this.referenceId = this.manuscripts[0].id
      await this.runAllPairs()
      this.rebuildMultiColumns()
      this.persist()
    },

    async addManuscript(name: string, note: string, rawText: string): Promise<string> {
      const id = rid('ms')
      const ms = await buildManuscript(id, name, note, rawText)
      this.manuscripts.push(ms)
      this.recheckReport = null
      this.persist()
      return id
    },

    setReference(id: string): void {
      this.referenceId = id
      this.rebuildMultiColumns()
      this.persist()
    },

    updateConfig(patch: Partial<NormConfig>): void {
      this.normConfig = {
        ...this.normConfig,
        ...patch,
        costs: { ...this.normConfig.costs, ...(patch.costs ?? {}) }
      }
      this.persist()
    },

    // ---------- 对齐 ----------

    ensurePair(key: string): PairState {
      if (!this.pairs[key]) {
        this.pairs[key] = { alignment: null, moves: [], anchors: [], status: 'idle' }
      }
      return this.pairs[key]
    },

    async runAllPairs(): Promise<void> {
      if (!this.referenceId || this.manuscripts.length < 2) return
      for (const ms of this.manuscripts) {
        if (ms.id === this.referenceId) continue
        await this.runPair(this.referenceId, ms.id)
      }
    },

    async rerunAll(): Promise<void> {
      // 配置变更后重算全部配对
      const ref = this.referenceId
      if (!ref) return
      for (const ms of this.manuscripts) {
        if (ms.id === ref) continue
        await this.runPair(ref, ms.id)
      }
    },

    async runPair(aId: string, bId: string): Promise<void> {
      const msA = this.manuscripts.find((m) => m.id === aId)
      const msB = this.manuscripts.find((m) => m.id === bId)
      if (!msA || !msB) return
      const key = this.pairKey(aId, bId)
      const pair = this.ensurePair(key)
      pair.status = 'running'
      pair.error = undefined
      this.selectedPairKey = key

      if (typeof Worker !== 'undefined') {
        if (!service) {
          service = new AlignmentService((done, total) => {
            this.progress = { done, total }
          })
        }
        if (activeHandle) activeHandle.cancel() // 切换底本/重算：旧请求先取消
        const handle = service.request(
          cloneDeep(msA),
          cloneDeep(msB),
          cloneDeep(this.normConfig),
          cloneDeep(pair.anchors),
          cloneDeep(pair.alignment?.revisions ?? [])
        )
        activeHandle = handle
        try {
          const { alignment, moves } = await handle.promise
          if (activeHandle !== handle) return // 过期回包：丢弃，不覆盖新选择
          this.acceptAlignment(key, alignment, moves)
        } catch (e) {
          if (activeHandle !== handle) return
          pair.status = e instanceof Error && e.message === 'alignment-canceled' ? 'canceled' : 'error'
          pair.error = e instanceof Error ? e.message : String(e)
        } finally {
          if (activeHandle === handle) {
            activeHandle = null
            this.progress = null
          }
        }
      } else {
        // 无 Worker 环境（单元测试 / SSR）走同步管线
        try {
          const { alignment, moves } = computePairAlignment(
            cloneDeep(msA),
            cloneDeep(msB),
            cloneDeep(this.normConfig),
            cloneDeep(pair.anchors),
            cloneDeep(pair.alignment?.revisions ?? [])
          )
          this.acceptAlignment(key, alignment, moves)
        } catch (e) {
          pair.status = 'error'
          pair.error = e instanceof Error ? e.message : String(e)
        }
      }
      this.persist()
    },

    acceptAlignment(key: string, alignment: PairAlignment, moves: MoveCandidate[]): void {
      const pair = this.ensurePair(key)
      // 保留已人工处理的移段结论（按范围匹配，id 每次重算会变）
      const remembered = new Map(
        pair.moves.map((m) => [`${m.deleteRun.start}-${m.deleteRun.end}:${m.insertRun.start}-${m.insertRun.end}`, m])
      )
      pair.alignment = alignment
      pair.moves = moves.map((m) => {
        const k = `${m.deleteRun.start}-${m.deleteRun.end}:${m.insertRun.start}-${m.insertRun.end}`
        const old = remembered.get(k)
        return old ? { ...m, status: old.status, confirmedAt: old.confirmedAt } : m
      })
      pair.status = 'done'
      this.rebuildMultiColumns()
    },

    addAnchor(aId: string, bId: string, a: number, b: number, label?: string): void {
      const key = this.pairKey(aId, bId)
      const pair = this.ensurePair(key)
      pair.anchors.push({ id: rid('anc'), a, b, label })
      void this.runPair(aId, bId)
    },

    removeAnchor(aId: string, bId: string, anchorId: string): void {
      const key = this.pairKey(aId, bId)
      const pair = this.ensurePair(key)
      pair.anchors = pair.anchors.filter((x) => x.id !== anchorId)
      void this.runPair(aId, bId)
    },

    /** 确认歧义组方案：所选 ops（已为全局 token 下标）转为强制配对修订后重算 */
    confirmAmbiguity(key: string, groupId: string, chosenIndex: number, note?: string): void {
      const pair = this.ensurePair(key)
      const alignment = pair.alignment
      if (!alignment) return
      const seg = alignment.segments.find((s) => s.ambiguousGroups.some((g) => g.id === groupId))
      const group = seg?.ambiguousGroups.find((g) => g.id === groupId)
      if (!seg || !group) return
      const chosen = group.alternatives[chosenIndex]
      const revisions: AlignmentRevision[] = chosen.ops.map((op) => {
        const at = Date.now()
        if (op.kind === 'match' || op.kind === 'sub') {
          return { id: rid('rev'), pin: { kind: op.kind, a: op.a, b: op.b }, note, at }
        }
        if (op.kind === 'gapB') return { id: rid('rev'), pin: { kind: 'gapB', a: op.a }, note, at }
        return { id: rid('rev'), pin: { kind: 'gapA', b: op.b }, note, at }
      })
      group.resolved = { chosenIndex, revisionIds: revisions.map((r) => r.id) }
      alignment.revisions.push(...revisions)
      void this.runPair(alignment.versionA, alignment.versionB)
    },

    confirmMove(moveId: string): void {
      for (const pair of Object.values(this.pairs)) {
        const mv = pair.moves.find((m) => m.id === moveId)
        if (mv) {
          mv.status = 'confirmed'
          mv.confirmedAt = Date.now()
        }
      }
      this.persist()
    },

    rejectMove(moveId: string): void {
      for (const pair of Object.values(this.pairs)) {
        const mv = pair.moves.find((m) => m.id === moveId)
        if (mv) mv.status = 'rejected'
      }
      this.persist()
    },

    rebuildMultiColumns(): void {
      if (!this.referenceId) return
      const refMs = this.manuscripts.find((m) => m.id === this.referenceId)
      if (!refMs) return
      const refTokens = normalize(refMs, this.normConfig).tokens
      const refId = this.referenceId
      const others = this.manuscripts
        .filter((m) => m.id !== refId)
        .map((ms) => {
          const pair = this.pairs[this.pairKey(refId, ms.id)]
          return {
            versionId: ms.id,
            tokens: normalize(ms, this.normConfig).tokens,
            pair: pair?.alignment ?? emptyPair(refId, ms.id, this.normConfig)
          }
        })
      const built = buildMultiColumns(refId, refTokens, others)
      this.multiColumns = built.columns
      this.insertedPassages = built.inserted
    },

    // ---------- 决定与采用稿 ----------

    bindingsFor(targetId: string): CharacterRef[] {
      const col = this.multiColumns.find((c) => c.id === targetId)
      if (col) {
        return Object.entries(col.cells)
          .filter(([, t]) => t !== null)
          .map(([versionId, t]) => ({ versionId, tIndex: t as number }))
      }
      const passage = this.insertedPassages.find((p) => p.id === targetId)
      if (passage) {
        const refs: CharacterRef[] = []
        for (let t = passage.tokenRange[0]; t <= passage.tokenRange[1]; t++) {
          refs.push({ versionId: passage.ownerVersionId, tIndex: t })
        }
        return refs
      }
      return []
    },

    revisionBaseline(): string[] {
      return Object.values(this.pairs)
        .flatMap((p) => p.alignment?.revisions ?? [])
        .map((r) => r.id)
    },

    /** 校勘员作出决定（采用某本/合成/暂不取舍）；只有 confirmed 才进入正式采用稿 */
    submitDecision(
      targetId: string,
      kind: DecisionKind,
      payload: { chosenVersionId?: string; synthesisText?: string; reason: string }
    ): Decision {
      const bindings = this.bindingsFor(targetId)
      const existing = this.decisions.find((d) => d.targetId === targetId)
      const decision: Decision = {
        id: existing?.id ?? rid('dec'),
        targetId,
        kind,
        chosenVersionId: payload.chosenVersionId,
        synthesisText: payload.synthesisText,
        reason: payload.reason,
        state: 'confirmed',
        bindings,
        revisionIds: this.revisionBaseline(),
        at: Date.now(),
        validity: existing?.validity,
        basisSnapshot: existing?.basisSnapshot
      }
      if (existing) Object.assign(existing, decision)
      else this.decisions.push(decision)

      if (kind !== 'defer') {
        const text =
          kind === 'synthesis'
            ? (payload.synthesisText ?? '')
            : this.textForRefs(bindings.filter((r) => r.versionId === payload.chosenVersionId))
        const block = blockFromDecision(decision, text, bindings)
        const oldBlock = this.draftBlocks.find((b) => b.columnId === targetId)
        if (oldBlock) draftDeleteBlock(this.draftState(), oldBlock.id)
        appendBlock(this.draftState(), block)
      }
      this.persist()
      return decision
    },

    textForRefs(refs: CharacterRef[]): string {
      return refs
        .map((r) => {
          const ms = this.manuscripts.find((m) => m.id === r.versionId)
          if (!ms) return ''
          return normalize(ms, this.normConfig).tokens[r.tIndex]?.orig ?? ''
        })
        .join('')
    },

    draftState(): DraftState {
      return { blocks: this.draftBlocks, ops: this.ops, annotations: this.annotations }
    },

    insertManualSentence(index: number, text: string): void {
      insertBlockAt(this.draftState(), index, manualBlock(text))
      this.persist()
    },

    removeDraftBlock(blockId: string): void {
      draftDeleteBlock(this.draftState(), blockId)
      this.persist()
    },

    insertDraftChars(blockId: string, at: number, text: string): void {
      draftInsertChars(this.draftState(), blockId, at, text)
      this.persist()
    },

    deleteDraftChars(blockId: string, charIds: string[]): void {
      draftDeleteChars(this.draftState(), blockId, charIds)
      this.persist()
    },

    moveDraftBlock(blockId: string, toIndex: number): void {
      draftMoveBlock(this.draftState(), blockId, toIndex)
      this.persist()
    },

    addAnnotation(charIds: string[], content: string): void {
      draftAddAnnotation(this.draftState(), charIds, content)
      this.persist()
    },

    relocateAnnotation(annotationId: string, charIds: string[]): void {
      draftRelocate(this.draftState(), annotationId, charIds)
      this.persist()
    },

    // ---------- 新底本复核 ----------

    async importNewManuscript(name: string, note: string, rawText: string): Promise<void> {
      const id = await this.addManuscript(name, note, rawText)
      if (this.referenceId) {
        await this.runPair(this.referenceId, id)
        this.rebuildMultiColumns()
      }
      const ms = this.manuscripts.find((m) => m.id === id)!
      const report = recheckOnNewManuscript(
        ms,
        this.multiColumns,
        this.decisions,
        Object.values(this.pairs).flatMap((p) => p.anchors),
        (vid) => Boolean(this.pairs[this.pairKey(this.referenceId ?? '', vid)]?.alignment),
        defaultNormLookup(this.manuscripts, this.normConfig)
      )
      applyRecheck(this.decisions, report.items)
      this.recheckReport = report.items.map((i) => ({
        decisionId: i.decisionId,
        status: i.status,
        reason: i.reason
      }))
      this.persist()
    },

    // ---------- 导入 / 导出 / 合并 ----------

    snapshotForMerge(): ProjectPackage {
      return {
        format: 'guji-collation-package',
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        project: { name: this.projectName, description: this.projectDescription },
        manuscripts: this.manuscripts,
        normConfig: this.normConfig,
        referenceId: this.referenceId ?? '',
        pairAlignments: Object.values(this.pairs)
          .map((p) => p.alignment)
          .filter((x): x is PairAlignment => x !== null),
        multiColumns: this.multiColumns,
        insertedPassages: this.insertedPassages,
        moves: Object.values(this.pairs).flatMap((p) => p.moves),
        decisions: this.decisions,
        draftBlocks: this.draftBlocks,
        ops: this.ops,
        annotations: this.annotations,
        checksums: { manuscript: {}, chunk: {}, overall: '' }
      }
    },

    async exportProject(): Promise<string> {
      const data: ProjectData = {
        project: { name: this.projectName, description: this.projectDescription },
        manuscripts: this.manuscripts,
        normConfig: this.normConfig,
        referenceId: this.referenceId ?? '',
        pairAlignments: Object.values(this.pairs)
          .map((p) => p.alignment)
          .filter((x): x is PairAlignment => x !== null),
        multiColumns: this.multiColumns,
        insertedPassages: this.insertedPassages,
        moves: Object.values(this.pairs).flatMap((p) => p.moves),
        decisions: this.decisions,
        draftBlocks: this.draftBlocks,
        ops: this.ops,
        annotations: this.annotations
      }
      const pkg = await exportPackage(data)
      return JSON.stringify(pkg, null, 2)
    },

    hydrateFromPackage(pkg: ProjectPackage): void {
      this.$reset()
      this.projectName = pkg.project.name
      this.projectDescription = pkg.project.description
      this.manuscripts = pkg.manuscripts
      this.normConfig = pkg.normConfig
      this.referenceId = pkg.referenceId
      this.decisions = pkg.decisions
      this.draftBlocks = pkg.draftBlocks
      this.ops = pkg.ops
      this.annotations = pkg.annotations
      this.multiColumns = pkg.multiColumns
      this.insertedPassages = pkg.insertedPassages
      this.pairs = {}
      for (const alignment of pkg.pairAlignments) {
        const moves = pkg.moves.filter(
          (m) => m.baseVersionId === alignment.versionA && m.otherVersionId === alignment.versionB
        )
        this.pairs[alignment.key] = { alignment, moves, anchors: alignment.anchors, status: 'done' }
      }
    },

    async importProject(text: string): Promise<CheckReport> {
      const { pkg, report } = await importPackage(text)
      this.hydrateFromPackage(pkg)
      this.lastReport = report
      this.persist()
      return report
    },

    /** 合并预检：返回逐项冲突，UI 必须逐项选择后才能执行；非法文件抛出带提示的错误 */
    previewMerge(text: string): MergeConflict[] {
      let incoming: ProjectPackage
      try {
        incoming = JSON.parse(text) as ProjectPackage
      } catch (e) {
        throw new Error(`導入包不是合法 JSON：${e instanceof Error ? e.message : String(e)}`)
      }
      return detectConflicts(this.snapshotForMerge(), incoming)
    },

    async resolveMerge(text: string, resolutions: Record<string, 'base' | 'incoming'>): Promise<string[]> {
      const { pkg: incoming } = await importPackage(text)
      const basePkg = JSON.parse(JSON.stringify(this.snapshotForMerge())) as ProjectPackage
      const outcome = mergePackages(basePkg, incoming, resolutions)
      this.hydrateFromPackage(outcome.merged)
      this.lastReport = verifyConsistency(outcome.merged)
      this.persist()
      return outcome.autoMerged
    },

    verifyNow(): CheckReport {
      const report = verifyConsistency(this.snapshotForMerge())
      this.lastReport = report
      return report
    },

    // ---------- 本地持久化（快照不做假恢复：指纹不符即丢弃） ----------

    persist(): void {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.snapshotForMerge()))
      } catch {
        // 存储不可用时静默；导出文件仍是正式交付渠道
      }
    },

    async restoreFromStorage(): Promise<boolean> {
      if (typeof localStorage === 'undefined') return false
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return false
      try {
        const snap = JSON.parse(raw) as ProjectPackage
        for (const ms of snap.manuscripts ?? []) {
          if ((await sha256Hex(ms.rawText)) !== ms.fingerprint) {
            localStorage.removeItem(STORAGE_KEY)
            return false
          }
        }
        this.hydrateFromPackage(snap)
        this.lastReport = verifyConsistency(snap)
        return true
      } catch {
        localStorage.removeItem(STORAGE_KEY)
        return false
      }
    }
  }
})
