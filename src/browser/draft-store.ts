import type { Task, ProviderSelection } from '../api'
import { RequestError } from '../api'
import type { Draft, DraftEdit, FontChoice, FontPreviews, TextStyle, TexturePreview } from '../drafts'
import type { Mark, SourceImage } from '../image'
import { getFontCatalog, imageBase64, namedCandidates, typeface } from './fonts'
import { vision } from './runtime'
import { change, read } from './storage'
import type { Box, Output, Prepared } from './types'

type Edit = { view: DraftEdit; prepared: Prepared; patch: Blob }
type StoredDraft = { id: string; version: number; source: SourceImage; edits: Edit[]; operation: string | null; selected: string | null }
const defaults: ProviderSelection = { ocr: 'local', inpaint: 'local', render: 'pillow' }
const tasks = new Map<string, Task>()
const running = new Map<string, { operation: string; id: string }>()
let proposed: { image: Blob; key: string; prepared: Promise<Prepared> } | undefined

function view(record: StoredDraft): Draft {
  const active = running.get(record.id)
  return {
    draft_id: record.id, version: record.version, edits: record.edits.map((edit) => edit.view),
    pending_task_id: active?.id ?? null, pending_operation_id: active?.operation ?? null,
    last_operation_id: record.operation, last_edit_id: record.selected,
    result_url: record.edits.length ? 'browser:' + record.id + '/' + record.version : null,
  }
}

async function stored(id: string) {
  const record = await read<StoredDraft>('drafts', id)
  if (!record) throw new RequestError('此浏览器中没有该草稿。', 404)
  return record
}

function checked(record: StoredDraft | undefined, version: number): StoredDraft {
  if (!record) throw new RequestError('草稿已删除。', 404)
  if (record.version !== version) throw new RequestError('草稿有新的改动，请刷新后重试。', 409)
  return record
}

export async function getDraft(id: string, signal: AbortSignal) {
  signal.throwIfAborted()
  return view(await stored(id))
}

export async function createDraft(source: SourceImage, signal: AbortSignal, progress: (value: number) => void) {
  signal.throwIfAborted()
  const record: StoredDraft = { id: crypto.randomUUID(), version: 0, source, edits: [], operation: null, selected: null }
  await change<StoredDraft>('drafts', record.id, () => record)
  progress(1)
  return view(record)
}

function setup(width: number, height: number) {
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = height
  return { canvas, draw: canvas.getContext('2d', { willReadFrequently: true })! }
}

async function paste(draw: CanvasRenderingContext2D, blob: Blob, x = 0, y = 0) {
  const bitmap = await createImageBitmap(blob)
  draw.drawImage(bitmap, x, y)
  bitmap.close()
}

function png(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('无法导出 PNG。')), 'image/png'))
}

export async function getResult(location: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const [id, version] = location.replace(/^browser:/, '').split('/')
  const record = checked(await stored(id), Number(version))
  const { canvas, draw } = setup(record.source.width, record.source.height)
  await paste(draw, record.source.blob)
  for (const { patch, prepared } of record.edits) await paste(draw, patch, prepared.crop.x, prepared.crop.y)
  signal.throwIfAborted()
  return png(canvas)
}

export async function getTask(id: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const found = tasks.get(id)
  if (!found) throw new RequestError('上次处理已结束，可重新提交。', 404)
  return found
}

function prepare(image: Blob, marks: Mark[], mask: Blob, orientation: Prepared['orientation'], signal: AbortSignal) {
  const key = JSON.stringify([marks, orientation])
  if (proposed?.image === image && proposed.key === key) return proposed.prepared
  const attempt = vision<Prepared>('prepare', { image, mask, orientation }, signal)
  proposed = { image, key, prepared: attempt }
  void attempt.catch(() => { if (proposed?.prepared === attempt) proposed = undefined })
  return attempt
}

export async function scan(image: SourceImage, marks: Mark[], mask: Blob, orientation: Prepared['orientation'], signal: AbortSignal) {
  const result = await prepare(image.blob, marks, mask, orientation, signal)
  return { original: result.original, fonts: await namedCandidates(result.candidates) }
}

function intersect(a: Box, b: Box): Box | undefined {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y)
  const width = Math.min(a.x + a.width, b.x + b.width) - x
  const height = Math.min(a.y + a.height, b.y + b.height) - y
  return width > 0 && height > 0 ? { x, y, width, height } : undefined
}

async function overlap(original: Edit, next: Edit) {
  const a = original.prepared.crop, b = next.prepared.crop
  const box = intersect(a, b)
  if (!box) return false
  const { draw } = setup(box.width, box.height)
  await paste(draw, original.patch, a.x - box.x, a.y - box.y)
  draw.globalCompositeOperation = 'destination-in'
  await paste(draw, next.patch, b.x - box.x, b.y - box.y)
  return draw.getImageData(0, 0, box.width, box.height).data.some((value, index) => index % 4 === 3 && value > 5)
}

function options(text: string, style: TextStyle, provider: ProviderSelection = defaults) {
  return typeface(style.font, text, provider.render === 'pillow-serif').then((font) => ({
    text, font, texture: style.texture, spacing: style.layout?.spacing,
  }))
}

