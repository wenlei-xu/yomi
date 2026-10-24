import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

interface ProactiveBridge {
  start(): Promise<void>
  stop(): Promise<void>
  status(): Promise<{ running: boolean }>
  notifyMessage(input: { title: string }): Promise<void>
  addListener(event: 'tick' | 'stopped', callback: () => void): Promise<PluginListenerHandle>
}
export const Proactive = registerPlugin<ProactiveBridge>('Proactive')
export const backgroundSupported = () => Capacitor.getPlatform() === 'android'
