import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'app.yomi.mobile',
  appName: 'Yomi',
  webDir: 'dist',
  loggingBehavior: 'none',
  android: { allowMixedContent: false },
  server: { androidScheme: 'https' }
}

export default config
