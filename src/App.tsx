import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent, FormEvent } from 'react'
import { defaultLimits, followTask, getHealth, getResult, getTask, RequestError } from './api'
import type { Health, Mode, ProviderSelection, Task } from './api'
import { applyEdit, createDraft, downloadFont, getDraft, newOperation, previewFontSample, readSavedDraft, removeDraft, removeEdit, saveDraftLocally, scan } from './drafts'
import type { Draft, DraftEdit, FontChoice, LayoutChoice, PendingEdit, SavedDraft, TextOrientation } from './drafts'
import { makeMask, prepareImage } from './image'
import type { Mark, SourceImage, Tool } from './image'
import Icon from './Icon'
import FontMatching from './FontMatching'
import ImageStage from './ImageStage'
import BrowserSetup from './BrowserSetup'
import { usesOriginalPositions } from './browser/spacing'
import TextureControls, { textureStatus } from './TextureControls'
import ProviderSettings, { availableProviders, readProviders, rememberProviders } from './ProviderSettings'
import './styles.css'

const modeNames: Record<Mode, string> = { mock: 'Mock 演示', local: '本地处理', cloud: '云端处理' }
const stageNames: Record<Task['stage'], string> = {
  queued: '正在排队', ocr: '正在识别原文字', inpaint: '正在擦除原字和修补背景',
  render: '正在绘制新文字', mock: '正在生成演示结果', done: '处理完成', failed: '处理失败',
}
const tools = [
  { id: 'rectangle', label: '框选', icon: 'rectangle' },
  { id: 'brush', label: '画笔', icon: 'brush' },
  { id: 'pan', label: '移动', icon: 'hand' },
] as const
const zoomLevels = [1, 1.25, 1.5, 2, 3, 4]
const maxMarkHistory = 50

function useObjectUrl(blob: Blob | undefined) {
  const [value, setValue] = useState<{ blob: Blob; url: string }>()
  useEffect(() => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    setValue({ blob, url })
    return () => URL.revokeObjectURL(url)
  }, [blob])
  return value?.blob === blob ? value?.url : undefined
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.name !== 'TypeError' ? error.message : fallback
}

function reopenError(error: unknown) {
  return error instanceof RequestError && (error.status === 404 || error.status === 410)
}

