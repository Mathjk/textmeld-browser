import cv from '@techstark/opencv-js'
import type { InferenceSession } from 'onnxruntime-web/wasm'
import type { Box, Letter, Output, Prepared, RenderOptions, Typeface, WorkerActions } from './types'
import type { TextOrientation } from '../drafts'

type Point = { x: number; y: number }
type Quad = [Point, Point, Point, Point]
type Index = { positions: Map<string, number>; faces: { id: string; values: Uint8Array }[] }
const context = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage: (value: unknown) => void
  fonts: FontFaceSet
}
let ort: typeof import('onnxruntime-web/wasm')
let detector: InferenceSession
let recognizer: InferenceSession
let alphabet: string[]
let index: Index
const installed = new Set<string>()

function canvas(width: number, height: number) {
  const image = new OffscreenCanvas(width, height)
  return { image, draw: image.getContext('2d', { willReadFrequently: true })! }
}

async function decode(blob: Blob) {
  const bitmap = await createImageBitmap(blob)
  const output = canvas(bitmap.width, bitmap.height)
  output.draw.drawImage(bitmap, 0, 0)
  bitmap.close()
  return output
}

function pixels(surface: ReturnType<typeof canvas>) {
  return surface.draw.getImageData(0, 0, surface.image.width, surface.image.height)
}

function surfaceFrom(data: Uint8Array | Uint8ClampedArray, width: number, height: number) {
  const output = canvas(width, height)
  output.draw.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0)
  return output
}

function waitForCV() {
  return new Promise<void>((resolve, reject) => {
    if (typeof cv.Mat === 'function') {
      resolve()
      return
    }
    const timeout = setTimeout(() => reject(new Error('图像处理库启动超时。')), 30_000)
    ;(cv as unknown as { onRuntimeInitialized: () => void }).onRuntimeInitialized = () => {
      clearTimeout(timeout)
      resolve()
    }
  })
}

async function openResources(base: string) {
  const cache = await caches.open('textmeld-models-v1')
  async function read(name: string) {
    const response = await cache.match(new URL('models/' + name, base).href)
    if (!response) throw new Error('识别资源缺失，请重新下载。')
    return response
  }
  const runtimeUrl = new URL('runtime/ort.wasm.min.mjs', base).href
  ort = await import(/* @vite-ignore */ runtimeUrl)
  ort.env.wasm.numThreads = 1
  ort.env.wasm.wasmPaths = new URL('runtime/', base).href
  const session = async (name: string) => ort.InferenceSession.create(
    await (await read(name)).arrayBuffer(), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' },
  )
  await waitForCV()
  detector = await session('PP-OCRv6_det_small.onnx')
  recognizer = await session('PP-OCRv6_rec_small.onnx')
  alphabet = await (await read('alphabet.json')).json()
  const reference = await (await read('glyph-index.json')).json() as
    { characters: string; faces: { id: string; features: string }[] }
  index = {
    positions: new Map(Array.from(reference.characters, (character, n) => [character, n * 10])),
    faces: reference.faces.map((face) => ({ id: face.id, values: Uint8Array.from(atob(face.features), (char) => char.charCodeAt(0)) })),
  }
}

function bounding(mask: ArrayLike<number>, width: number, height: number): Box {
  let left = width, top = height, right = -1, bottom = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
    }
  }
  if (right < left || bottom < top) throw new Error('请先框选或涂抹一处文字。')
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
}

function rect(x: number, y: number, width: number, height: number): Quad {
  return [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }]
}

function rectangle(quad: Quad): Box {
  const x = Math.min(...quad.map((point) => point.x))
  const y = Math.min(...quad.map((point) => point.y))
  return { x, y, width: Math.max(...quad.map((point) => point.x)) - x, height: Math.max(...quad.map((point) => point.y)) - y }
}

function orientedRect(center: Point, width: number, height: number, angle: number): Quad {
  if (Math.abs(Math.sin(angle)) > Math.abs(Math.cos(angle))) {
    angle -= Math.PI / 2
    ;[width, height] = [height, width]
  }
  if (Math.cos(angle) < 0) angle += Math.PI
  const c = Math.cos(angle), s = Math.sin(angle)
  return rect(-width / 2, -height / 2, width, height).map(({ x, y }) =>
    ({ x: center.x + x * c - y * s, y: center.y + x * s + y * c })) as Quad
}

