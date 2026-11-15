// 虚构古文转写样例（不接 OCR / 外部模型，全部为人工编写的本地数据）。
// 转写约定：\f 分页，\n 分行，〖篇：名〗 为篇章标记；其余码点原样保留。
// 覆盖情形：
//  1) 异体归一：乙本「旹」对甲本「時」；丙本「无/饱」对「無/飽」
//  2) 连续缺句：乙本整句缺「有朋自遠方來」，且行款与甲本错位
//  3) 重复短句歧义：甲本「溫故而知新」重出两次，乙本仅存一次 → 同分对齐需人工确认
//  4) 整段迁移：丙本把「君子食無求飽……」一段移至篇末
//  5) 新版本插字：丁本后到，「時時習之」「遠方而來」为新增字
import type { Manuscript } from './types'
import { buildManuscript } from './pipeline'

export interface SampleManuscriptInput {
  id: string
  name: string
  note: string
  rawText: string
}

const JIA = `〖篇：勸學〗
學而時習之，不亦說乎。有朋自遠方來，
樂亦在其中矣。三人行，必有我師焉。
擇其善者而從之，其不善者而改之。
君子食無求飽，居無求安，敏於事而慎於言。\f道可道，非常道。名可名，非常名。
溫故而知新。溫故而知新，可以為師矣。`

const YI = `〖篇：勸學〗
學而旹習之，不亦說乎。
樂亦在其閒矣。三人行，必有我師焉。
擇其善者而從之，其不善者而改之。
君子食無求飽，居無求安，敏於事而慎於言。\f道可道，非常道。名可名，非常名。
溫故而知新，可以為師矣。`

const BING = `〖篇：勸學〗
學而時習之，不亦說乎。有朋自遠方來，
樂亦在其中矣。三人行，必有我師焉。
擇其善者而從之，其不善者而改之。\f道可道，非常道。名可名，非常名。
溫故而知新。溫故而知新，可以為師矣。
君子食无求饱，居无求安，敏於事而慎於言。`

const DING = `〖篇：勸學〗
學而時時習之，不亦說乎。有朋自遠方而來，
樂亦在其中矣。三人行，必有我師焉。
擇其善者而從之，其不善者而改之。
君子食無求飽，居無求安，敏於事而慎於言。\f道可道，非常道。名可名，非常名。
溫故而知新。溫故而知新，可以為師矣。`

export const SAMPLE_INPUTS: SampleManuscriptInput[] = [
  {
    id: 'ms-jia',
    name: '甲本',
    note: '虛構明刊本，描潤工整，存全篇兩頁；選為參考本。',
    rawText: JIA
  },
  {
    id: 'ms-yi',
    name: '乙本',
    note: '虛構抄本，字體夾雜異寫（旹＝時）；脫「有朋自遠方來」一句，「溫故而知新」僅存一見。',
    rawText: YI
  },
  {
    id: 'ms-bing',
    name: '丙本',
    note: '虛構坊刻本，「君子食無求飽」一段移置篇末；「無」作「无」、「飽」作「饱」。',
    rawText: BING
  },
  {
    id: 'ms-ding',
    name: '丁本',
    note: '後到新本：首句衍一「時」字，「遠方來」作「遠方而來」，其餘近甲本。',
    rawText: DING
  }
]

export async function buildSampleManuscripts(): Promise<Manuscript[]> {
  const out: Manuscript[] = []
  for (const s of SAMPLE_INPUTS) {
    out.push(await buildManuscript(s.id, s.name, s.note, s.rawText))
  }
  return out
}
