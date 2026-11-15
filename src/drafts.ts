import type { Mode, ProviderSelection } from './api'
import type { Mark, SourceImage } from './image'

export type DraftEdit = {
  id: string
  text: string
  marks: Mark[]
  original: string
  mode: Mode
  providers: ProviderSelection
  state: 'applied'
  font: FontChoice | null
  layout: LayoutChoice | null
  layout_reference?: string
  layout_refresh_available?: boolean
  orientation?: TextOrientation
  texture?: boolean
  texture_status?: TextureStatus | null
  reused_background?: boolean
}

export type FontChoice = { family: string; weight: number }
export type LayoutChoice = { spacing: number; mode?: 'natural' }
export type TextOrientation = 'horizontal' | 'vertical' | 'clockwise' | 'counterclockwise'
export type TextureStatus = 'applied' | 'similar' | 'unchanged'
export type TexturePreview = { original: string; normal: string; matched: string; status: TextureStatus }
export type TextStyle = { font?: FontChoice; layout?: LayoutChoice; orientation?: TextOrientation; texture?: boolean }
export type FontFace = {
  id: string; label: string; style: string; weights: number[]; aliases?: string[]; missing?: string[]
  source: 'bundled' | 'upload' | 'download'; default_weight: number | null
}
export type FontCandidate = { id: string; label: string; style: string; weight: number; preview: string }
export type OnlineFont = {
  id: string; label: string; style: string; aliases: string[]; installed: boolean; source_url: string; size_bytes: number
}
export type FontScript = 'all' | 'zh' | 'zh-Hans' | 'zh-Hant' | 'latin' | 'japanese' | 'korean'
export type OnlineFontPage = { items: OnlineFont[]; total: number; page: number; page_size: number }
export type FontCatalog = { fonts: FontFace[]; online: OnlineFont[]; online_total?: number; max_font_bytes: number }
export type FontPreviews = FontCatalog & { original: string; match: 'approximate'; candidates: FontCandidate[] }
export type AddedFont = FontCatalog & { added_id: string }

export type Draft = {
  draft_id: string
  version: number
  edits: DraftEdit[]
  pending_task_id: string | null
  pending_operation_id: string | null
  last_operation_id: string | null
  last_edit_id: string | null
  result_url: string | null
}

export type PendingEdit = { operationId: string; taskId?: string; refreshBackground?: boolean }

export type SavedDraft = {
  image: SourceImage
  draftId?: string
  selected?: string
  marks: Mark[]
  text: string
  font?: FontChoice
  layout?: LayoutChoice
  orientation?: TextOrientation
  texture?: boolean
  pending?: PendingEdit
}

export function newOperation(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export { getDraft, createDraft, applyEdit, previewFonts, previewTexture, removeEdit, removeDraft, scan } from './browser/draft-store'
export { getFontCatalog, searchOnlineFonts, previewFontSample, uploadFont, downloadFont } from './browser/fonts'

function openDraftDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('textmeld-browser-editor', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('drafts')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function readSavedDraft(): Promise<SavedDraft | undefined> {
  const db = await openDraftDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('drafts').objectStore('drafts').get('active')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

let writes = Promise.resolve()

export function saveDraftLocally(value?: SavedDraft) {
  const write = writes.then(async () => {
    const db = await openDraftDatabase()
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('drafts', 'readwrite')
        const store = transaction.objectStore('drafts')
        if (value) store.put(value, 'active')
        else store.delete('active')
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error)
      })
    } finally {
      db.close()
    }
  })
  writes = write.catch(() => {})
  return write
}