function tensor(surface: ReturnType<typeof canvas>) {
  const { data, width, height } = pixels(surface)
  const area = width * height
  const values = new Float32Array(area * 3)
  for (let i = 0; i < area; i++) {
    values[i] = data[4 * i + 2] / 127.5 - 1
    values[area + i] = data[4 * i + 1] / 127.5 - 1
    values[2 * area + i] = data[4 * i] / 127.5 - 1
  }
  return new ort.Tensor('float32', values, [1, 3, height, width])
}

function resized(source: OffscreenCanvas, width: number, height: number) {
  const result = canvas(width, height)
  result.draw.drawImage(source, 0, 0, width, height)
  return result
}

async function detect(source: OffscreenCanvas) {
  const longest = Math.max(source.width, source.height)
  const paddedWidth = Math.max(source.width, Math.ceil(longest / 4))
  const paddedHeight = Math.max(source.height, Math.ceil(longest / 4))
  const marginX = Math.floor((paddedWidth - source.width) / 2)
  const marginY = Math.floor((paddedHeight - source.height) / 2)
  const probe = canvas(paddedWidth, paddedHeight)
  const background = source.getContext('2d')!.getImageData(0, 0, 1, 1).data
  probe.draw.fillStyle = 'rgb(' + Array.from(background.slice(0, 3)).join(',') + ')'
  probe.draw.fillRect(0, 0, paddedWidth, paddedHeight)
  probe.draw.drawImage(source, marginX, marginY)
  const scale = Math.min(1280 / longest, Math.max(1, 256 / Math.min(paddedWidth, paddedHeight)))
  const width = Math.max(32, Math.round(paddedWidth * scale / 32) * 32)
  const height = Math.max(32, Math.round(paddedHeight * scale / 32) * 32)
  const input = tensor(resized(probe.image, width, height))
  const values = await detector.run({ x: input })
  const output = values[detector.outputNames[0]]
  const [mapHeight, mapWidth] = output.dims.slice(-2)
  const scores = output.data as Float32Array
  const map = cv.matFromArray(mapHeight, mapWidth, cv.CV_8UC1, Uint8Array.from(scores, (value) => value > 0.3 ? 255 : 0))
  const contours = new cv.MatVector(), hierarchy = new cv.Mat()
  const lines: Quad[] = []
  try {
    cv.findContours(map, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE)
    for (let n = 0; n < Math.min(1000, contours.size()); n++) {
      const contour = contours.get(n)
      try {
        const { center, size, angle } = cv.minAreaRect(contour)
        if (Math.min(size.width, size.height) < 3 || cv.contourArea(contour) < 12) continue
        const pad = 1.6 * size.width * size.height / (2 * (size.width + size.height))
        const quad = orientedRect(center, size.width + 2 * pad, size.height + 2 * pad, angle * Math.PI / 180)
        lines.push(quad.map(({ x, y }) => ({
          x: x * paddedWidth / mapWidth - marginX,
          y: y * paddedHeight / mapHeight - marginY,
        })) as Quad)
      } finally {
        contour.delete()
      }
    }
  } finally {
    contours.delete(); hierarchy.delete(); map.delete()
    output.dispose(); input.dispose()
  }
  return lines
}

async function recognize(source: OffscreenCanvas): Promise<Letter[]> {
  const scaledWidth = Math.max(1, Math.min(1536, Math.ceil(48 * source.width / source.height)))
  const width = Math.max(320, Math.ceil(scaledWidth / 8) * 8)
  const normalized = pixels(resized(source, scaledWidth, 48)).data
  const area = width * 48
  const input = new Float32Array(area * 3)
  for (let c = 0; c < 3; c++) for (let y = 0; y < 48; y++) for (let x = 0; x < scaledWidth; x++) {
    input[c * area + y * width + x] = normalized[(y * scaledWidth + x) * 4 + 2 - c] / 127.5 - 1
  }
  const feed = new ort.Tensor('float32', input, [1, 3, 48, width])
  const results = await recognizer.run({ x: feed })
  const output = results[recognizer.outputNames[0]]
  const [, steps, count] = output.dims
  const scores = output.data as Float32Array
  const letters: Letter[] = []
  let prior = 0
  for (let step = 0; step < steps; step++) {
    let code = 0, score = -Infinity
    const at = step * count
    for (let n = 0; n < count; n++) {
      if (scores[at + n] > score) { code = n; score = scores[at + n] }
    }
    if (code !== 0 && code !== prior && alphabet[code] && score > 0.2) {
      const position = Math.min(source.width - 1, (step + 0.5) * width / steps * source.width / scaledWidth)
      letters.push({ text: alphabet[code], position, left: 0, right: source.width })
    }
    prior = code
  }
  output.dispose(); feed.dispose()
  for (let i = 0; i < letters.length; i++) {
    if (i > 0) letters[i].left = (letters[i - 1].position + letters[i].position) / 2
    if (i + 1 < letters.length) letters[i].right = (letters[i].position + letters[i + 1].position) / 2
  }
  return letters
}

