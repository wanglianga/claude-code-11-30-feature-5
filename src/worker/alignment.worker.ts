// Web Worker：长文分块 DP 在后台线程执行；每请求携带 requestId 与取消标志。
import { computePairAlignment } from '../core/pipeline'
import { CanceledError } from '../core/align/align'
import type { AlignRequest, WorkerIn, WorkerOut } from './messages'

const signals = new Map<number, { canceled: boolean }>()

self.onmessage = (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data
  if (msg.type === 'cancel') {
    const s = signals.get(msg.requestId)
    if (s) s.canceled = true
    return
  }
  if (msg.type !== 'align-request') return
  const req: AlignRequest = msg
  const signal = { canceled: false }
  signals.set(req.requestId, signal)

  try {
    const { alignment, moves } = computePairAlignment(
      req.manuscriptA,
      req.manuscriptB,
      req.config,
      req.anchors,
      req.revisions,
      signal,
      (done, total) => {
        const out: WorkerOut = { type: 'align-progress', requestId: req.requestId, done, total }
        ;(self as unknown as Worker).postMessage(out)
      }
    )
    if (signal.canceled) {
      post({ type: 'align-response', requestId: req.requestId, key: req.key, ok: false, canceled: true })
      return
    }
    post({ type: 'align-response', requestId: req.requestId, key: req.key, ok: true, alignment, moves })
  } catch (e) {
    if (e instanceof CanceledError || signal.canceled) {
      post({ type: 'align-response', requestId: req.requestId, key: req.key, ok: false, canceled: true })
    } else {
      post({
        type: 'align-response',
        requestId: req.requestId,
        key: req.key,
        ok: false,
        error: e instanceof Error ? e.message : String(e)
      })
    }
  } finally {
    signals.delete(req.requestId)
  }
}

function post(msg: WorkerOut): void {
  ;(self as unknown as Worker).postMessage(msg)
}
