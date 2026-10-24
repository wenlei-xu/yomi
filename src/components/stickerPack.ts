import type { AppApi } from '../app/bootstrap'
import type { Sticker } from '../domain/types'

export async function saveFavoriteSticker(app: Pick<AppApi, 'stickers' | 'saveSticker'>, name: string, dataUrl: string): Promise<Sticker> {
  const favorites = await app.stickers()
  const existing = favorites.find(sticker => sticker.dataUrl === dataUrl)
  if (existing) return existing
  if (favorites.length >= 200) throw new Error('最多收藏 200 个表情，请先在管理中删除一些')
  return app.saveSticker(name.trim().slice(0, 60) || '收藏表情', dataUrl)
}

export async function readStickerFile(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 1_000_000) {
    throw new Error('请选择 1 MB 以内的 PNG、JPG、WebP 或 GIF 图片')
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
}
