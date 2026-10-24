export async function readImageThumbnail(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('请选择 PNG、JPG 或 WebP 头像')
  if (file.size > 2_000_000) throw new Error('头像图片不能超过 2 MB')
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('无法读取头像图片'))
    reader.readAsDataURL(file)
  })
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const side = Math.min(image.width, image.height)
      if (!side) { reject(new Error('头像图片尺寸无效')); return }
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = Math.min(256, side)
      const context = canvas.getContext('2d')
      if (!context) { reject(new Error('无法处理头像图片')); return }
      context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side,
        0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/png'))
    }
    image.onerror = () => reject(new Error('头像图片无法解码，请换一张图片'))
    image.src = dataUrl
  })
}