function sameMarks(a: Mark[], b: Mark[]) {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

function hasFile(event: DragEvent) {
  return Array.from(event.dataTransfer.types).includes('Files')
}

export default function App() {
  const [health, setHealth] = useState<Health>()
  const [serviceDown, setServiceDown] = useState(false)
  const [upgradeNotice, setUpgradeNotice] = useState('')
  const [healthAttempt, setHealthAttempt] = useState(0)
  const [preferences, setPreferences] = useState(readProviders)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsNotice, setSettingsNotice] = useState('')
  const [image, setImage] = useState<SourceImage>()
  const [draft, setDraft] = useState<Draft>()
  const [draftId, setDraftId] = useState<string>()
  const [selected, setSelected] = useState<string>()
  const [font, setFont] = useState<FontChoice>()
  const [layout, setLayout] = useState<LayoutChoice>()
  const [orientation, setOrientation] = useState<TextOrientation>('horizontal')
  const [texture, setTexture] = useState(false)
  const [pending, setPending] = useState<PendingEdit>()
  const [hydrated, setHydrated] = useState(false)
  const [syncAttempt, setSyncAttempt] = useState(0)
  const [draftNotice, setDraftNotice] = useState('')
  const [storageError, setStorageError] = useState(false)
  const [loadingImage, setLoadingImage] = useState(false)
  const [tool, setTool] = useState<Tool>('rectangle')
  const [brushSize, setBrushSize] = useState(36)
  const [zoomIndex, setZoomIndex] = useState(0)
  const [history, setHistory] = useState<Mark[][]>([[]])
  const [text, setText] = useState('')
  const [uploading, setUploading] = useState<number | null>(null)
  const [readingResult, setReadingResult] = useState(false)
  const [task, setTask] = useState<Task>()
  const [result, setResult] = useState<Blob>()
  const [compare, setCompare] = useState(false)
  const [imageError, setImageError] = useState('')
  const [taskError, setTaskError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [modelsReady, setModelsReady] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState<{ key: string; original: string; fonts: { id: string; name: string; size: number; installed: boolean }[] }>()
  const [addingFont, setAddingFont] = useState<string>()
  const [scanPreview, setScanPreview] = useState<{ key: string; sample: string; label: string; image: string }>()
  const [scanError, setScanError] = useState('')
  const filePicker = useRef<HTMLInputElement>(null)
  const editorPanel = useRef<HTMLElement>(null)
  const request = useRef<AbortController | null>(null)
  const loadSequence = useRef(0)
  const dragDepth = useRef(0)

  const limits = health?.limits ?? defaultLimits
  const sourceUrl = useObjectUrl(image?.blob)
  const resultUrl = useObjectUrl(result)
  const providerOptions = health?.providers
  const providers = providerOptions
    ? (preferences ? availableProviders(providerOptions, preferences) : providerOptions.defaults)
    : undefined
  const currentMode = providers
    ? (providers.ocr !== 'local' || providers.inpaint !== 'local' ? 'cloud' : 'local')
    : health?.mode
  const providerNotice = providers && preferences && (providers.ocr !== preferences.ocr || providers.inpaint !== preferences.inpaint)
    ? '此前选择的云服务当前未配置，对应模块将使用本地处理。'
    : settingsNotice
  const marks = history.at(-1)!
  const scanKey = JSON.stringify([sourceUrl, marks, orientation])
  const recommendation = scanResult?.key === scanKey ? scanResult : undefined
  const markModelsReady = useCallback(() => setModelsReady(true), [])
  const draftsEnabled = Boolean(health?.drafts)
  const activeEdit = draft?.edits.find((edit) => edit.id === selected)
  const useSavedSelection = activeEdit && sameMarks(activeEdit.marks, marks) && (activeEdit.orientation ?? 'horizontal') === orientation
  const replacement = text.trim()
  const characterLayout = useSavedSelection && usesOriginalPositions(activeEdit.original, replacement)
  const preservePositions = layout?.mode !== 'natural'
  const busy = uploading !== null || readingResult || (!taskError && (task?.status === 'queued' || task?.status === 'processing'))
  const locked = busy || loadingImage || !hydrated
  const textCount = Array.from(text).length
  const maxBrushSize = image ? Math.max(1, Math.min(200, Math.min(image.width, image.height))) : 200
  const missingPreview = draftsEnabled && Boolean(draft?.result_url) && !resultUrl
  const canSubmit = Boolean(health && modelsReady && image && marks.length && text.trim() && textCount <= limits.max_text && !locked && !scanning && !addingFont && (!missingPreview || pending) &&
    (!draftsEnabled || !draftId || draft))
  const matchesAppliedEdit = Boolean(resultUrl && activeEdit && useSavedSelection && !activeEdit.layout_refresh_available &&
    activeEdit.text === text.trim() && activeEdit.font?.family === font?.family && activeEdit.font?.weight === font?.weight &&
    (activeEdit.layout?.spacing ?? 0) === (layout?.spacing ?? 0) && activeEdit.layout?.mode === layout?.mode &&
    Boolean(activeEdit.texture) === texture &&
    (font || activeEdit.providers.render === providers?.render))
  const advancedType = health?.typography === true
  const textStyle = { font, layout, orientation: advancedType ? orientation : undefined, texture: advancedType ? texture : undefined }
  const editApplied = matchesAppliedEdit && !pending && !taskError

  const persist = useCallback(async (value?: SavedDraft) => {
    try {
      await saveDraftLocally(value)
      setStorageError(false)
    } catch {
      setStorageError(true)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    getHealth(controller.signal)
      .then((status) => {
        if (controller.signal.aborted) return
        setHealth(status)
        setUpgradeNotice('')
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setServiceDown(true)
        setUpgradeNotice(error instanceof RequestError && error.status === 409 ? error.message : '')
      })
    return () => controller.abort()
  }, [healthAttempt])

  useEffect(() => () => {
    request.current?.abort()
    loadSequence.current += 1
  }, [])

  useEffect(() => {
    let cancelled = false
    readSavedDraft().then((saved) => {
      if (!saved || cancelled) return
      setImage(saved.image)
      setDraftId(saved.draftId)
      setSelected(saved.selected)
      setHistory([saved.marks])
      setText(saved.text)
      setPending(saved.pending)
      setFont(saved.font)
      setLayout(saved.layout)
      setOrientation(saved.orientation ?? 'horizontal')
      setTexture(saved.texture ?? false)
    }).catch(() => { if (!cancelled) setStorageError(true) })
      .finally(() => { if (!cancelled) setHydrated(true) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (hydrated && image) void persist({ image, draftId, selected, marks, text, pending, font, layout, orientation, texture })
  }, [hydrated, image, draftId, selected, marks, text, pending, font, layout, orientation, texture, persist])

  useEffect(() => {
    if (!draftsEnabled || !draftId || request.current) return
    const controller = new AbortController()
    const signal = controller.signal
    request.current = controller
    setReadingResult(true)
    async function restore(id: string) {
      try {
        let saved = await getDraft(id, signal)
        const running = pending?.taskId ?? saved.pending_task_id
        if (running) {
          try {
            const restoredTask = await followTask(await getTask(running, signal), signal, setTask)
            if (restoredTask.status === 'failed') setTaskError(restoredTask.error?.message ?? '上次改动处理失败。')
          } catch (error) {
            if (!reopenError(error)) throw error
          }
          saved = await getDraft(id, signal)
        }
        if (signal.aborted) return
        setDraft(saved)
        setResult(undefined)
        setCompare(false)
        if (pending && saved.last_operation_id === pending.operationId) setSelected(saved.last_edit_id ?? undefined)
        if (!pending || saved.last_operation_id === pending.operationId || !saved.pending_task_id) setPending(undefined)
        setTask(undefined)
        setDraftNotice('草稿已恢复。')
        if (saved.result_url) {
          const blob = await getResult(saved.result_url, signal)
          setResult(blob)
          setCompare(!selected || Boolean(pending))
        }
      } catch (error) {
        if (signal.aborted) return
        if (reopenError(error)) {
          setDraft(undefined)
          setDraftId(undefined)
          setSelected(undefined)
          setPending(undefined)
          setResult(undefined)
          setDraftNotice('服务端草稿已过期。原图和当前输入已恢复，可以重新应用。')
        } else {
          setTaskError(errorMessage(error, '草稿暂时无法同步，请重试。'))
        }
      } finally {
        if (!signal.aborted) setReadingResult(false)
        if (request.current === controller) request.current = null
      }
    }
    void restore(draftId)
    return () => {
      controller.abort()
      if (request.current === controller) {
        request.current = null
        setReadingResult(false)
      }
    }
    // Restoration runs on opening a server draft or on an explicit retry.
  }, [draftId, draftsEnabled, syncAttempt])

  const clearTaskFeedback = useCallback(() => {
    setTask(undefined)
    setTaskError('')
    setCompare(false)
    setPending(undefined)
    if (!draftsEnabled) setResult(undefined)
  }, [draftsEnabled])

  const load = useCallback(async (file: File) => {
    if (busy || request.current) return
    const sequence = ++loadSequence.current
    setLoadingImage(true)
    setImageError('')
    try {
      const prepared = await prepareImage(file, limits)
      if (sequence !== loadSequence.current) return
      setImage(prepared)
      setDraft(undefined)
      setDraftId(undefined)
      setSelected(undefined)
      setFont(undefined)
      setLayout(undefined)
      setOrientation('horizontal')
      setTexture(false)
      setPending(undefined)
      setDraftNotice('')
      setResult(undefined)
      setHistory([[]])
      setTool('rectangle')
      setZoomIndex(0)
      setBrushSize(Math.max(1, Math.min(200, Math.round(Math.min(prepared.width, prepared.height) / 18))))
      setText('')
      clearTaskFeedback()
    } catch (error) {
      if (sequence === loadSequence.current) setImageError(errorMessage(error, '无法读取这张图片。'))
    } finally {
      if (sequence === loadSequence.current) setLoadingImage(false)
    }
  }, [busy, clearTaskFeedback, limits])

  useEffect(() => {
    function paste(event: ClipboardEvent) {
      const file = Array.from(event.clipboardData?.files ?? []).find((item) => item.type.startsWith('image/'))
      if (!file || locked) return
      event.preventDefault()
      void load(file)
    }
    window.addEventListener('paste', paste)
    return () => window.removeEventListener('paste', paste)
  }, [load, locked])

  function commitMark(mark: Mark) {
    clearTaskFeedback()
    setHistory((previous) => {
      const last = previous.at(-1)!
      const next = mark.kind === 'brush' && last[0]?.kind === 'brush' ? [...last.slice(-63), mark] : [mark]
      return [...previous.slice(-maxMarkHistory), next]
    })
  }

  function drop(event: DragEvent) {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    if (!locked && event.dataTransfer.files[0]) void load(event.dataTransfer.files[0])
  }

  function saveProviders(choice: ProviderSelection) {
    setPreferences(choice)
    const saved = rememberProviders(choice)
    setSettingsNotice(saved ? '' : '浏览器未允许保存设置，本次打开页面期间仍会使用该设置。')
    setSettingsOpen(false)
  }

  function chooseEdit(edit?: DraftEdit) {
    clearTaskFeedback()
    setSelected(edit?.id)
    setFont(edit?.font ?? undefined)
    setLayout(edit?.layout ?? undefined)
    setOrientation(edit?.orientation ?? 'horizontal')
    setTexture(edit?.texture ?? false)
    setPending(undefined)
    setHistory([edit?.marks ?? []])
    setText(edit?.text ?? '')
    setTool(edit?.marks[0]?.kind === 'brush' ? 'brush' : 'rectangle')
    setDraftNotice('')
  }

  function continueEditing() {
    chooseEdit()
    if (window.matchMedia('(max-width: 760px)').matches) editorPanel.current?.scrollIntoView({ block: 'start' })
  }

  async function deleteEdit(id: string) {
    if (!draft || request.current) return
    const controller = new AbortController()
    request.current = controller
    setReadingResult(true)
    setTaskError('')
    try {
      const updated = await removeEdit(draft, id)
      setDraft(updated)
      setResult(undefined)
      if (selected === id) chooseEdit()
      const preview = updated.result_url ? await getResult(updated.result_url, controller.signal) : undefined
      setResult(preview)
      setDraftNotice('已删除这处改动。')
    } catch (error) {
      if (!controller.signal.aborted) setTaskError(errorMessage(error, '删除失败，请同步草稿后重试。'))
    } finally {
      setReadingResult(false)
      request.current = null
    }
  }

  async function discardDraft() {
    if (request.current || !window.confirm('丢弃当前草稿和其中的改动？')) return
    setLoadingImage(true)
    setTaskError('')
    try {
      if (draftId && !draft) throw new Error('请同步草稿后再丢弃。')
      if (draft) await removeDraft(draft)
      setImage(undefined)
      setDraft(undefined)
      setDraftId(undefined)
      setResult(undefined)
      chooseEdit()
      await persist()
    } catch (error) {
      setTaskError(errorMessage(error, '无法丢弃草稿。'))
    } finally {
      setLoadingImage(false)
    }
  }

  async function submitDraft(source: SourceImage, signal: AbortSignal, refreshBackground: boolean) {
    let current = draft
    if (!current) {
      setUploading(0)
      current = await createDraft(source, signal, setUploading)
      setDraft(current)
      setDraftId(current.draft_id)
    }
    let operation = pending
    if (!operation) {
      operation = { operationId: newOperation(), refreshBackground }
      setPending(operation)
      await persist({ image: source, draftId: current.draft_id, selected, marks, text, pending: operation, ...textStyle })
    }
    const reconnecting = Boolean(operation.taskId) || Boolean(pending)
    let initial: Task | undefined
    if (reconnecting) {
      current = await getDraft(current.draft_id, signal)
      setDraft(current)
      const id = operation.taskId ?? (current.pending_operation_id === operation.operationId ? current.pending_task_id : null)
      if (id) {
        try {
          initial = await getTask(id, signal)
        } catch (error) {
          if (!reopenError(error)) throw error
        }
      }
    }

    if (current.last_operation_id !== operation.operationId) {
      if (!initial) {
        setUploading(0)
        const old = current.edits.find((edit) => edit.id === selected)
        const unchanged = old && sameMarks(old.marks, marks) && (old.orientation ?? 'horizontal') === orientation
        const mask = unchanged && !operation.refreshBackground ? undefined : await makeMask(source, marks, limits)
        initial = await applyEdit(current, operation.operationId, selected, marks, text.trim(), mask, providers, textStyle, signal, setUploading)
        operation = { ...operation, taskId: initial.task_id }
        setPending(operation)
        void persist({ image: source, draftId: current.draft_id, selected, marks, text, pending: operation, ...textStyle })
      }
      setTask(initial)
      setUploading(null)
      const completed = await followTask(initial, signal, setTask)
      if (completed.status === 'failed') {
        setPending(undefined)
        throw new Error(completed.error?.message ?? '草稿处理失败。')
      }
      current = await getDraft(current.draft_id, signal)
    }
    if (!current.result_url || current.last_operation_id !== operation.operationId) throw new Error('无法确认草稿已应用，请同步草稿。')
    setReadingResult(true)
    setDraft(current)
    setSelected(current.last_edit_id ?? selected)
    setResult(undefined)
    setResult(await getResult(current.result_url, signal))
    setPending(undefined)
    setCompare(true)
    setDraftNotice('已应用这处改动。')
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void submitEdit()
  }

  async function scanSelection() {
    if (!image || !marks.length || request.current || scanning || !modelsReady) return
    const controller = new AbortController()
    request.current = controller
    setScanning(true)
    setScanError('')
    try {
      const mask = await makeMask(image, marks, limits)
      setScanResult({ ...(await scan(image, marks, mask, orientation, controller.signal)), key: scanKey })
    } catch (cause) {
      setScanError(errorMessage(cause, '无法扫描选区。'))
    } finally {
      request.current = null
      setScanning(false)
    }
  }

  async function useSuggestedFont(id: string) {
    if (request.current || addingFont) return
    const controller = new AbortController()
    request.current = controller
    setAddingFont(id)
    setScanError('')
    try {
      const response = await downloadFont(id, text.trim(), controller.signal)
      const face = response.fonts.find((candidate) => candidate.id === id)
      if (face?.missing?.length) throw new Error('这款字体缺少替换文案所需的字。')
      if (face) {
        const choice = { family: id, weight: face.default_weight ?? 400 }
        const sample = text.trim() || recommendation?.original || ''
        const preview = await previewFontSample(sample, choice, controller.signal)
        clearTaskFeedback()
        setFont(choice)
        setScanPreview({ key: scanKey, sample, label: face.label, image: preview.preview })
        setScanResult((previous) => previous && { ...previous,
          fonts: previous.fonts.map((item) => item.id === id ? { ...item, installed: true } : item) })
      }
    } catch (cause) {
      setScanError(errorMessage(cause, '无法下载字体。'))
    } finally {
      request.current = null
      setAddingFont(undefined)
    }
  }

  async function submitEdit(refreshBackground = false) {
    if (!canSubmit || !image || request.current) return
    if (/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(text.trim())) {
      setTaskError('请输入单行文案，去掉控制字符或换行。')
      return
    }

    const controller = new AbortController()
    request.current = controller
    try {
      setTaskError('')
      await submitDraft(image, controller.signal, refreshBackground)
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof RequestError && error.status >= 400 && error.status < 500 && error.status !== 429) setPending(undefined)
        setTaskError(errorMessage(error, '此处暂时无法处理，请重试。'))
        if (error instanceof RequestError && error.status === 409) setSyncAttempt((count) => count + 1)
      }
    } finally {
      if (!controller.signal.aborted) {
        setUploading(null)
        setReadingResult(false)
      }
      request.current = null
    }
  }

  const progress = uploading ?? task?.progress ?? 0
  const status = uploading !== null ? (progress < 1 ? '正在读取图片' : '正在准备本地处理')
    : readingResult ? '正在加载结果' : task ? stageNames[task.stage] : ''
  const action = pending ? '继续处理这处' : '应用这一处'

  return <>
    <header className="topbar">
      <div className="topbar-inner">
        <div className="brand"><span className="brand-icon"><Icon name="brand" /></span><span>图片改字</span>
          {health?.version && <small className="app-version">v{health.version}</small>}
        </div>
        <div className="topbar-actions">
          {currentMode ? <span className={`mode mode-${currentMode}`}><i />{modeNames[currentMode]}</span> : serviceDown
            ? <button type="button" className="mode mode-offline" onClick={() => { setServiceDown(false); setHealthAttempt((value) => value + 1) }}><i />{upgradeNotice ? '旧版服务，重连' : '服务离线，重连'}</button>
            : <span className="mode mode-connecting"><i />正在连接服务</span>}
          <button type="button" className="button button-secondary settings-button" disabled={!health} onClick={() => setSettingsOpen(true)}>
            <Icon name="settings" />设置
          </button>
        </div>
      </div>
    </header>

    <main className="workspace">
      <div className="page-heading">
        <h1>图片文字编辑器</h1>
        {upgradeNotice ? <p role="alert" className="error service-version-error">{upgradeNotice}</p>
          : <p>{currentMode === 'mock' ? '圈出图片里的一处文字，换成你想要的文案。' : '在同一张图上逐处修改文字，最后下载整图。'}</p>}
      </div>

      <BrowserSetup ready={modelsReady} onReady={markModelsReady} />
      <div className="work-grid">
        <section className="editor panel" ref={editorPanel} aria-labelledby="editor-title">
          <div className="panel-header">
            <h2 id="editor-title"><Icon name="photo" />图片与选区</h2>
            <input
              className="visually-hidden"
              type="file"
              tabIndex={-1}
              ref={filePicker}
              aria-label="上传图片文件"
              accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ''
                if (file) void load(file)
              }}
            />
            {image && <button className="button button-secondary" type="button" disabled={locked} onClick={() => filePicker.current?.click()}><Icon name="upload" />更换图片</button>}
          </div>

          {image && sourceUrl && <div className="toolbar">
            {compare && resultUrl ? <div className="view-label"><Icon name="compare" />原图与结果</div> : <>
              <div className="tool-group" role="group" aria-label="选区工具">
                {tools.map(({ id, label, icon }) => <button type="button" className="tool-button" key={id} aria-pressed={tool === id} disabled={locked} onClick={() => setTool(id)}>
                  <Icon name={icon} />{label}
                </button>)}
              </div>
              <div className="edit-actions" role="group" aria-label="选区操作">
                <button type="button" className="tool-button" disabled={locked || history.length < 2} onClick={() => { clearTaskFeedback(); setHistory(history.slice(0, -1)) }}><Icon name="undo" />撤销</button>
                <button type="button" className="tool-button" disabled={locked || !marks.length} onClick={() => { clearTaskFeedback(); setHistory([...history.slice(-maxMarkHistory), []]) }}><Icon name="trash" />清空</button>
              </div>
            </>}
            {resultUrl && <button type="button" className="button button-secondary view-button" onClick={() => setCompare(!compare)}><Icon name={compare ? 'edit' : 'compare'} />{compare ? '返回编辑' : '查看结果'}</button>}
          </div>}

          <div
            className={`drop-zone ${dragging ? 'is-dragging' : ''}`}
            onDragEnter={(event) => {
              if (!hasFile(event)) return
              event.preventDefault()
              dragDepth.current += 1
              if (!locked) setDragging(true)
            }}
            onDragOver={(event) => {
              if (!hasFile(event)) return
              event.preventDefault()
              event.dataTransfer.dropEffect = locked ? 'none' : 'copy'
            }}
            onDragLeave={() => {
              dragDepth.current = Math.max(0, dragDepth.current - 1)
              if (dragDepth.current === 0) setDragging(false)
            }}
            onDrop={drop}
          >
            {image && sourceUrl ? <ImageStage
              key={sourceUrl}
              image={image} sourceUrl={sourceUrl} resultUrl={compare ? (resultUrl ?? null) : null}
              editingUrl={draftsEnabled ? resultUrl : undefined}
              zoom={zoomLevels[zoomIndex]} tool={tool} brushSize={brushSize} marks={marks}
              editable={!locked} onMark={commitMark}
            /> : <div className="empty-stage stage-grid">
              <div className="upload-card">
                <div className="upload-icon"><Icon name="photo" /></div>
                <h3>{loadingImage ? '正在读取图片…' : '把图片拖到这里'}</h3>
                <p>也可以粘贴剪贴板中的图片</p>
                <button type="button" className="button button-primary" disabled={loadingImage} onClick={() => filePicker.current?.click()}><Icon name="upload" />选择图片</button>
                <small>PNG、JPG、WebP · 最大 {limits.max_image_bytes / 1024 / 1024} MB</small>
              </div>
            </div>}
            {dragging && image && <div className="drop-overlay">松开以更换图片</div>}
          </div>

          {image && sourceUrl && <div className="editor-footer">
            <div className="image-meta"><span title={image.name}>{image.name}</span><small>{image.width} × {image.height}</small></div>
            {!compare && <>
              {tool === 'brush' && <label className="brush-control">
                画笔 <input type="range" aria-label="画笔大小" min="1" max={maxBrushSize} value={brushSize} disabled={locked} onChange={(event) => setBrushSize(event.currentTarget.valueAsNumber)} />
                <span>{brushSize} px</span>
              </label>}
              <div className="zoom-control" role="group" aria-label="图片缩放">
                <button className="tool-button icon-only" type="button" aria-label="缩小" disabled={locked || zoomIndex === 0} onClick={() => setZoomIndex(zoomIndex - 1)}><Icon name="minus" /></button>
                <button className="tool-button zoom-value" type="button" aria-label="适应窗口" title="适应窗口" disabled={locked} onClick={() => setZoomIndex(0)}>{zoomIndex === 0 ? '适应' : `${Math.round(zoomLevels[zoomIndex] * 100)}%`}</button>
                <button className="tool-button icon-only" type="button" aria-label="放大" disabled={locked || zoomIndex === zoomLevels.length - 1} onClick={() => setZoomIndex(zoomIndex + 1)}><Icon name="plus" /></button>
              </div>
            </>}
          </div>}
          {imageError && <p role="alert" className="error image-error"><Icon name="alert" />{imageError}</p>}
        </section>

        <aside className="details" aria-label="替换文案和结果">
          <form className="panel copy-panel" onSubmit={submit}>
            <div className="panel-header"><h2><Icon name="edit" />替换文案</h2></div>
            <div className="copy-body">
              <label htmlFor="replacement">新文字</label>
              <textarea id="replacement" placeholder="输入替换后的文字" rows={4} value={text} disabled={locked} aria-describedby="text-note text-count" onChange={(event) => {
                clearTaskFeedback()
                setText(Array.from(event.currentTarget.value.replace(/[\r\n\u2028\u2029]/gu, ' ')).slice(0, limits.max_text).join(''))
              }} />
              <div className="text-meta"><span id="text-note">{recommendation ? `原文 ${recommendation.original}` : activeEdit ? `原文 ${activeEdit.original}` : '一行文字'}</span><span id="text-count">{textCount} / {limits.max_text}</span></div>
              {image && marks.length > 0 && <div className="scan-options">
                <button type="button" className="button button-secondary" disabled={locked || !modelsReady || scanning || Boolean(addingFont)}
                  onClick={() => void scanSelection()}>{scanning ? '正在识别…' : '扫描并推荐字体'}</button>
                {scanError && <p className="error" role="alert">{scanError}</p>}
                {recommendation && (recommendation.fonts.length ? <ul aria-label="近似字体候选">
                  {recommendation.fonts.map((face) => <li key={face.id}>
                    <div><strong>{face.name}</strong><small>{(face.size / (1024 * 1024)).toFixed(1)} MiB · 近似匹配</small></div>
                    <button type="button" className="button button-secondary" disabled={locked || Boolean(addingFont) || font?.family === face.id}
                      onClick={() => void useSuggestedFont(face.id)}>{addingFont === face.id ? '正在准备…' : font?.family === face.id ? '已选用' : face.installed ? '预览并选用' : '下载并预览'}</button>
                  </li>)}
                </ul> : <p>可在「字体匹配」里手动挑选字体。</p>)}
                {scanPreview?.key === scanKey && scanPreview.sample === (text.trim() || recommendation?.original || '') &&
                  <img className="scan-font-preview" src={`data:image/png;base64,${scanPreview.image}`} alt={`${scanPreview.label}预览`} />}
              </div>}

              {draftsEnabled && image && <div className="layout-settings">
                {advancedType && <label className="orientation-input">文字方向 <select value={orientation} disabled={locked} onChange={(event) => {
                  clearTaskFeedback()
                  setOrientation(event.currentTarget.value as TextOrientation)
                }}>
                  <option value="horizontal">横排</option>
                  <option value="vertical">竖排（字直立）</option>
                  <option value="clockwise">横排顺时针转 90°</option>
                  <option value="counterclockwise">横排逆时针转 90°</option>
                </select></label>}
                <label className="layout-toggle"><input type="checkbox" checked={preservePositions} disabled={locked} onChange={(event) => {
                  clearTaskFeedback()
                  setLayout(event.currentTarget.checked ? { spacing: 0 } : { spacing: 0, mode: 'natural' })
                }} />按原图字位排版</label>
                {preservePositions && (orientation === 'vertical' || characterLayout ? <label className="layout-spacing">
                  字距微调 <input type="range" aria-label="字距微调" min="-8" max="8" value={layout?.spacing ?? 0} disabled={locked} onChange={(event) => {
                    clearTaskFeedback()
                    setLayout({ spacing: event.currentTarget.valueAsNumber })
                  }} /><span>{(layout?.spacing ?? 0) > 0 ? '+' : ''}{layout?.spacing ?? 0} px</span>
                </label> : <p>选区内的中文与新文案字数相同时可微调字距。混排按字体自然字距。</p>)}
              </div>}
              {advancedType && image && <TextureControls key={activeEdit ? `${activeEdit.id}:${draft?.version}` : 'new-edit'}
                draftId={useSavedSelection ? draft?.draft_id : undefined} editId={useSavedSelection ? activeEdit.id : undefined}
                text={text} style={textStyle} providers={providers} disabled={locked}
                onChange={(enabled) => { clearTaskFeedback(); setTexture(enabled) }} />}
              {advancedType && image && <FontMatching key={useSavedSelection ? activeEdit.id : 'new-font'}
                draftId={useSavedSelection ? draft?.draft_id : undefined} editId={useSavedSelection ? activeEdit.id : undefined}
                text={text} chosen={font} layout={layout} texture={texture} disabled={locked} onChange={(choice) => { clearTaskFeedback(); setFont(choice) }} />}
              {matchesAppliedEdit && activeEdit?.texture_status && <p className="form-hint" role="status">{textureStatus[activeEdit.texture_status]}</p>}

              {currentMode === 'mock' && <div className="mode-notice"><Icon name="alert" /><span>Mock 演示仅验证流程，输出为原图。</span></div>}
              {currentMode === 'cloud' && <div className="mode-notice"><Icon name="alert" /><span>处理新选区时，图片局部会发送到所选云服务。</span></div>}
              {providerNotice && <p className="mode-notice" role="status">{providerNotice}</p>}

              {editApplied && !busy ? <button className="button button-primary submit" type="button" onClick={continueEditing} disabled={locked}>
                继续改下一处<Icon name="arrow" />
              </button> : <button className="button button-primary submit" type="submit" disabled={!canSubmit}>
                {busy ? '正在处理…' : action}<Icon name="arrow" />
              </button>}
              {!busy && !taskError && !editApplied && <p className="form-hint">{!image ? '请先选择图片' : !health ? '请先连接图像服务'
                : !marks.length ? (draft?.edits.length ? '请框选或涂抹下一处文字' : '请框选或涂抹一处文字')
                : !text.trim() ? '请输入新文案' : '选区已就绪'}</p>}
              {busy && <div className="progress-block" role="status">
                <div><span>{status}</span><span>{Math.round(progress * 100)}%</span></div>
                <progress max={1} value={progress} aria-label={status} />
              </div>}
              {taskError && <p className="error" role="alert"><Icon name="alert" />{taskError}</p>}
              {matchesAppliedEdit && !pending && currentMode === 'local' && <button type="button" className="button button-secondary draft-sync"
                disabled={locked} onClick={() => void submitEdit(true)}>重新修复底图</button>}
              {draftsEnabled && draftId && (taskError || missingPreview) && !busy && <button type="button" className="button button-secondary draft-sync" onClick={() => { setTaskError(''); setSyncAttempt((count) => count + 1) }}>同步草稿</button>}
            </div>
          </form>

          {draftsEnabled && image && <section className="panel draft-panel" aria-labelledby="draft-title">
            <div className="panel-header"><h2 id="draft-title">草稿改动</h2><span className="draft-count">{draft?.edits.length ?? 0} 处</span></div>
            <div className="result-body">
              {!!draft?.edits.length && <ol className="draft-list">
                {draft.edits.map((edit, index) => <li key={edit.id}>
                  <button className="draft-entry" type="button" aria-pressed={edit.id === selected} disabled={locked}
                    onClick={() => chooseEdit(edit)}><span>{index + 1}</span><strong>{edit.text}</strong><small>编辑</small></button>
                  <button className="tool-button icon-only" type="button" disabled={locked} aria-label={`删除第 ${index + 1} 处`} onClick={() => void deleteEdit(edit.id)}><Icon name="trash" /></button>
                </li>)}
              </ol>}
              {activeEdit && !editApplied && <button className="button button-secondary draft-next" type="button" disabled={locked} onClick={continueEditing}><Icon name="plus" />新增一处</button>}
              {draftNotice && <p role="status" className="draft-note">{draftNotice}</p>}
              {storageError && <p role="alert" className="draft-note">浏览器无法保存草稿，刷新前请下载当前结果。</p>}
              {resultUrl && <a className="button button-secondary download" href={resultUrl} download="textmeld-result.png"><Icon name="download" />下载整图</a>}
              {!draft?.edits.length && !draftNotice && <p>应用第一处后，可以继续编辑同一张图。</p>}
              <button className="tool-button draft-discard" type="button" disabled={locked} onClick={() => void discardDraft()}>丢弃草稿</button>
            </div>
          </section>}

          {!draftsEnabled && resultUrl && task && <section className="panel result-panel" aria-labelledby="result-title">
            <div className="panel-header"><h2 id="result-title"><Icon name="check" />{task.mode === 'mock' ? '演示结果已就绪' : '结果已就绪'}</h2></div>
            <div className="result-body">
              <p>{modeNames[task.mode]} · PNG · {image?.width} × {image?.height}</p>
              <a className="button button-secondary download" href={resultUrl} download="textmeld-result.png"><Icon name="download" />下载图片</a>
            </div>
          </section>}

          {image && !compare && !resultUrl && <div className="selection-tip"><Icon name={tool === 'brush' ? 'brush' : tool === 'pan' ? 'hand' : 'rectangle'} /><p>{tool === 'brush' ? '可分多笔覆盖同一处文字。' : tool === 'pan' ? '放大后可拖动画布，查看其它位置。' : '拖动鼠标或手指，把要替换的文字圈进矩形。'}</p></div>}
        </aside>
      </div>
    </main>
    {settingsOpen && <ProviderSettings options={providerOptions} current={providers}
      onSave={saveProviders} onClose={() => setSettingsOpen(false)} />}
  </>
}
