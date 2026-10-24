const iterations = 310_000
const header = 'yomi-encrypted-backup:1:PBKDF2-SHA256:AES-256-GCM'
const encoder = new TextEncoder()

function encode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(binary)
}

function decode(value: unknown, maxBytes: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes * 4 / 3) + 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('加密备份数据无效')
  try { return Uint8Array.from(atob(value), char => char.charCodeAt(0)) }
  catch { throw new Error('加密备份数据无效') }
}

async function key(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const source = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, source,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

export async function encryptBackup(data: unknown, password: string): Promise<string> {
  if (password.length < 8 || password.length > 1024) throw new Error('备份密码需为 8–1024 个字符')
  const plaintext = encoder.encode(JSON.stringify(data))
  if (plaintext.length > 99_999_984) throw new Error('单个备份模块超过 100 MB，请减少数据后重试')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
    additionalData: encoder.encode(header), tagLength: 128 }, await key(password, salt), plaintext)
  return JSON.stringify({ format: 'yomi-encrypted-backup', version: 1, kdf: 'PBKDF2-SHA256',
    iterations, cipher: 'AES-256-GCM', salt: encode(salt), iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) })
}

export async function decryptBackup(raw: string, password?: string): Promise<unknown> {
  if (raw.length > 150_000_000) throw new Error('备份文件过大，暂不支持超过 150 MB 的文件')
  let envelope: Record<string, unknown>
  try { envelope = JSON.parse(raw) } catch { throw new Error('备份不是有效 JSON') }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('备份格式无效')
  // Older plaintext backups remain readable, but newly exported backups are encrypted.
  if (envelope.format === 'yomi-backup') return envelope
  if (envelope.format !== 'yomi-encrypted-backup' || envelope.version !== 1 ||
      envelope.kdf !== 'PBKDF2-SHA256' || envelope.iterations !== iterations || envelope.cipher !== 'AES-256-GCM') {
    throw new Error('不支持的加密备份格式')
  }
  if (!password || password.length > 1024) throw new Error('请输入此备份的密码')
  const salt = decode(envelope.salt, 16), iv = decode(envelope.iv, 12)
  const ciphertext = decode(envelope.ciphertext, 100_000_000)
  if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16) throw new Error('加密备份数据无效')
  let plaintext: ArrayBuffer
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(header),
      tagLength: 128 }, await key(password, salt), ciphertext)
  } catch { throw new Error('备份密码不正确，或文件已损坏') }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) }
  catch { throw new Error('备份内容无效') }
}