function matrix(from: Quad, to: Quad) {
  const a = cv.matFromArray(4, 1, cv.CV_32FC2, from.flatMap(({ x, y }) => [x, y]))
  const b = cv.matFromArray(4, 1, cv.CV_32FC2, to.flatMap(({ x, y }) => [x, y]))
  try {
    const transform = cv.getPerspectiveTransform(a, b)
    const values = Array.from(transform.data64F)
    transform.delete()
    return values
  } finally {
    a.delete(); b.delete()
  }
}

function warp(source: cv.Mat, transform: number[], width: number, height: number, mode = cv.INTER_LINEAR) {
  const result = new cv.Mat()
  const projection = cv.matFromArray(3, 3, cv.CV_64FC1, transform)
  try {
    cv.warpPerspective(source, result, projection, new cv.Size(width, height), mode, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0))
    return result
  } finally {
    projection.delete()
  }
}

function align(source: OffscreenCanvas, crop: Box, orientation: TextOrientation) {
  const { x, y, width, height } = crop
  const side = orientation === 'clockwise' || orientation === 'counterclockwise'
  const target = canvas(side ? height : width, side ? width : height)
  if (orientation === 'clockwise') { target.draw.translate(0, width); target.draw.rotate(-Math.PI / 2) }
  if (orientation === 'counterclockwise') { target.draw.translate(height, 0); target.draw.rotate(Math.PI / 2) }
  target.draw.drawImage(source, x, y, width, height, 0, 0, width, height)
  return target
}

function hits(mask: cv.Mat, quad: Quad) {
  const box = rectangle(quad)
  let count = 0
  for (let y = Math.max(0, Math.floor(box.y)); y < Math.min(mask.rows, Math.ceil(box.y + box.height)); y++) {
    for (let x = Math.max(0, Math.floor(box.x)); x < Math.min(mask.cols, Math.ceil(box.x + box.width)); x++) {
      if (mask.data[y * mask.cols + x]) count++
    }
  }
  return count
}

function flatBackground(plane: cv.Mat, smoothed: cv.Mat, allowed: Uint8Array) {
  const histogram = new Uint32Array(32768)
  for (let n = 0; n < allowed.length; n++) {
    if (!allowed[n] || plane.data[4 * n + 3] < 200) continue
    const index = ((plane.data[4 * n] >> 3) << 10) | ((plane.data[4 * n + 1] >> 3) << 5) | (plane.data[4 * n + 2] >> 3)
    histogram[index]++
  }
  let best = 0
  for (let n = 1; n < histogram.length; n++) if (histogram[n] > histogram[best]) best = n
  const color = [(best >> 10) * 8 + 4, ((best >> 5) & 31) * 8 + 4, (best & 31) * 8 + 4]
  let checked = 0, near = 0
  for (let n = 0; n < allowed.length; n++) {
    if (!allowed[n] || plane.data[4 * n + 3] < 200) continue
    checked++
    if (color.every((value, c) => Math.abs(smoothed.data[4 * n + c] - value) <= 18)) near++
  }
  return checked && near / checked >= 0.88 ? color : undefined
}

