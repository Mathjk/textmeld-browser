import { useEffect, useRef, useState } from 'react'
import { downloadFont, getFontCatalog, previewFonts, previewFontSample, searchOnlineFonts, uploadFont } from './drafts'
import type { FontCandidate, FontCatalog, FontChoice, FontFace, FontPreviews, FontScript, LayoutChoice, OnlineFontPage } from './drafts'

type Props = {
  draftId?: string
  editId?: string
  text: string
  chosen?: FontChoice
  layout?: LayoutChoice
  texture?: boolean
  disabled: boolean
  onChange: (choice?: FontChoice) => void
}

function normalize(value: string) {
  return value.normalize('NFKD').toLowerCase().replace(/[\p{M}\s\p{Pd}·.'’]+/gu, '')
}

function filterFonts<T extends Pick<FontFace, 'id' | 'label' | 'style' | 'aliases'>>(fonts: T[], query: string) {
  const compact = normalize(query)
  if (!compact) return fonts
  const terms = query.trim().split(/\s+/u).map(normalize).filter(Boolean)
  return fonts.filter((face) => {
    const fields = [face.id, face.label, face.style, ...(face.aliases ?? [])].map(normalize)
    const includes = (value: string) => fields.some((field) => field.includes(value))
    return includes(compact) || terms.every(includes)
  })
}

function formatSize(bytes: number) {
  const kb = bytes / 1024
  return kb < 1024 ? `${Math.ceil(kb)}\u00a0KB` : `${(kb / 1024).toFixed(1)}\u00a0MB`
}

export default function FontMatching({ draftId, editId, text, chosen, layout, texture, disabled, onChange }: Props) {
  const [result, setResult] = useState<FontPreviews>()
  const [catalog, setCatalog] = useState<FontCatalog & { text: string }>()
  const [previewKey, setPreviewKey] = useState('')
  const [manual, setManual] = useState<FontChoice | undefined>(chosen)
  const [manualPreview, setManualPreview] = useState<{ key: string; candidate: FontCandidate }>()
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const [onlineOpen, setOnlineOpen] = useState(false)
  const [script, setScript] = useState<FontScript>('all')
  const [page, setPage] = useState(1)
  const [online, setOnline] = useState<{ key: string; result?: OnlineFontPage; error?: string }>()
  const [onlineRetry, setOnlineRetry] = useState(0)
  const [loading, setLoading] = useState<'suggestions' | 'manual' | 'upload' | 'download'>()
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const active = useRef<AbortController | null>(null)
  const fontFile = useRef<HTMLInputElement>(null)
  const input = text.trim()
  const current = JSON.stringify([input, layout, texture])
  const inImage = Boolean(draftId && editId)
  const fonts = catalog?.fonts ?? []
  const matches = filterFonts(fonts, search)
  const query = search.trim()
  const onlineKey = JSON.stringify([query, script, page, onlineRetry])
  const onlineCurrent = online?.key === onlineKey ? online : undefined
  const pageResult = onlineCurrent?.result
  const pageCount = pageResult ? Math.ceil(pageResult.total / pageResult.page_size) : 0
  const manualFace = matches.find((face) => face.id === manual?.family)
  const missing = (face: FontFace) => catalog?.text === input ? face.missing ?? [] : []
  const manualMissing = manualFace ? missing(manualFace) : []
  const ready = manual && manualFace && manualMissing.length === 0
  const candidate = ready && manualPreview?.key === current &&
    manualPreview.candidate.id === manual.family && manualPreview.candidate.weight === manual.weight ? manualPreview.candidate : undefined
  const manualChosen = candidate && chosen?.family === candidate.id && chosen.weight === candidate.weight

  useEffect(() => () => active.current?.abort(), [])
  const catalogText = catalog?.text
  useEffect(() => {
    if (!open || loading || catalogText === input) return
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      try {
        const response = await getFontCatalog(input, controller.signal)
        if (!controller.signal.aborted) setCatalog({ ...response, text: input })
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '无法读取字体库。')
      }
    }, catalogText === undefined ? 0 : 180)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [open, loading, input, catalogText])

  useEffect(() => {
    if (!open || !onlineOpen) return
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      try {
        const result = await searchOnlineFonts(query, script, page, controller.signal)
        if (!controller.signal.aborted) setOnline({ key: onlineKey, result })
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : '无法读取 Google Fonts 目录。'
        if (!controller.signal.aborted) setOnline({ key: onlineKey, error })
      }
    }, query ? 150 : 0)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [open, onlineOpen, onlineKey, query, script, page])

  function changeSearch(value: string) {
    setSearch(value)
    setPage(1)
    setOnlineOpen(Boolean(value.trim()))
  }

  function choose(face?: FontFace) {
    setManual(face ? { family: face.id, weight: face.default_weight ?? face.weights.find((weight) => weight >= 400) ?? face.weights[0] } : undefined)
    setManualPreview(undefined)
  }

  async function load(font?: FontChoice) {
    if (disabled || active.current || !input || (!inImage && !font)) return
    const controller = new AbortController()
    active.current = controller
    setLoading(font ? 'manual' : 'suggestions')
    setError('')
    try {
      if (!(draftId && editId)) {
        if (font) {
          const sample = await previewFontSample(input, font, controller.signal)
          if (!controller.signal.aborted) setManualPreview({ key: current, candidate: sample })
        }
        return
      }
      const response = await previewFonts(draftId, editId, input, controller.signal, font, layout, texture)
      if (controller.signal.aborted) return
      const { fonts, online, online_total, max_font_bytes } = response
      setCatalog({ fonts, online, online_total, max_font_bytes, text: input })
      if (font) {
        if (!response.candidates[0]) throw new Error('所选字体没有生成预览。')
        setManualPreview({ key: current, candidate: response.candidates[0] })
      } else {
        setResult(response)
        setPreviewKey(current)
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '无法生成字体预览。')
    } finally {
      if (active.current === controller) active.current = null
      if (!controller.signal.aborted) setLoading(undefined)
    }
  }

  async function add(source: File | string) {
    if (disabled || active.current || !catalog) return
    setError('')
    setMessage('')
    const isUpload = typeof source !== 'string'
    if (isUpload && (!/\.(ttf|otf)$/i.test(source.name) || source.size > catalog.max_font_bytes)) {
      setError(`请选择 ${catalog.max_font_bytes / (1024 * 1024)} MB 以内的 TTF 或 OTF 文件。`)
      return
    }
    const controller = new AbortController()
    active.current = controller
    setLoading(isUpload ? 'upload' : 'download')
    try {
      const response = isUpload ? await uploadFont(source, input, controller.signal) : await downloadFont(source, input, controller.signal)
      if (controller.signal.aborted) return
      const face = response.fonts.find((item) => item.id === response.added_id)
      if (!face) throw new Error('字体已处理，请重新打开字体库。')
      setCatalog({ ...response, text: input })
      setSearch(face.label)
      setPage(1)
      setOnline(undefined)
      setOnlineOpen(false)
      choose(face)
      setMessage(`已添加「${face.label}」。`)
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '无法添加字体。')
    } finally {
      if (active.current === controller) active.current = null
      if (!controller.signal.aborted) setLoading(undefined)
    }
  }

  return <details className="font-matching" onToggle={(event) => {
    const expanded = event.currentTarget.open
    setOpen(expanded)
    if (expanded && !result && !loading && inImage) void load()
  }}>
    <summary>字体匹配</summary>
    <div className="font-match-body">
      {inImage && <div className="font-match-actions">
        <span>近似匹配</span>
        <button type="button" className="button button-secondary" onClick={() => void load()} disabled={disabled || Boolean(loading) || !input}>生成候选</button>
      </div>}
      {loading === 'suggestions' && <p role="status">正在生成候选预览…</p>}
      {loading === 'upload' && <p role="status">正在验证并添加字体…</p>}
      {loading === 'download' && <p role="status">正在下载字体…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {catalog && <div className="font-manual">
        <label className="font-search-label">搜索字体
          <input type="search" value={search} maxLength={96} placeholder="字体名、拼音或风格" disabled={disabled}
            onChange={(event) => changeSearch(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.preventDefault() }} />
        </label>
        <p className="font-search-status" role="status">{search.trim() ? `找到 ${matches.length} 款字体` : `共 ${fonts.length} 款字体`}</p>
        <label>手动指定字体 <select value={manualFace?.id ?? ''} disabled={disabled || Boolean(loading) || !matches.length}
          onChange={(event) => choose(matches.find((face) => face.id === event.currentTarget.value))}>
          <option value="">{matches.length ? '选择字体' : '没有匹配的字体'}</option>
          {matches.map((face) => <option key={face.id} value={face.id} disabled={missing(face).length > 0}>
            {face.label}{missing(face).length > 0 ? '（缺字）' : ''}
          </option>)}
        </select></label>
        {!matches.length && <button type="button" className="tool-button" disabled={disabled} onClick={() => changeSearch('')}>清除搜索</button>}
        {manual && manualFace && <>
          <label>字重 <select value={manual.weight} disabled={disabled || Boolean(loading)} onChange={(event) => {
            setManual({ ...manual, weight: Number(event.currentTarget.value) })
            setManualPreview(undefined)
          }}>
            {manualFace.weights.map((weight) => <option key={weight}>{weight}</option>)}
          </select></label>
          {manualMissing.length > 0 && <p>所选字体缺少「{manualMissing.slice(0, 8).join('、')}」{manualMissing.length > 8 ? '等字' : ''}。</p>}
          {!input && <p>输入新文字后即可预览。</p>}
          <button className="button button-secondary" type="button" disabled={!ready || disabled || Boolean(loading) || !input} onClick={() => void load(manual)}>
            {loading === 'manual' ? '正在预览…' : '预览指定字体'}
          </button>
        </>}
        {candidate && <figure className="font-manual-preview">
          <img src={`data:image/png;base64,${candidate.preview}`} alt={`${candidate.label}预览`} />
          <figcaption className="font-match-actions">
            <span>{candidate.label} · {candidate.weight}{!inImage && ' · 字形预览'}</span>
            <button type="button" className="button button-secondary" disabled={disabled || Boolean(loading) || manualChosen}
              onClick={() => onChange({ family: candidate.id, weight: candidate.weight })}>{manualChosen ? '已选此字体' : '使用此字体'}</button>
          </figcaption>
        </figure>}
        <div className="font-add-actions">
          <input ref={fontFile} type="file" accept=".ttf,.otf,font/ttf,font/otf" hidden aria-label="选择字体文件"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file) void add(file)
            }} />
          <button type="button" className="tool-button" disabled={disabled || Boolean(loading)} onClick={() => fontFile.current?.click()}>上传字体文件</button>
          <button type="button" className="tool-button" disabled={disabled || Boolean(loading)} aria-expanded={onlineOpen}
            onClick={() => setOnlineOpen((value) => !value)}>Google Fonts（{(catalog.online_total ?? catalog.online.length).toLocaleString('zh-CN')} 款）</button>
        </div>
        {onlineOpen && <section className="online-font-picker" aria-label="Google Fonts 下载">
          <label>文字范围 <select value={script} disabled={disabled || Boolean(loading)} onChange={(event) => {
            setScript(event.currentTarget.value as FontScript)
            setPage(1)
          }}>
            <option value="all">全部</option>
            <option value="zh">中文</option>
            <option value="zh-Hans">简体中文</option>
            <option value="zh-Hant">繁体中文</option>
            <option value="latin">英文 / 数字</option>
            <option value="japanese">日文</option>
            <option value="korean">韩文</option>
          </select></label>
          {!onlineCurrent && <p role="status">正在查找在线字体…</p>}
          {onlineCurrent?.error && <div className="font-match-actions">
            <p role="alert">{onlineCurrent.error}</p>
            <button type="button" className="tool-button" disabled={disabled}
              onClick={() => setOnlineRetry((count) => count + 1)}>重试</button>
          </div>}
          {pageResult && (pageResult.total ? <>
            <p className="font-search-status" role="status">Google Fonts 找到 {pageResult.total.toLocaleString('zh-CN')} 款</p>
            <ul className="online-fonts" aria-label="可下载的开放字体">
              {pageResult.items.map((face) => <li key={face.id}>
                <div><strong>{face.label}</strong><small>{face.style} · {formatSize(face.size_bytes)}</small></div>
                <a href={face.source_url} target="_blank" rel="noreferrer" aria-label={`${face.label}的来源与许可`}>来源</a>
                <button type="button" className="button button-secondary" disabled={disabled || Boolean(loading) || face.installed}
                  aria-label={`${face.installed ? '已添加' : '下载'}${face.label}`}
                  onClick={() => void add(face.id)}>{face.installed ? '已添加' : '下载'}</button>
              </li>)}
            </ul>
            {pageCount > 1 && <nav className="font-match-actions font-pagination" aria-label="在线字体分页">
              <button type="button" className="tool-button" disabled={page === 1 || Boolean(loading) || disabled}
                onClick={() => setPage((number) => number - 1)}>上一页</button>
              <span>{page} / {pageCount}</span>
              <button type="button" className="tool-button" disabled={page === pageCount || Boolean(loading) || disabled}
                onClick={() => setPage((number) => number + 1)}>下一页</button>
            </nav>}
          </> : <p>这个范围内没有匹配的在线字体。</p>)}
        </section>}
      </div>}
      {result && <>
        {previewKey !== current && <p>文案或文字设置已调整，重新生成可更新预览。</p>}
        <figure className="font-original">
          <img src={`data:image/png;base64,${result.original}`} alt="原文字局部" />
          <figcaption>原文字</figcaption>
        </figure>
        {!result.candidates.length && <p>当前文案没有可预览的近似字体。可在上方手动选择。</p>}
        {result.candidates.length > 0 && <ul className="font-candidates">
          {result.candidates.map((candidate) => <li key={candidate.id}>
            <button type="button" disabled={disabled || Boolean(fonts.some((face) => face.id === candidate.id && missing(face).length))} className="font-candidate"
              aria-pressed={chosen?.family === candidate.id && chosen.weight === candidate.weight}
              onClick={() => onChange({ family: candidate.id, weight: candidate.weight })}>
              <img src={`data:image/png;base64,${candidate.preview}`} alt="" />
              <strong>{candidate.label} · {candidate.weight}</strong><small>{candidate.style}</small>
            </button>
          </li>)}
        </ul>}
      </>}
      {chosen && <div className="font-match-actions">
        <span>已选 {fonts.find((face) => face.id === chosen.family)?.label ?? chosen.family} · {chosen.weight}</span>
        <button className="tool-button" type="button" disabled={disabled} onClick={() => onChange()}>恢复默认字体</button>
      </div>}
    </div>
  </details>
}
