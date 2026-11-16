import { describe, expect, it } from 'vitest'
import { buildManuscript, computePairAlignment } from '../src/core/pipeline'
import { defaultNormConfig, normalize } from '../src/core/normalize'
import { buildMultiColumns } from '../src/core/align/align'
import { exportPackage, type ProjectData } from '../src/core/package'
import { detectConflicts, mergePackages } from '../src/core/merge'
import type { Decision, ProjectPackage } from '../src/core/types'
import { rid } from '../src/core/ids'

async function basePackage(): Promise<{ pkg: ProjectPackage; data: ProjectData }> {
  const cfg = defaultNormConfig()
  const jia = await buildManuscript('jia', '甲本', '', '甲乙丙丁戊')
  const yi = await buildManuscript('yi', '乙本', '', '甲乙丁戊')
  const { alignment, moves } = computePairAlignment(jia, yi, cfg, [], [])
  const built = buildMultiColumns(jia.id, normalize(jia, cfg).tokens, [
    { versionId: yi.id, tokens: normalize(yi, cfg).tokens, pair: alignment }
  ])
  const data: ProjectData = {
    project: { name: '合并测试', description: '' },
    manuscripts: [jia, yi],
    normConfig: cfg,
    referenceId: jia.id,
    pairAlignments: [alignment],
    multiColumns: built.columns,
    insertedPassages: built.inserted,
    moves,
    decisions: [],
    draftBlocks: [],
    ops: [],
    annotations: []
  }
  return { pkg: await exportPackage(data), data }
}

function decision(targetId: string, chosen: string, reason: string): Decision {
  return {
    id: rid('dec'),
    targetId,
    kind: 'adopt-version',
    chosenVersionId: chosen,
    reason,
    state: 'confirmed',
    bindings: [],
    revisionIds: [],
    at: Date.now()
  }
}

describe('双包合并', () => {
  it('不相交修改自动合入', async () => {
    const { pkg } = await basePackage()
    const cols = pkg.multiColumns
    const incoming = structuredClone(pkg)
    pkg.decisions = [decision(cols[0].id, 'jia', '当前工程的决定')]
    incoming.decisions = [decision(cols[1].id, 'yi', '导入包的决定')]
    const conflicts = detectConflicts(pkg, incoming)
    expect(conflicts).toHaveLength(0)
    const outcome = mergePackages(pkg, incoming, {})
    expect(outcome.autoMerged.length).toBeGreaterThan(0)
    expect(outcome.merged.decisions).toHaveLength(2)
  })

  it('同一异文的相反取舍必须逐项选择，未选择则拒绝合并', async () => {
    const { pkg } = await basePackage()
    const target = pkg.multiColumns[0].id
    const incoming = structuredClone(pkg)
    pkg.decisions = [decision(target, 'jia', '从甲')]
    incoming.decisions = [decision(target, 'yi', '从乙')]
    const conflicts = detectConflicts(pkg, incoming)
    expect(conflicts.some((c) => c.kind === 'opposite-decision')).toBe(true)
    expect(() => mergePackages(pkg, incoming, {})).toThrow()
    const pick: Record<string, 'base' | 'incoming'> = {}
    for (const c of conflicts) pick[c.id] = 'incoming'
    const merged = mergePackages(pkg, incoming, pick).merged
    expect(merged.decisions.find((d) => d.targetId === target)?.chosenVersionId).toBe('yi')
  })

  it('移动范围重叠产生冲突项', async () => {
    const { pkg } = await basePackage()
    const incoming = structuredClone(pkg)
    pkg.moves = [
      { ...pkg.moves[0], id: 'm1', deleteRun: { start: 1, end: 3 }, insertRun: { start: 5, end: 7 }, status: 'suggested' }
    ]
    incoming.moves = [
      { ...incoming.moves[0], id: 'm2', deleteRun: { start: 2, end: 4 }, insertRun: { start: 6, end: 8 }, status: 'suggested' }
    ]
    const conflicts = detectConflicts(pkg, incoming)
    expect(conflicts.some((c) => c.kind === 'overlapping-move')).toBe(true)
  })

  it('同一引文被两边分别迁移：逐项选择，不允许引用版本高者自动覆盖', async () => {
    const { pkg } = await basePackage()
    const base = structuredClone(pkg)
    const incoming = structuredClone(pkg)
    const citation = {
      id: 'cit_1',
      label: '引文',
      purpose: '論點支撐',
      span: { blockIds: ['b1'], charIds: ['c1'], text: '甲' },
      baseAnchors: [{ versionId: 'jia', tokenStart: 0, tokenEnd: 0, text: '甲' }],
      anchorColumnIds: [],
      context: { before: '', after: '' },
      recordedAtRevision: 0,
      revision: 2,
      recordedAt: 1,
      textFingerprint: 'f1',
      status: 'moved' as const,
      history: []
    }
    base.citations = [{ ...citation, revision: 1 }]
    incoming.citations = [{ ...citation, revision: 3, span: { blockIds: ['b2'], charIds: ['c9'], text: '乙' }, textFingerprint: 'f2' }]
    const conflicts = detectConflicts(base, incoming)
    expect(conflicts.some((c) => c.kind === 'citation-diverged')).toBe(true)
    expect(() => mergePackages(base, incoming, {})).toThrow()
    const pick: Record<string, 'base' | 'incoming'> = {}
    for (const c of conflicts) pick[c.id] = 'base'
    const merged = mergePackages(base, incoming, pick).merged
    expect(merged.citations?.[0].span.text).toBe('甲')
  })

  it('不相交引文自动合入', async () => {
    const { pkg } = await basePackage()
    const base = structuredClone(pkg)
    const incoming = structuredClone(pkg)
    const mk = (id: string): any => ({
      id,
      label: id,
      purpose: '校記',
      span: { blockIds: ['b'], charIds: [id], text: '文' },
      baseAnchors: [],
      anchorColumnIds: [],
      context: { before: '', after: '' },
      recordedAtRevision: 0,
      revision: 1,
      recordedAt: 1,
      textFingerprint: 'ff',
      status: 'moved',
      history: []
    })
    base.citations = [mk('cit_a')]
    incoming.citations = [mk('cit_b')]
    const outcome = mergePackages(base, incoming, {})
    expect(outcome.merged.citations).toHaveLength(2)
    expect(outcome.autoMerged.some((m) => m.includes('新增引文'))).toBe(true)
  })
})
