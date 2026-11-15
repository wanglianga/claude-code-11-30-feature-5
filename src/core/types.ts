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
  type: 'insert-block' | 'replace-block' | 'delete-block' | 'insert-chars' | 'delete-chars' | 'move-block'
  args: Record<string, unknown>
  at: number
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
  checksums: {
    manuscript: Record<string, string>
    chunk: Record<string, string>
    overall: string
  }
}