function inkFrom(plane: cv.Mat, allowed: Uint8Array) {
  const { cols: width, rows: height } = plane
  const base = new cv.Mat()
  const window = Math.min(41, Math.max(5, Math.round(Math.min(width, height) * 0.46) | 1))
  cv.medianBlur(plane, base, window)
  const uniform = flatBackground(plane, base, allowed)
  const differences = new Float32Array(width * height)
  const histogram = new Uint32Array(256)
  let count = 0
  for (let n = 0; n < differences.length; n++) {
    if (!allowed[n] || plane.data[4 * n + 3] < 200) continue
    let delta = 0
    for (let channel = 0; channel < 3; channel++) {
      const background = uniform?.[channel] ?? base.data[4 * n + channel]
      delta += (plane.data[4 * n + channel] - background) ** 2
    }
    differences[n] = Math.sqrt(delta / 3)
    histogram[Math.min(255, Math.round(differences[n]))]++
    count++
  }
  base.delete()
  let tail = 0, contrast = 0
  for (let n = 255; n >= 0; n--) {
    tail += histogram[n]
    if (tail >= count * 0.08) { contrast = n; break }
  }
  if (contrast < 6) throw new Error('原字与底图对比度太低，请缩小选区。')
  const core = Uint8Array.from(differences, (delta) => delta >= Math.max(5, contrast * 0.36) ? 255 : 0)
  const labels = new cv.Mat(), stats = new cv.Mat(), centroids = new cv.Mat()
  const coreMat = cv.matFromArray(height, width, cv.CV_8UC1, core)
  try {
    const groups = cv.connectedComponentsWithStats(coreMat, labels, stats, centroids, 8, cv.CV_32S)
    let largest = 0
    for (let n = 1; n < groups; n++) largest = Math.max(largest, stats.intAt(n, cv.CC_STAT_AREA))
    const rgb = [[], [], []] as number[][]
    let weak = 0, solid = 0
    for (let n = 0; n < core.length; n++) {
      const label = labels.data32S[n]
      if (!label || stats.intAt(label, cv.CC_STAT_AREA) < Math.max(2, largest * 0.025)) {
        core[n] = 0
        continue
      }
      if (differences[n] >= contrast * 1.1) for (let c = 0; c < 3; c++) rgb[c].push(plane.data[4 * n + c])
      if (differences[n] < contrast * 0.62) weak++
      else solid++
    }
    const ink = bounding(core, width, height)
    const color = rgb.map((channel) => {
      channel.sort((a, b) => a - b)
      return channel[Math.floor(channel.length / 2)] ?? 45
    })
    const inkMat = cv.matFromArray(height, width, cv.CV_8UC1, core)
    const expanded = new cv.Mat()
    const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3))
    try {
      cv.dilate(inkMat, expanded, kernel)
      const erase = Uint8Array.from(expanded.data, (pixel, n) => allowed[n] ? pixel : 0)
      return { ink, core, color, erase, softness: Math.min(1, weak / Math.max(1, solid)) }
    } finally {
      inkMat.delete(); expanded.delete(); kernel.delete()
    }
  } finally {
    coreMat.delete(); labels.delete(); stats.delete(); centroids.delete()
  }
}

function bitCount(value: number) {
  let count = 0
  while (value) { value &= value - 1; count++ }
  return count
}

function recommend(letters: Letter[], ink: Uint8Array, width: number, height: number, vertical: boolean) {
  const samples = letters.flatMap((letter) => {
    const position = index.positions.get(letter.text)
    if (position === undefined) return []
    const region = ink.map((bit, n) => {
      const line = vertical ? Math.floor(n / width) : n % width
      return line >= letter.left && line < letter.right ? bit : 0
    })
    try {
      const box = bounding(region, width, height)
      const sample = canvas(box.width, box.height)
      const rgba = sample.draw.createImageData(box.width, box.height)
      for (let y = 0; y < box.height; y++) for (let x = 0; x < box.width; x++) {
        rgba.data[(y * box.width + x) * 4 + 3] = region[(y + box.y) * width + x + box.x]
      }
      sample.draw.putImageData(rgba, 0, 0)
      const data = pixels(resized(sample.image, 8, 8)).data
      const rows = Array.from({ length: 8 }, (_, row) => {
        let mask = 0
        for (let col = 0; col < 8; col++) if (data[4 * (row * 8 + col) + 3] >= 95) mask |= 1 << col
        return mask
      })
      return [{ position, ratio: Math.min(255, box.width / box.height * 64), rows }]
    } catch {
      return []
    }
  })
  if (!samples.length) return []
  return index.faces.flatMap(({ id, values }) => {
    let count = 0, error = 0
    for (const { position, ratio, rows } of samples) {
      if (!values[position]) continue
      let overlap = 0, union = 0
      for (let i = 0; i < 8; i++) {
        overlap += bitCount(rows[i] & values[position + 2 + i])
        union += bitCount(rows[i] | values[position + 2 + i])
      }
      error += 1 - overlap / Math.max(1, union) + Math.abs(ratio - values[position]) / 350
      count++
    }
    return count ? [{ id, score: error / count + (1 - count / samples.length) * 0.5 }] : []
  }).sort((a, b) => a.score - b.score).slice(0, 3).map(({ id }) => id)
}

