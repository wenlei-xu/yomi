import { Capacitor } from '@capacitor/core'
import { SecureVault } from './nativeBridge'

/** Remove an already closed private Android database, including a corrupt one. */
export async function removeClosedDatabase(name: string): Promise<boolean> {
  if (Capacitor.getPlatform() !== 'android') return false
  await SecureVault.removeDatabaseFile({ name })
  return true
}
