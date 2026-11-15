import { useLayoutEffect, useRef, useState } from 'react'
import type { ProviderOptions, ProviderSelection } from './api'
import Icon from './Icon'

export const localProviders: ProviderSelection = { ocr: 'local', inpaint: 'local', render: 'pillow' }
const storageKey = 'textmeld.providers.v1'

export function readProviders(): ProviderSelection | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Partial<ProviderSelection> | null
    if (saved && (saved.ocr === 'local' || saved.ocr === 'tencent') &&
        (saved.inpaint === 'local' || saved.inpaint === 'dashscope') &&
        (saved.render === 'pillow' || saved.render === 'pillow-sans' || saved.render === 'pillow-serif')) {
      return { ocr: saved.ocr, inpaint: saved.inpaint, render: saved.render }
    }
  } catch {
    // Storage may be disabled by the browser.
  }
}

export function rememberProviders(providers: ProviderSelection): boolean {
  try {
    localStorage.setItem(storageKey, JSON.stringify(providers))
    return true
  } catch {
    return false
  }
}

export function availableProviders(options: ProviderOptions, choice: ProviderSelection): ProviderSelection {
  const { available } = options
  return {
    ocr: available.ocr.includes(choice.ocr) ? choice.ocr : localProviders.ocr,
    inpaint: available.inpaint.includes(choice.inpaint) ? choice.inpaint : localProviders.inpaint,
    render: available.render.includes(choice.render) ? choice.render : localProviders.render,
  }
}

type Props = {
  options?: ProviderOptions | null
  current?: ProviderSelection
  onSave: (choice: ProviderSelection) => void
  onClose: () => void
}

export default function ProviderSettings({ options, current, onSave, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [choice, setChoice] = useState(current ?? localProviders)
  useLayoutEffect(() => {
    const element = dialog.current
    if (!element) return
    element.showModal()
    return () => element.close()
  }, [])

  function change<Key extends keyof ProviderSelection>(name: Key, value: ProviderSelection[Key]) {
    setChoice((previous) => ({ ...previous, [name]: value }))
  }

  return <dialog
    ref={dialog} className="settings-dialog panel" aria-labelledby="settings-title"
    onCancel={(event) => { event.preventDefault(); onClose() }}
  >
    <div className="panel-header">
      <h2 id="settings-title"><Icon name="settings" />处理设置</h2>
      <button type="button" className="tool-button icon-only" onClick={onClose} aria-label="关闭设置"><Icon name="close" /></button>
    </div>
    {options ? <form onSubmit={(event) => {
      event.preventDefault()
      onSave(availableProviders(options, choice))
    }}>
      <div className="settings-body">
        <div className="setting-row"><span>文字识别</span><span>浏览器 · RapidOCR</span></div>
        <div className="setting-row"><span>底图修补</span><span>浏览器 · OpenCV</span></div>
        <div className="setting-row">
          <label htmlFor="provider-render">文字渲染</label>
          <select id="provider-render" value={choice.render} onChange={(event) => change('render', event.currentTarget.value as ProviderSelection['render'])}>
            <option value="pillow">系统黑体（默认）</option>
            <option value="pillow-sans">系统黑体</option>
            <option value="pillow-serif">系统宋体</option>
          </select>
        </div>
        <p className="settings-hint">本地模块免费使用，无需密钥。设置保存在此浏览器，下次生成时生效。</p>

      </div>
      <div className="settings-footer">
        <button className="button button-secondary" type="button" onClick={() => setChoice(localProviders)}>恢复本地默认</button>
        <button className="button button-primary" type="submit">保存设置</button>
      </div>
    </form> : <div className="settings-body">
      <p className="settings-hint">用本地处理模式启动当前版本后，即可配置处理模块。</p>
    </div>}
  </dialog>
}
