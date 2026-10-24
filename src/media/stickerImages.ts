type DecodedFrame = CanvasImageSource & { displayWidth: number; displayHeight: number; close(): void }
type Decoder = {
  tracks: { ready: Promise<void>; selectedTrack?: { frameCount: number } }
  decode(options: { frameIndex: number }): Promise<{ image: DecodedFrame }>
  close(): void
}
type DecoderConstructor = new (options: { data: Uint8Array; type: string }) => Decoder

function thumbnail(image: CanvasImageSource, width: number, height: number): string {
  if (!width || !height || width * height > 16_000_000) throw new Error('表情图片尺寸过大，无法识别')
  const scale = Math.min(1, 640 / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法读取表情图片')
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', .85)
}

export async function prepareStickerImages(dataUrl: string, signal: AbortSignal = new AbortController().signal): Promise<string[]> {
  signal.throwIfAborted()
  if (dataUrl.length > 1_500_000) throw new Error('表情图片尺寸过大，无法识别')
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,/.exec(dataUrl)
  if (!match) throw new Error('不支持这个表情图片格式')
  const bytes = Uint8Array.from(atob(dataUrl.slice(match[0].length)), character => character.charCodeAt(0))
  const ImageDecoder = (globalThis as unknown as { ImageDecoder?: DecoderConstructor }).ImageDecoder
  if (match[1] === 'image/gif' || (match[1] === 'image/webp' && ImageDecoder)) {
    if (!ImageDecoder) throw new Error('当前系统不支持动图识别，仍可正常发送此表情')
    if (match[1] === 'image/gif' && bytes.length >= 10 && ((bytes[6] | bytes[7] << 8) * (bytes[8] | bytes[9] << 8)) > 16_000_000) throw new Error('动图尺寸过大，无法识别')
    const decoder = new ImageDecoder({ data: bytes, type: match[1] })
    const abort = () => decoder.close()
    signal.addEventListener('abort', abort, { once: true })
    try {
      await decoder.tracks.ready
      signal.throwIfAborted()
      const count = decoder.tracks.selectedTrack?.frameCount ?? 1
      if (count > 300) throw new Error('动图帧数过多，暂不自动识别')
      const indexes = [...new Set([0, Math.floor((count - 1) / 2), count - 1])]
      const images: string[] = []
      for (const frameIndex of indexes) {
        signal.throwIfAborted()
        const { image } = await decoder.decode({ frameIndex })
        try { images.push(thumbnail(image, image.displayWidth, image.displayHeight)) }
        finally { image.close() }
      }
      return images
    } finally { signal.removeEventListener('abort', abort); decoder.close() }
  }
  const image = new Image()
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
    const abort = () => { cleanup(); image.src = ''; reject(new Error('cancelled')) }
    const timer = setTimeout(() => { cleanup(); image.src = ''; reject(new Error('图片读取超时')) }, 10000)
    signal.addEventListener('abort', abort, { once: true })
    image.onload = () => { cleanup(); resolve() }
    image.onerror = () => { cleanup(); reject(new Error('图片无法读取，仍可正常收藏')) }
    image.src = dataUrl
  })
  return [thumbnail(image, image.naturalWidth, image.naturalHeight)]
}
