// 稳定 id 生成（无第三方依赖）

let counter = 0

export function rid(prefix: string): string {
  counter += 1
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`
}

export function resetIdCounterForTest(): void {
  counter = 0
}

/** 由字符串内容生成短 hash（FNV-1a，32 位），用于分块校验等非安全场景 */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
