export const updateOrigin = 'https://stoneapi.me'
export const manifestUrl = `${updateOrigin}/releases/latest.json`
export const maxApkBytes = 200 * 1024 * 1024

export interface Release {
  format: 'yomi-release'
  versionName: string
  versionCode: number
  applicationId: 'app.yomi.mobile'
  minSdk: number
  url: string
  sha256: string
  size: number
  publishedAt: string
  notes: string
}

export function parseRelease(raw: unknown): Release {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('更新信息格式错误')
  const r = raw as Release
  if (r.format !== 'yomi-release' || r.applicationId !== 'app.yomi.mobile' ||
      !Number.isSafeInteger(r.versionCode) || r.versionCode < 1 ||
      typeof r.versionName !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(r.versionName) ||
      !Number.isSafeInteger(r.minSdk) || r.minSdk < 24 || r.minSdk > 100 ||
      typeof r.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(r.sha256) ||
      !Number.isSafeInteger(r.size) || r.size < 1 || r.size > maxApkBytes ||
      typeof r.notes !== 'string' || r.notes.length > 5000 ||
      typeof r.publishedAt !== 'string' || !Number.isFinite(Date.parse(r.publishedAt))) {
    throw new Error('更新信息缺少有效版本、校验值或文件大小')
  }
  const url = new URL(r.url)
  if (url.origin !== updateOrigin || url.username || url.password || url.search || url.hash ||
      !/^\/releases\/[a-zA-Z0-9._-]+\.apk$/.test(url.pathname)) throw new Error('安装包下载地址无效')
  return { format: 'yomi-release', applicationId: 'app.yomi.mobile', versionName: r.versionName,
    versionCode: r.versionCode, minSdk: r.minSdk, sha256: r.sha256, size: r.size, url: url.href,
    notes: r.notes, publishedAt: r.publishedAt }
}

export function isNewer(release: Release, installed: { versionCode: number; sdk: number }): boolean {
  return release.versionCode > installed.versionCode && release.minSdk <= installed.sdk
}
