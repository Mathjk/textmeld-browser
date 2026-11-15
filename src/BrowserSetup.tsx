import { useEffect, useState } from 'react'
import { initializeModels, modelsDownloaded } from './browser/runtime'

export default function BrowserSetup({ ready, onReady }: { ready: boolean; onReady: () => void }) {
  const [checking, setChecking] = useState(true)
  const [progress, setProgress] = useState<{ label: string; value: number }>()
  const [error, setError] = useState('')
  useEffect(() => {
    let mounted = true
    void modelsDownloaded().then((cached) => {
      if (!mounted) return
      if (cached) onReady()
      setChecking(false)
    })
    return () => { mounted = false }
  }, [onReady])

  async function download() {
    setError('')
    setProgress({ label: '正在准备识别资源…', value: 0 })
    try {
      await initializeModels((label, value) => setProgress({ label, value }))
      onReady()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '资源下载失败。')
    } finally {
      setProgress(undefined)
    }
  }

  if (ready) return null
  return <section className="resource-notice panel" aria-label="首次准备识别资源">
    <div>
      <strong>先下载识别资源</strong>
      <p>模型和浏览器运行库约 53 MiB。下载后，图片会在此设备处理。</p>
      {progress && <p role="status">{progress.label} {Math.round(progress.value * 100)}%</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
    <button type="button" className="button button-primary" disabled={checking || Boolean(progress)}
      onClick={() => void download()}>{error ? '重试下载' : '下载识别资源'}</button>
  </section>
}
