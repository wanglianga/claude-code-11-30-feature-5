import { describe, expect, it } from 'vitest'
import { buildManuscript, computePairAlignment } from '../src/core/pipeline'
import { defaultNormConfig, normalize } from '../src/core/normalize'
import { buildMultiColumns } from '../src/core/align/align'
import { exportPackage, importPackage, CorruptPackageError, verifyConsistency, type ProjectData } from '../src/core/package'

async function buildData(): Promise<ProjectData> {
  const cfg = defaultNormConfig()
  const jia = await buildManuscript('jia', '甲本', '', '學而時習之有朋自遠方來')
  const yi = await buildManuscript('yi', '乙本', '', '學而旹習之')
  const { alignment, moves } = computePairAlignment(jia, yi, cfg, [], [])
  const built = buildMultiColumns(jia.id, normalize(jia, cfg).tokens, [
    { versionId: yi.id, tokens: normalize(yi, cfg).tokens, pair: alignment }
  ])
  return {
    project: { name: '测试工程', description: 'd' },
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
}

describe('项目包导出/导入与损坏检测', () => {
  it('合法包可重新导入且核验一致', async () => {
    const data = await buildData()
    const pkg = await exportPackage(data)
    const text = JSON.stringify(pkg)
    const { report } = await importPackage(text)
    expect(report.ok).toBe(true)
    expect(verifyConsistency(pkg).ok).toBe(true)
  })

  it('JSON 损坏直接拒绝，不假装修复', async () => {
    await expect(importPackage('{not-json')).rejects.toBeInstanceOf(CorruptPackageError)
  })

  it('底本正文被篡改：指纹不符，拒绝导入', async () => {
    const data = await buildData()
    const pkg = await exportPackage(data)
    const cps = Array.from(pkg.manuscripts[0].rawText)
    cps[0] = cps[0] === 'X' ? 'Y' : 'X'
    pkg.manuscripts[0].rawText = cps.join('')
    await expect(importPackage(JSON.stringify(pkg))).rejects.toBeInstanceOf(CorruptPackageError)
  })

  it('分块被改动：分块校验和不符，拒绝恢复', async () => {
    const data = await buildData()
    const pkg = await exportPackage(data)
    const seg = pkg.pairAlignments[0].segments[0]
    seg.aRange[1] = Math.max(seg.aRange[0], seg.aRange[1] - 1)
    await expect(importPackage(JSON.stringify(pkg))).rejects.toBeInstanceOf(CorruptPackageError)
  })

  it('整体校验和不符也被识别', async () => {
    const data = await buildData()
    const pkg = await exportPackage(data)
    pkg.project.name = '被改名的工程'
    await expect(importPackage(JSON.stringify(pkg))).rejects.toBeInstanceOf(CorruptPackageError)
  })
})