export async function applyEdit(draft: Draft, operationId: string, editId: string | undefined, marks: Mark[], text: string,
  mask: Blob | undefined, provider: ProviderSelection | undefined, style: TextStyle,
  signal: AbortSignal, progress: (value: number) => void): Promise<Task> {
  signal.throwIfAborted()
  const id = draft.draft_id
  const snapshot = checked(await stored(id), draft.version)
  const active = running.get(id)
  if (active) {
    if (active.operation === operationId) return tasks.get(active.id)!
    throw new RequestError('请等待同一草稿的处理结束。', 409)
  }
  if (!text.trim() || [...text].length > 200 || /[\p{Cc}\p{Cs}]/u.test(text)) throw new RequestError('请输入 1–200 字的一行文字。', 422)
  if (!editId && snapshot.edits.length >= 24) throw new RequestError('单图最多可保留 24 处改动。', 422)
  const taskId = crypto.randomUUID(), nextId = editId ?? crypto.randomUUID()
  running.set(id, { operation: operationId, id: taskId })
  const task: Task = { task_id: taskId, mode: 'local', status: 'queued', stage: 'queued', progress: 0, error: null, result_url: null }
  tasks.set(taskId, task)
  progress(1)
  void (async () => {
    const update = (change: Partial<Task>) => tasks.set(taskId, { ...tasks.get(taskId)!, ...change })
    try {
      const before = snapshot.edits.find((item) => item.view.id === nextId)
      update({ status: 'processing', stage: mask ? 'ocr' : 'render', progress: 0.15 })
      const orientation = style.orientation ?? 'horizontal'
      const prepared = mask ? await prepare(snapshot.source.blob, marks, mask, orientation, signal) : before?.prepared
      if (!prepared) throw new Error('请重新框选图片文字。')
      update({ stage: 'render', progress: 0.74 })
      const renderOptions = await options(text, style, provider)
      const result = await vision<Output>('render', { prepared, options: renderOptions }, signal)
      const next: Edit = { prepared, patch: result.patch, view: {
        id: nextId, text, marks, original: prepared.original, mode: 'local', providers: provider ?? defaults, state: 'applied',
        font: style.font ?? null, layout: style.layout ?? null, orientation, texture: style.texture,
        texture_status: style.texture ? (result.softened ? 'applied' : 'unchanged') : null, reused_background: !mask,
        layout_reference: prepared.original.replace(/[\p{P}]+$/u, ''),
      } }
      for (const other of snapshot.edits) {
        if (other.view.id !== nextId && await overlap(other, next)) throw new Error('该处与已有改动重叠，请调整选区。')
      }
      signal.throwIfAborted()
      const updated: StoredDraft = { ...snapshot, version: snapshot.version + 1,
        edits: before ? snapshot.edits.map((item) => item.view.id === nextId ? next : item) : [...snapshot.edits, next],
        operation: operationId, selected: nextId }
      await change<StoredDraft>('drafts', id, (current) => { checked(current, snapshot.version); return updated })
      update({ status: 'completed', stage: 'done', progress: 1, result_url: view(updated).result_url })
    } catch (error) {
      update({ status: 'failed', stage: 'failed', error: { code: 'local_failure', message: error instanceof Error ? error.message : '浏览器处理失败。' } })
    } finally {
      running.delete(id)
      window.setTimeout(() => tasks.delete(taskId), 120_000)
    }
  })()
  return task
}

export async function removeEdit(draft: Draft, editId: string) {
  await change<StoredDraft>('drafts', draft.draft_id, (current) => {
    const record = checked(current, draft.version)
    if (running.has(record.id)) throw new RequestError('请等待当前处理结束。', 409)
    return { ...record, version: record.version + 1, edits: record.edits.filter((item) => item.view.id !== editId), selected: null, operation: null }
  })
  return view(await stored(draft.draft_id))
}

export async function removeDraft(draft: Draft) {
  await change<StoredDraft>('drafts', draft.draft_id, (current) => {
    checked(current, draft.version)
    if (running.has(draft.draft_id)) throw new RequestError('请等待当前处理结束。', 409)
    return undefined
  })
}

async function getEdit(draftId: string, editId: string) {
  const found = (await stored(draftId)).edits.find((item) => item.view.id === editId)
  if (!found) throw new RequestError('无法读取此处的背景。', 404)
  return found
}

export async function previewFonts(draftId: string, editId: string, text: string, signal: AbortSignal,
  font?: FontChoice, layout?: TextStyle['layout'], texture?: boolean): Promise<FontPreviews> {
  const edit = await getEdit(draftId, editId)
  const prepared = edit.prepared
  const catalog = await getFontCatalog(text)
  const matching = catalog.fonts.filter(({ id }) => prepared.candidates.includes(id) || id.startsWith('system-')).slice(0, 3)
  const faces = font ? catalog.fonts.filter(({ id }) => id === font.family) : matching
  const candidates = []
  for (const face of faces) {
    if (face.missing?.length) continue
    const weight = font?.weight ?? face.default_weight ?? 400
    const renderOptions = await options(text, { font: { family: face.id, weight }, layout, texture })
    const rendered = await vision<Output>('render', { prepared, options: renderOptions }, signal)
    candidates.push({ id: face.id, label: face.label, style: face.style, weight, preview: await imageBase64(rendered.preview) })
  }
  return { ...catalog, candidates, match: 'approximate', original: await imageBase64(prepared.originalImage) }
}

export async function previewTexture(draftId: string, editId: string, text: string, style: TextStyle,
  provider: ProviderSelection | undefined, signal: AbortSignal): Promise<TexturePreview> {
  const { prepared } = await getEdit(draftId, editId)
  const renderOptions = await options(text, style, provider)
  const normal = await vision<Output>('render', { prepared, options: { ...renderOptions, texture: false } }, signal)
  const matched = await vision<Output>('render', { prepared, options: { ...renderOptions, texture: true } }, signal)
  return { original: await imageBase64(prepared.originalImage), normal: await imageBase64(normal.preview),
    matched: await imageBase64(matched.preview), status: matched.softened ? 'applied' : 'unchanged' }
}
