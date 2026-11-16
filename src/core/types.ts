// 校勘领域核心类型定义

export interface CharCoord {
  page: string
  line: number // 行号（从 1 开始）
  charInLine: number // 行内码点序号（从 0 开始）
}

export type CharKind = 'text' | 'punct' | 'mark'

/** 原始底本中的单个 Unicode 码点 */
export interface OriginalChar {
  cpIndex: number // 在 rawText 中按码点计的序号
  code: string // 单个码点（代理对安全）
  kind: CharKind
  coord: CharCoord
}

export interface Manuscript {
  id: string
  name: string // 甲本 / 乙本 ...
  note: string // 版本说明
  rawText: string // 含页行标记的原始转写
  fingerprint: string // rawText 的 SHA-256
  chars: OriginalChar[]
}

/** 规范化配置：标点忽略 + 异体对照 + 对齐代价 */
export interface NormConfig {
  ignorePunctuation: boolean
  variantMap: Record<string, string> // 原码点 -> 规范字形
  costs: { insert: number; delete: number; substitute: number }
  moveThreshold: number
  chunkSize: number
  overlapSize: number
}

/** 比较字符（token）：每个比较字符都保留对应原文码点区间，支持一字对多字反查 */
export interface NormToken {
  tIndex: number
  norm: string // 规范化后的比较形（通常单字）
  srcStart: number // 原文码点区间 [srcStart, srcEnd)
  srcEnd: number
  orig: string // 区间内原文
  variantApplied: boolean // 是否应用了异体对照
  ignoredPunct: number // 区间内被忽略的标点码点数
}

export type PairOpKind = 'match' | 'sub' | 'gapA' | 'gapB'

export type PairOp =
  | { kind: 'match' | 'sub'; a: number; b: number }
  | { kind: 'gapA'; b: number } // 甲无乙有
  | { kind: 'gapB'; a: number } // 甲有乙无

/** 人工/确认锚点：强制甲 token a 与乙 token b 配对 */
export interface AlignAnchor {
  id: string
  a: number
  b: number
  label?: string
}

export interface AlignmentRevision {
  id: string
  pin: PairOp
  note?: string
  at: number
}

export interface AmbiguityAlternative {
  index: number
  label: string
  cost: number
  ops: PairOp[]
}

export interface AmbiguityGroup {
  id: string
  aRange: [number, number]
  bRange: [number, number]
  alternatives: AmbiguityAlternative[]
  resolved?: { chosenIndex: number; revisionIds: string[] }
}

export interface AlignColumn {
  id: string
  segId: string
  a: number | null
  b: number | null
  kind: PairOpKind
  ambGroupId?: string
  seamVerified?: boolean
}

export interface SegmentAlign {
  id: string
  aRange: [number, number] // token 区间（含端点）
  bRange: [number, number]
  columns: AlignColumn[]
  cost: number
  ambiguousGroups: AmbiguityGroup[]
  seamVerified: boolean
  chunkHash: string
}

export type AlignStatus = 'idle' | 'running' | 'done' | 'canceled' | 'error'

export interface PairAlignment {
  key: string // `${versionA}::${versionB}`
  versionA: string
  versionB: string
  configSnapshot: NormConfig
  anchors: AlignAnchor[]
  revisions: AlignmentRevision[]
  segments: SegmentAlign[]
  status: AlignStatus
  computedAt: number
  canceled?: boolean
  error?: string
}

export interface MoveCandidate {
  id: string
  baseVersionId: string // 甲
  otherVersionId: string // 乙
  deleteRun: { start: number; end: number } // 甲 token 区间（乙所缺）
  insertRun: { start: number; end: number } // 乙 token 区间（甲所无）
  similarity: number
  context: { beforeA: string; afterA: string; beforeB: string; afterB: string }
  status: 'suggested' | 'confirmed' | 'rejected'
  confirmedAt?: number
}

export type CellKind = PairOpKind | 'ref' | 'absent'

export interface MultiColumn {
  id: string
  refToken: number | null // 参考本 token 序号；null 表示参考本无此段
  insertedPassageId?: string
  cells: Record<string, number | null> // versionId -> token 序号
  kinds: Record<string, CellKind>
}

export interface InsertedPassage {
  id: string
  ownerVersionId: string
  tokenRange: [number, number]
  groupedWith: { versionId: string; tokenRange: [number, number] }[]
}

export interface CharacterRef {
  versionId: string
  tIndex: number
}

export type DecisionKind = 'adopt-version' | 'synthesis' | 'defer'
export type DecisionState = 'machine' | 'confirmed'

export interface Decision {
  id: string
  targetId: string // MultiColumn.id 或 InsertedPassage.id
  kind: DecisionKind
  chosenVersionId?: string
  synthesisText?: string
  reason: string
  state: DecisionState
  bindings: CharacterRef[] // 绑定的底本比较字符（可反查原文区间）
  revisionIds: string[] // 作出决定时的对齐修订基线
  at: number
  validity?: 'valid' | 'review' // 新底本到来后的复核标记
  basisSnapshot?: CharacterRef[] // 旧依据保留
}