async function prepare({ image, mask, orientation }: WorkerActions['prepare']): Promise<Prepared> {
  const source = await decode(image)
  const selection = await decode(mask)
  const { width, height } = source.image
  if (selection.image.width !== width || selection.image.height !== height) throw new Error('选区尺寸与原图不一致。')
  const maskData = pixels(selection).data
  const selected = bounding(Uint8Array.from({ length: width * height }, (_, i) => maskData[4 * i]), width, height)
  const pad = Math.min(110, Math.max(25, Math.floor(Math.max(selected.width, selected.height) / 6)))
  const x = Math.max(0, selected.x - pad), y = Math.max(0, selected.y - pad)
  const crop = { x, y, width: Math.min(width, selected.x + selected.width + pad) - x,
    height: Math.min(height, selected.y + selected.height + pad) - y }
  const working = align(source.image, crop, orientation)
  const chosen = align(selection.image, crop, orientation)
  const originalImage = await align(source.image, crop, 'horizontal').image.convertToBlob()
  const color = cv.matFromImageData(pixels(working))
  const maskPixels = pixels(chosen).data
  const allowed = cv.matFromArray(color.rows, color.cols, cv.CV_8UC1,
    Uint8Array.from({ length: color.rows * color.cols }, (_, i) => maskPixels[4 * i] > 127 ? 255 : 0))
  const vertical = orientation === 'vertical'
  let flat: cv.Mat | undefined
  let flatMask: cv.Mat | undefined
  try {
    const lines = (await detect(working.image)).map((quad) => ({ quad, count: hits(allowed, quad) }))
      .filter((line) => line.count >= 6).sort((a, b) => b.count - a.count)
    if (!lines.length) throw new Error('选区内未识别到文字，请缩小到一行或一列重试。')
    const main = rectangle(lines[0].quad)
    const matching = lines.filter(({ quad, count }) => {
      const box = rectangle(quad)
      const consistent = vertical ? Math.abs(box.x + box.width / 2 - main.x - main.width / 2) < main.width * 0.65
        : Math.abs(box.y + box.height / 2 - main.y - main.height / 2) < main.height * 0.5
      if (!consistent && count > lines[0].count * 0.44) throw new Error('选区包含多行文字，请缩小范围。')
      return consistent
    })
    if (!vertical && main.height > main.width * 1.55) throw new Error('请检查横排、竖排或旋转方向。')
    let quad = lines[0].quad
    if (matching.length > 1 || vertical) {
      const boxes = matching.map((item) => rectangle(item.quad))
      const left = Math.min(...boxes.map((box) => box.x)), top = Math.min(...boxes.map((box) => box.y))
      const right = Math.max(...boxes.map((box) => box.x + box.width)), bottom = Math.max(...boxes.map((box) => box.y + box.height))
      quad = rect(left, top, right - left, bottom - top)
    }
    const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
    const plane = { width: Math.max(4, Math.round(distance(quad[0], quad[1]))),
      height: Math.max(4, Math.round(distance(quad[0], quad[3]))) }
    const dst = rect(0, 0, plane.width - 1, plane.height - 1)
    const transform = matrix(quad, dst)
    flat = warp(color, transform, plane.width, plane.height)
    flatMask = warp(allowed, transform, plane.width, plane.height, cv.INTER_NEAREST)
    const surface = surfaceFrom(flat.data, plane.width, plane.height)
    let letters: Letter[]
    if (vertical) {
      const raw = inkFrom(flat, flatMask.data)
      const rows = Array.from({ length: plane.height }, (_, yy) =>
        raw.core.subarray(yy * plane.width, (yy + 1) * plane.width).some(Boolean))
      const bands: { start: number; end: number }[] = []
      for (let yy = 0; yy < rows.length; yy++) {
        if (!rows[yy]) continue
        const last = bands.at(-1)
        if (last && yy - last.end < Math.max(2, plane.width * 0.1)) last.end = yy + 1
        else bands.push({ start: yy, end: yy + 1 })
      }
      letters = []
      for (const { start, end } of bands.filter((band) => band.end - band.start >= plane.width * 0.23)) {
        const glyph = canvas(plane.width, end - start + 4)
        glyph.draw.fillStyle = '#fff'
        glyph.draw.fillRect(0, 0, glyph.image.width, glyph.image.height)
        glyph.draw.drawImage(surface.image, 0, start, plane.width, end - start, 0, 2, plane.width, end - start)
        const [found] = await recognize(glyph.image)
        if (found) letters.push({ text: found.text, position: (start + end) / 2, left: start, right: end })
      }
    } else {
      letters = (await recognize(surface.image)).filter((letter) => {
        let overlap = 0
        const left = Math.max(0, Math.floor(letter.left)), right = Math.min(plane.width, Math.ceil(letter.right))
        for (let yy = 0; yy < plane.height; yy++) for (let xx = left; xx < right; xx++) {
          if (flatMask!.data[yy * plane.width + xx]) overlap++
        }
        return overlap >= (right - left) * plane.height * 0.13
      })
    }
    const original = letters.map((letter) => letter.text).join('').trim()
    if (!original) throw new Error('无法读出选区的文字。请缩小选区或调整文字方向。')
    const start = Math.max(0, Math.floor(letters[0].left) - 1)
    const end = Math.ceil(letters[letters.length - 1].right) + 1
    const area = Uint8Array.from(flatMask.data, (_, n) => {
      const offset = vertical ? Math.floor(n / plane.width) : n % plane.width
      return offset >= start && offset < end ? 255 : 0
    })
    const extracted = inkFrom(flat, area)
    const rgb = new cv.Mat(), filled = new cv.Mat(), restored = new cv.Mat()
    const erase = cv.matFromArray(plane.height, plane.width, cv.CV_8UC1, extracted.erase)
    let background: Blob
    try {
      cv.cvtColor(flat, rgb, cv.COLOR_RGBA2RGB)
      cv.inpaint(rgb, erase, filled, 3, cv.INPAINT_TELEA)
      cv.cvtColor(filled, restored, cv.COLOR_RGB2RGBA)
      background = await surfaceFrom(restored.data, plane.width, plane.height).image.convertToBlob()
    } finally {
      rgb.delete(); filled.delete(); restored.delete(); erase.delete()
    }
    const physical = quad.map((p) => orientation === 'clockwise' ? { x: crop.width - p.y, y: p.x }
      : orientation === 'counterclockwise' ? { x: p.y, y: crop.height - p.x } : p) as Quad
    return { crop, originalImage, background, erase: extracted.erase, matrix: matrix(dst, physical), plane,
      ink: extracted.ink, color: extracted.color, original, letters, orientation,
      candidates: recommend(letters, extracted.core, plane.width, plane.height, vertical), softness: extracted.softness }
  } finally {
    color.delete(); allowed.delete(); flat?.delete(); flatMask?.delete()
  }
}

