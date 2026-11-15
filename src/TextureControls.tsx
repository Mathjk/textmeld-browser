import { useEffect, useRef, useState } from 'react'
import { previewTexture } from './drafts'
import type { TextStyle, TexturePreview, TextureStatus } from './drafts'
import type { ProviderSelection } from './api'

export const textureStatus: Record<TextureStatus, string> = {
  applied: '已匹配原字边缘的柔和度。',
  similar: '新字的边缘已接近原图。',
  unchanged: '本次沿用普通渲染，字边不需要或不适合再柔化。',
}

type Props = {
  draftId?: string
  editId?: string
  text: string
  style: TextStyle
  providers?: ProviderSelection
  disabled: boolean
  onChange: (enabled: boolean) => void
}

export default function TextureControls({ draftId, editId, text, style, providers, disabled, onChange }: Props) {
  const [result, setResult] = useState<{ key: string; images: TexturePreview }>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const active = useRef<AbortController | null>(null)
  const key = JSON.stringify([draftId, editId, text.trim(), style.font, style.layout, style.orientation, providers?.render])

  useEffect(() => () => active.current?.abort(), [])

  async function load() {
    if (!draftId || !editId || !text.trim() || active.current) return
    const controller = new AbortController()
    active.current = controller
    setLoading(true)
    setError('')
    try {
      const images = await previewTexture(draftId, editId, text.trim(), style, providers, controller.signal)
      if (!controller.signal.aborted) setResult({ key, images })
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '无法生成字边预览。')
    } finally {
      active.current = null
      if (!controller.signal.aborted) setLoading(false)
    }
  }

  const images = result?.key === key ? result.images : undefined
  return <details className="font-matching texture-controls">
    <summary>字体质感</summary>
    <div className="font-match-body">
      <label className="layout-toggle">
        <input type="checkbox" checked={Boolean(style.texture)} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} />匹配原字边缘
      </label>
      {draftId && editId ? <button className="button button-secondary" type="button" disabled={disabled || loading || !text.trim()}
        onClick={() => void load()}>{loading ? '正在预览…' : '预览字边对比'}</button>
        : <p>应用当前选区后，即可预览普通与匹配效果。</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {images && <>
        <p role="status">{images.status === 'applied' ? '预览已对齐原字边缘，勾选后可应用。' : textureStatus[images.status]}</p>
        <div className="texture-previews">
          {([['original', '原字'], ['normal', '普通'], ['matched', '匹配']] as const).map(([field, label]) =>
            <figure key={field}><img src={`data:image/png;base64,${images[field]}`} alt={`${label}局部`} /><figcaption>{label}</figcaption></figure>)}
        </div>
      </>}
    </div>
  </details>
}
