import { getTask } from './browser/draft-store'
export { getTask, getResult } from './browser/draft-store'

export type Mode = 'mock' | 'local' | 'cloud'

export type ProviderSelection = {
  ocr: 'local' | 'tencent'
  inpaint: 'local' | 'dashscope'
  render: 'pillow' | 'pillow-sans' | 'pillow-serif'
}

export type ProviderOptions = {
  defaults: ProviderSelection
  available: { [Key in keyof ProviderSelection]: ProviderSelection[Key][] }
  has_custom_font: boolean
}

export type Limits = {
  max_image_bytes: number
  max_mask_bytes: number
  max_side: number
  max_pixels: number
  max_text: number
}

export const defaultLimits: Limits = {
  max_image_bytes: 12 * 1024 * 1024,
  max_mask_bytes: 4 * 1024 * 1024,
  max_side: 2048,
  max_pixels: 4_194_304,
  max_text: 200,
}

export type Health = {
  status: 'ok'; mode: Mode; limits: Limits; providers?: ProviderOptions | null; drafts: boolean; manage_provider_keys?: boolean
  typography?: boolean
  version?: string
}

type ApiError = { code: string; message: string }

export type Task = {
  task_id: string
  mode: Mode
  status: 'queued' | 'processing' | 'completed' | 'failed'
  stage: 'queued' | 'ocr' | 'inpaint' | 'render' | 'mock' | 'done' | 'failed'
  progress: number
  providers?: ProviderSelection | null
  error: ApiError | null
  result_url: string | null
}

export class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export async function getHealth(signal: AbortSignal): Promise<Health> {
  signal.throwIfAborted()
  return { status: 'ok', mode: 'local', limits: defaultLimits, drafts: true, typography: true, version: '1.4.1',
    providers: { defaults: { ocr: 'local', inpaint: 'local', render: 'pillow' },
      available: { ocr: ['local'], inpaint: ['local'], render: ['pillow', 'pillow-sans', 'pillow-serif'] }, has_custom_font: false } }
}

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted()
    const timeout = window.setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    function abort() {
      window.clearTimeout(timeout)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

export async function followTask(
  first: Task,
  signal: AbortSignal,
  onProgress: (task: Task) => void,
) {
  let task = first
  let failures = 0
  const deadline = Date.now() + 5 * 60_000

  while (true) {
    onProgress(task)
    if (task.status === 'completed' || task.status === 'failed') return task
    if (Date.now() > deadline) throw new Error('任务等待时间过长，请重新查询。')

    await wait(120 * 2 ** failures, signal)
    try {
      task = await getTask(task.task_id, signal)
      failures = 0
    } catch (error) {
      if (signal.aborted || (error instanceof RequestError && error.status < 500) || failures >= 3) {
        throw error
      }
      failures += 1
    }
  }
}