async function fontFamily(font: Typeface) {
  if (!font.binary) return font.serif ? '"Songti SC","SimSun",serif' : '"PingFang SC","Microsoft YaHei",sans-serif'
  const family = 'textmeld-' + font.key
  if (!installed.has(family)) {
    const face = new FontFace(family, font.binary, { weight: font.variable ? '100 900' : 'normal' })
    await face.load()
    context.fonts.add(face)
    installed.add(family)
  }
  return '"' + family + '"'
}

function typeGlyphs(draw: OffscreenCanvasRenderingContext2D, prepared: Prepared, options: RenderOptions, family: string) {
  const { ink } = prepared
  const color = 'rgb(' + prepared.color.join(',') + ')'
  const text = options.text
  const characters = Array.from(text)
  draw.fillStyle = color
  draw.textBaseline = 'alphabetic'
  const measure = (size: number) => {
    draw.font = options.font.weight + ' ' + size + 'px ' + family
    return draw.measureText(text)
  }
  if (prepared.orientation === 'vertical') {
    const height = Math.min(ink.height / characters.length, ink.width * 1.12)
    measure(Math.max(4, height * 0.92))
    draw.textBaseline = 'middle'
    draw.textAlign = 'center'
    const pitch = Math.max(height, ink.height / characters.length + (options.spacing ?? 0))
    for (let n = 0; n < characters.length; n++) {
      const position = ink.y + ink.height / 2 + pitch * (n - (characters.length - 1) / 2)
      if (position >= height / 2 && position <= prepared.plane.height - height / 2)
        draw.fillText(characters[n], ink.x + ink.width / 2, position, ink.width)
    }
    return
  }
  const metrics = measure(Math.max(4, ink.height))
  const size = Math.max(4, ink.height ** 2 / Math.max(1, metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent))
  const fitted = measure(size)
  const baseline = ink.y + ink.height - fitted.actualBoundingBoxDescent
  const original = Array.from(prepared.original.replace(/[\p{P}]+$/u, ''))
  const equalChinese = options.spacing !== undefined && characters.length >= 2 && original.length === characters.length &&
    [...original, ...characters].every((char) => /\p{Script=Han}/u.test(char))
  if (equalChinese) {
    draw.textAlign = 'center'
    const max = Math.min(prepared.plane.width, ink.x + ink.width + 3)
    const min = Math.max(0, ink.x - 3)
    const designWidth = Math.min(ink.width + 6, Math.max(ink.width * 0.6, ink.width + options.spacing! * (characters.length - 1)))
    const step = designWidth / characters.length
    const center = ink.x + ink.width / 2
    for (let n = 0; n < characters.length; n++) {
      const at = Math.max(min + step / 2, Math.min(max - step / 2, center + (n - (characters.length - 1) / 2) * step))
      draw.fillText(characters[n], at, baseline, Math.max(1, step - 1))
    }
  } else {
    draw.fillText(text, ink.x + Math.max(0, fitted.actualBoundingBoxLeft), baseline, Math.max(1, ink.width))
  }
}

