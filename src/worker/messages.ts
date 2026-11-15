// Worker <-> 主线程消息协议
import type {
  AlignAnchor,
  AlignmentRevision,
  Manuscript,
  MoveCandidate,
  NormConfig,
  PairAlignment
} from '../core/types'

export interface AlignRequest {
  type: 'align-request'
  requestId: number
  key: string
  manuscriptA: Manuscript
  manuscriptB: Manuscript
  config: NormConfig
  anchors: AlignAnchor[]
  revisions: AlignmentRevision[]
}

export interface AlignProgress {
  type: 'align-progress'
  requestId: number
  done: number
  total: number
}

export interface AlignResponse {
  type: 'align-response'
  requestId: number
  key: string
  ok: boolean
  canceled?: boolean
  error?: string
  alignment?: PairAlignment
  moves?: MoveCandidate[]
}

export type WorkerIn = AlignRequest | { type: 'cancel'; requestId: number }
export type WorkerOut = AlignProgress | AlignResponse
