import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'

interface NativeBridge {
  addListener(event: 'requestChunk', callback: (event: {requestId: string; chunk: string}) => void): Promise<PluginListenerHandle>
  set(options: { providerId: string; secret: string; origin: string }): Promise<{ stored: boolean }>
  setWithoutSecret(options: { providerId: string; secret: string; origin: string }): Promise<{ stored: boolean }>
  status(options: { providerId: string }): Promise<{ stored: boolean }>
  remove(options: { providerId: string }): Promise<{ removed: boolean }>
  copyCredential(options: { sourceId: string; providerId: string; origin: string }): Promise<{ stored: boolean }>
  request(options: { requestId: string; providerId: string; url: string; body: string; method?: 'GET' | 'POST'; binary?: boolean; stream?: boolean }): Promise<{ status: number; body: string; binary?: boolean; contentType?: string }>
  cancel(options: { requestId: string }): Promise<{ cancelled: boolean }>
  removeDatabaseFile(options: { name: string }): Promise<{ removed: boolean }>
}

export const SecureVault = registerPlugin<NativeBridge>('SecureVault')
