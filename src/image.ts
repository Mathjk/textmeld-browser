import type { Limits } from './api'

export type SourceImage = { name: string; blob: Blob; width: number; height: number }
export type Point = { x: number; y: number }
export type Rectangle = { kind: 'rectangle'; start: Point; end: Point }
export type Stroke = { kind: 'brush'; points: Point[]; diameter: number }
export type Mark = Rectangle | Stroke
export type Tool = Mark['kind'] | 'pan'

function encode(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('浏览器无法编码图片。'))
    }, type, quality)
  })
}

async function imageType(file: File) {
  const data = new DataView(await file.slice(0, 12).arrayBuffer())
  if (data.byteLength >= 3 && data.getUint16(0) === 0xffd8 && data.getUint8(2) === 0xff) return 'image/jpeg'
  if (data.byteLength >= 8 && data.getUint32(0) === 0x89504e47 && data.getUint32(4) === 0x0d0a1a0a) return 'image/png'
  if (data.byteLength === 12 && data.getUint32(0) === 0x52494646 && data.getUint32(8) === 0x57454250) return 'image/webp'
  throw new Error('请选择 PNG、JPG 或 WebP 图片。')
}

async function decode(file: File) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      // Some browsers can decode images through <img> that ImageBitmap rejects.
    }
  }
  const image = new Image()
  const url = URL.createObjectURL(file)
  image.src = url
  try {
    await image.decode()
    return image
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function prepareImage(file: File, limits: Limits): Promise<SourceImage> {
  if (file.size > limits.max_image_bytes) {
    throw new Error(`请选择 ${limits.max_image_bytes / 1024 / 1024} MB 以内的图片。`)
  }
  await imageType(file)
  const canvas = document.createElement('canvas')
  try {
    const image = await decode(file).catch(() => { throw new Error('无法读取这张图片，请换一张试试。') })
    try {
      const width = 'naturalWidth' in image ? image.naturalWidth : image.width
      const height = 'naturalHeight' in image ? image.naturalHeight : image.height
      const scale = Math.min(1, limits.max_side / Math.max(width, height), Math.sqrt(limits.max_pixels / (width * height)))
      canvas.width = Math.max(1, Math.floor(width * scale))
      canvas.height = Math.max(1, Math.floor(height * scale))
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) throw new Error('浏览器不支持画布编辑。')
      context.fillStyle = '#fff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.imageSmoothingQuality = 'high'
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
    } finally {
      if ('close' in image) image.close()
    }

    const blob = await encode(canvas, 'image/png')
    return { name: file.name, blob, width: canvas.width, height: canvas.height }
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
}

export function rectangleBounds(mark: Rectangle) {
  return {
    x: Math.floor(Math.min(mark.start.x, mark.end.x)),
    y: Math.floor(Math.min(mark.start.y, mark.end.y)),
    right: Math.ceil(Math.max(mark.start.x, mark.end.x)),
    bottom: Math.ceil(Math.max(mark.start.y, mark.end.y)),
  }
}

export function paintMarks(context: CanvasRenderingContext2D, marks: readonly Mark[], color: string) {
  context.fillStyle = color
  context.strokeStyle = color
  context.lineCap = 'round'
  context.lineJoin = 'round'

  for (const mark of marks) {
    if (mark.kind === 'rectangle') {
      const { x, y, right, bottom } = rectangleBounds(mark)
      context.fillRect(x, y, right - x, bottom - y)
    } else {
      const [first, ...rest] = mark.points
      context.lineWidth = mark.diameter
      context.beginPath()
      if (!rest.length) {
        if (mark.diameter === 1) {
          context.fillRect(Math.floor(first.x), Math.floor(first.y), 1, 1)
        } else {
          context.arc(first.x, first.y, mark.diameter / 2, 0, Math.PI * 2)
          context.fill()
        }
      } else {
        context.moveTo(first.x, first.y)
        for (const point of rest) context.lineTo(point.x, point.y)
        context.stroke()
      }
    }
  }
}

export async function makeMask(image: SourceImage, marks: readonly Mark[], limits: Limits) {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  try {
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('浏览器无法生成选区。')
    context.fillStyle = '#000'
    context.fillRect(0, 0, image.width, image.height)
    paintMarks(context, marks, '#fff')
    const mask = await encode(canvas, 'image/png')
    if (mask.size > limits.max_mask_bytes) throw new Error('选区文件过大，请用更简单的框选。')
    return mask
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
}
