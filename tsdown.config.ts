import { clientBundle } from './build/tsdown.client.ts'

export default clientBundle('dsh-unreal', ['lib/index.js'], { hostPhase: true })
