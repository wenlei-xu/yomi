import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import version from '../../version.json'
import { manifestUrl, parseRelease, type Release } from './manifest'

export interface InstalledVersion { versionName: string; versionCode: number; sdk: number; debug: boolean }
export interface DownloadProgress { requestId: string; bytes: number; total: number }
export interface WebUpdateStatus { activeVersion: number; pendingVersion: number; rolledBack: boolean; skippedNetwork?: boolean }
interface UpdateBridge {
  webStatus(): Promise<WebUpdateStatus>
  syncWeb(): Promise<WebUpdateStatus>
  confirmWeb(): Promise<void>
  rollbackWeb(): Promise<void>
  info(): Promise<InstalledVersion>
  check(): Promise<{ body: string }>
  download(options: { release: Release; requestId: string }): Promise<void>
  cancel(options: { requestId: string }): Promise<void>
  ready(): Promise<{ release?: Release }>
  install(): Promise<{ permissionRequired: boolean }>
  addListener(event: 'progress', listener: (progress: DownloadProgress) => void): Promise<PluginListenerHandle>
}
export const Updater = registerPlugin<UpdateBridge>('YomiUpdater')
export const androidUpdates = () => Capacitor.getPlatform() === 'android'

export async function installedVersion(): Promise<InstalledVersion> {
  return androidUpdates() ? Updater.info() : { ...version, sdk: 100, debug: true }
}

export async function latestRelease(): Promise<Release> {
  if (androidUpdates()) return parseRelease(JSON.parse((await Updater.check()).body))
  const response = await fetch(manifestUrl, { cache: 'no-store', signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(response.status === 403 || response.status === 404
    ? '更新文件尚未发布或未开放读取，请稍后重试' : `更新服务暂不可用（${response.status}）`)
  const body = await response.text()
  if (new TextEncoder().encode(body).length > 64 * 1024) throw new Error('更新信息超过大小限制')
  return parseRelease(JSON.parse(body))
}