export type AnchorType =
  | { type: 'column'; columnId: string; refs: CharacterRef[] }
  | { type: 'manual' }

export interface DraftChar {
  id: string
  text: string
  anchor: AnchorType
}

export interface DraftBlock {
  id: string
  columnId?: string // 对应校勘列/新增段
  decisionId?: string
  chars: DraftChar[]
  manual?: boolean
}

export type AnnotationStatus = 'active' | 'pending-relocation'

export interface Annotation {
  id: string
  charIds: string[] // 稳定字符标识，不存下标
  content: string
  status: AnnotationStatus
  orphanedFrom: string[] // 被删除而失去挂靠的字符 id
  at: number
}

export interface DraftOp {
  id: string
  type:
    | 'insert-block'
    | 'replace-block'
    | 'delete-block'
    | 'insert-chars'
    | 'delete-chars'
    | 'move-block'
    | 'split-block'
  args: Record<string, unknown>
  rev: number // 采用稿修订号（单调递增），引用迁移据此重放操作链
  at: number
}

// ---------- 引文迁移 ----------

/** 迁移结论：只允许位置变化、文字变化、拆分关联、删除、未解决五种 */
export type CitationStatus = 'moved' | 'text-changed' | 'split' | 'deleted' | 'unresolved'

/** 迁移路径：操作链推导 / 局部重对齐 / 两者皆无 */
export type MigrationPath = 'ops' | 'realign' | 'none'

/** 底本锚点：引文在底本中的比较字符区间（含端点） */
export interface CitationBaseAnchor {
  versionId: string
  tokenStart: number
  tokenEnd: number
  text: string
}

/** 旧引文在采用稿中的原文范围（稳定字符标识，不存下标） */
export interface CitationSpan {
  blockIds: string[]
  charIds: string[]
  text: string
}

export interface CitationContext {
  before: string
  after: string
}

/** 每次迁移前的旧修订快照，保留审计 */
export interface CitationRevisionRecord {
  revision: number
  at: number
  status: CitationStatus
  span: CitationSpan
  textFingerprint: string
  recordedAtRevision: number
  note: string
}

export interface Citation {
  id: string
  label: string
  purpose: string // 用途：論點支撐 / 訓詁 / 校記…
  note?: string
  span: CitationSpan
  baseAnchors: CitationBaseAnchor[]
  anchorColumnIds: string[] // 锚定的校勘列（列被删/合并会使操作链中断）
  context: CitationContext
  recordedAtRevision: number // 记录时的采用稿修订（旧修订）
  revision: number // 引用版本，单调递增，并发任务以此拒绝覆盖
  recordedAt: number
  textFingerprint: string // 旧文本指纹
  status: CitationStatus
  history: CitationRevisionRecord[]
  lastMigration?: MigrationResult
}

/** 迁移后的单段结果（拆分会给出多段） */
export interface MigrationSegment {
  blockId: string
  start: number // 块内字符下标（含）
  end: number // 块内字符下标（含）
  charIds: string[]
  text: string
  fingerprint: string
  baseAnchorIndex: number | null
  baseRange: [number, number] | null // 对应底本 token 区间
  ambiguousAnchors?: number[]
}

export interface MigrationCandidate {
  blockId: string
  start: number
  end: number
  text: string
  similarity: number
  fingerprint: string
}

export interface MigrationResult {
  citationId: string
  citationRevision: number // 本次迁移所依据的引用版本
  recordedAtRevision: number
  draftRevision: number // 本次迁移所依据的采用稿修订
  path: MigrationPath
  status: CitationStatus
  oldFingerprint: string
  newFingerprint: string
  segments: MigrationSegment[]
  opChain: string[] // 组合后的操作链说明
  explanation: string[] // 差异说明
  candidates: MigrationCandidate[] // 未解决时列出全部候选，绝不以最高相似度顶替出处
  interrupted?: string // 操作链中断原因
  computedAt: number
  stale?: boolean // 上下文再次修改后候选失效
}

export interface CheckReport {
  ok: boolean
  errors: string[]
  warnings: string[]
  checkedAt: string
}

export interface ProjectPackage {
  format: 'guji-collation-package'
  formatVersion: 1
  exportedAt: string
  project: { name: string; description: string }
  manuscripts: Manuscript[]
  normConfig: NormConfig
  referenceId: string
  pairAlignments: PairAlignment[]
  multiColumns: MultiColumn[]
  insertedPassages: InsertedPassage[]
  moves: MoveCandidate[]
  decisions: Decision[]
  draftBlocks: DraftBlock[]
  ops: DraftOp[]
  annotations: Annotation[]
  citations?: Citation[]
  citationMigrations?: MigrationResult[]
  checksums: {
    manuscript: Record<string, string>
    chunk: Record<string, string>
    overall: string
  }
}
