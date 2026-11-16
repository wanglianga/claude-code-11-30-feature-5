// 主线程对齐服务：单 Worker 复用、requestId 单调递增。
// 取消或切换底本后，旧 requestId 的回包一律丢弃，绝不覆盖新选择。
import type { AlignRequest, AlignResponse, WorkerIn, WorkerOut } from '../worker/messages'
import type {
  AlignAnchor,
  AlignmentRevision,
  Manuscript,
  MoveCandidate,
  NormConfig,
  PairAlignment
} from '../core/types'

export interface AlignHandle {
  promise: Promise<{ alignment: PairAlignment; moves: MoveCandidate[] }>
  cancel: () => void
}

export class AlignmentService {
  private worker: Worker | null = null
  private seq = 0
  private pending = new Map<
    number,
    {
      resolve: (v: { alignment: PairAlignment; moves: MoveCandidate[] }) => void
      reject: (e: Error) => void
    }
  >()
  private onProgress?: (done: number, total: number) => void

  constructor(onProgress?: (done: number, total: number) => void) {
    this.onProgress = onProgress
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('../worker/alignment.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (ev: MessageEvent<WorkerOut>) => this.handle(ev.data)
    }
    return this.worker
  }

  private handle(msg: WorkerOut): void {
    if (msg.type === 'align-progress') {
      this.onProgress?.(msg.done, msg.total)
      return
    }
    const res: AlignResponse = msg
    const p = this.pending.get(res.requestId)
    if (!p) return // 旧请求回包：直接丢弃，不替换当前选择
    this.pending.delete(res.requestId)
    if (res.ok && res.alignment && res.moves) {
      p.resolve({ alignment: res.alignment, moves: res.moves })
    } else if (res.canceled) {
      p.reject(new Error('alignment-canceled'))
    } else {
      p.reject(new Error(res.error ?? 'alignment-failed'))
    }
  }

  request(
    manuscriptA: Manuscript,
    manuscriptB: Manuscript,
    config: NormConfig,
    anchors: AlignAnchor[],
    revisions: AlignmentRevision[]
  ): AlignHandle {
    this.seq += 1
    const requestId = this.seq
    const worker = this.ensureWorker()
    const req: AlignRequest = {
      type: 'align-request',
      requestId,
      key: `${manuscriptA.id}::${manuscriptB.id}`,
      manuscriptA,
      manuscriptB,
      config,
      anchors,
      revisions
    }
    const promise = new Promise<{ alignment: PairAlignment; moves: MoveCandidate[] }>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject })
    })
    worker.postMessage(req satisfies WorkerIn)
    return {
      promise,
      cancel: () => {
        const cancelMsg: WorkerIn = { type: 'cancel', requestId }
        worker.postMessage(cancelMsg)
      }
    }
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = null
    for (const [, p] of this.pending) p.reject(new Error('service-disposed'))
    this.pending.clear()
  }
}
