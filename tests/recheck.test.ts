import { describe, expect, it } from 'vitest'
import { buildManuscript } from '../src/core/pipeline'
import { defaultNormConfig } from '../src/core/normalize'
import { applyRecheck, defaultNormLookup, recheckOnNewManuscript } from '../src/core/recheck'
import type { Decision, MultiColumn } from '../src/core/types'
import { rid } from '../src/core/ids'

describe('新底本复核', () => {
  it('同位文字一致标“仍有效”，缺字/异字标“待复核”，旧依据快照保留', async () => {
    const cfg = defaultNormConfig()
    const jia = await buildManuscript('jia', '甲本', '', '甲乙丙')
    const ding = await buildManuscript('ding', '丁本', '', '甲丁丙')
    const columns: MultiColumn[] = [
      { id: 'c0', refToken: 0, cells: { jia: 0, ding: 0 }, kinds: { jia: 'ref', ding: 'match' } },
      { id: 'c1', refToken: 1, cells: { jia: 1, ding: 1 }, kinds: { jia: 'ref', ding: 'sub' } },
      { id: 'c2', refToken: 2, cells: { jia: 2 }, kinds: { jia: 'ref' } } // 丁本缺该列
    ]
    const decisions: Decision[] = [
      {
        id: rid('dec'),
        targetId: 'c1',
        kind: 'adopt-version',
        chosenVersionId: 'jia',
        reason: 'r',
        state: 'confirmed',
        bindings: [{ versionId: 'jia', tIndex: 1 }],
        revisionIds: [],
        at: 1
      },
      {
        id: rid('dec'),
        targetId: 'c2',
        kind: 'adopt-version',
        chosenVersionId: 'jia',
        reason: 'r',
        state: 'confirmed',
        bindings: [{ versionId: 'jia', tIndex: 2 }],
        revisionIds: [],
        at: 1
      }
    ]
    const report = recheckOnNewManuscript(
      ding,
      columns,
      decisions,
      [],
      () => true,
      defaultNormLookup([jia, ding], cfg)
    )
    const byId = new Map(report.items.map((i) => [i.decisionId, i]))
    expect(byId.get(decisions[0].id)?.status).toBe('review') // 乙 vs 丁
    expect(byId.get(decisions[1].id)?.status).toBe('review') // 丁本缺列
    applyRecheck(decisions, report.items)
    expect(decisions[0].validity).toBe('review')
    expect(decisions[0].basisSnapshot).toEqual([{ versionId: 'jia', tIndex: 1 }])
  })

  it('无配对关系时锚点全部进入待复核', async () => {
    const cfg = defaultNormConfig()
    const ding = await buildManuscript('ding', '丁', '', '甲乙')
    const report = recheckOnNewManuscript(
      ding,
      [],
      [],
      [{ id: 'a1', a: 0, b: 0 }],
      () => false,
      defaultNormLookup([ding], cfg)
    )
    expect(report.affectedAnchors).toHaveLength(1)
  })
})
