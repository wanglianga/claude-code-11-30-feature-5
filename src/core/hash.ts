// 文件指纹与完整性校验（SHA-256，浏览器 WebCrypto；Node 测试同样可用）

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function fingerprint(rawText: string): Promise<string> {
  return sha256Hex(rawText)
}

/** 项目包整体校验：对规范化后的 JSON 载荷再取一次哈希 */
export async function checksumOf(value: unknown): Promise<string> {
  return sha256Hex(stableStringify(value))
}

/** 键排序的稳定 JSON 序列化，保证同内容同哈希；undefined 语义与 JSON 对齐（对象省略、数组为 null） */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