async function render(prepared: Prepared, options: RenderOptions): Promise<Output> {
  const family = await fontFamily(options.font)
  const { plane: { width, height }, crop } = prepared
  const glyph = canvas(width, height)
  const softened = Boolean(options.texture && prepared.softness > 0.32 && prepared.ink.height >= 12)
  if (softened) glyph.draw.filter = 'blur(0.45px)'
  typeGlyphs(glyph.draw, prepared, options, family)
  const alpha = pixels(glyph).data
  const fill = await decode(prepared.background)
  fill.draw.drawImage(glyph.image, 0, 0)
  const rgba = cv.matFromImageData(pixels(fill))
  const mask = cv.matFromArray(height, width, cv.CV_8UC1,
    Uint8Array.from(prepared.erase, (value, i) => Math.max(value, alpha[4 * i + 3])))
  const projected = warp(rgba, prepared.matrix, crop.width, crop.height)
  const projectedMask = warp(mask, prepared.matrix, crop.width, crop.height)
  try {
    const data = new Uint8ClampedArray(projected.data)
    for (let n = 0; n < projectedMask.data.length; n++) data[4 * n + 3] = projectedMask.data[n] >= 5 ? 255 : 0
    const patch = surfaceFrom(data, crop.width, crop.height)
    const preview = await decode(prepared.originalImage)
    preview.draw.drawImage(patch.image, 0, 0)
    return { patch: await patch.image.convertToBlob(), preview: await preview.image.convertToBlob(), softened }
  } finally {
    projected.delete(); projectedMask.delete(); rgba.delete(); mask.delete()
  }
}

async function sample(options: RenderOptions) {
  const family = await fontFamily(options.font)
  const output = canvas(460, 90)
  output.draw.fillStyle = '#fff'
  output.draw.fillRect(0, 0, 460, 90)
  output.draw.font = options.font.weight + ' 36px ' + family
  output.draw.fillStyle = '#222'
  output.draw.textBaseline = 'middle'
  output.draw.fillText(options.text, 16, 46, 428)
  return output.image.convertToBlob()
}

let tasks = Promise.resolve()
context.onmessage = ({ data: { id, action, data } }) => {
  tasks = tasks.then(async () => {
    try {
      let result: unknown
      switch (action) {
        case 'load': await openResources(data.base); break
        case 'prepare': result = await prepare(data); break
        case 'render': result = await render(data.prepared, data.options); break
        case 'sample': result = await sample(data.options); break
        default: throw new Error('无法执行浏览器图像任务。')
      }
      context.postMessage({ id, result })
    } catch (error) {
      context.postMessage({ id, error: error instanceof Error ? error.message : '图像处理失败。' })
    }
  })
}
