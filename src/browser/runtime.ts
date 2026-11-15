import type { WorkerActions } from './types'

export const cacheName = 'textmeld-models-v1'
export const siteBase = new URL(import.meta.env.BASE_URL, document.baseURI).href
const resource = (path: string) => new URL(path, siteBase).href
const manifestPath = resource('model-files.json')
let worker: Worker | undefined
let initializing: Promise<void> | undefined
let sequence = 0

type FileInfo = { size: number; sha256: string }
type Manifest = Record<string, FileInfo>
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }
const pending = new Map<number, Pending>()

async function manifest(): Promise<Manifest> {
  const response = await fetch(manifestPath)
  if (!response.ok) throw new Error('无法读取模型清单。')
  return response.json()
}

export async function modelsDownloaded() {
  try {
    const cache = await caches.open(cacheName)
    const files = await manifest()
    const matches = await Promise.all(Object.keys(files).map((file) => cache.match(resource(`models/${file}`))))
    return matches.every(Boolean)
  } catch {
    return false
  }
}

function request(action: string, data: unknown): Promise<unknown> {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker!.postMessage({ id, action, data })
  })
}

export async function initializeModels(onProgress?: (label: string, progress: number) => void) {
  if (initializing) return initializing
  initializing = (async () => {
    const cache = await caches.open(cacheName)
    const files = await manifest()
    const total = Object.values(files).reduce((sum, { size }) => sum + size, 0)
    let downloaded = 0
    for (const [file, info] of Object.entries(files)) {
      const url = resource(`models/${file}`)
      if (!(await cache.match(url))) {
        onProgress?.('正在下载识别资源…', downloaded / total * 0.85)
        const response = await fetch(url)
        if (!response.ok) throw new Error('模型下载失败，请检查网络后重试。')
        const bytes = await response.arrayBuffer()
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('')
        if (bytes.byteLength !== info.size || hash !== info.sha256) throw new Error('模型校验失败，请重试。')
        await cache.put(url, new Response(bytes, { headers: response.headers }))
      }
      downloaded += info.size
    }
    onProgress?.('正在启动浏览器识别…', 0.9)
    worker = new Worker(new URL('./vision.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = ({ data }) => {
      const entry = pending.get(data.id)
      if (!entry) return
      pending.delete(data.id)
      if (data.error) entry.reject(new Error(data.error))
      else entry.resolve(data.result)
    }
    worker.onerror = () => {
      for (const entry of pending.values()) entry.reject(new Error('浏览器图像引擎启动失败。'))
      pending.clear()
      worker?.terminate()
      worker = undefined
      initializing = undefined
    }
    await request('load', { base: siteBase })
    onProgress?.('识别模型已就绪', 1)
  })().catch((error) => {
    worker?.terminate()
    worker = undefined
    initializing = undefined
    throw error
  })
  return initializing
}

export async function vision<T, K extends keyof WorkerActions = keyof WorkerActions>(action: K, data: WorkerActions[K], signal?: AbortSignal) {
  signal?.throwIfAborted()
  if (!initializing && !(await modelsDownloaded())) throw new Error('请先下载识别模型。')
  await initializeModels()
  signal?.throwIfAborted()
  const result = await request(action, data) as T
  signal?.throwIfAborted()
  return result
}
