function histogramRank(histogram: Uint32Array, rank: number) {
  let total = 0
  for (let value = 0; value < histogram.length; value++) {
    total += histogram[value]
    if (total >= rank) return value
  }
  throw new Error('无法从选区内识别可靠的文字颜色。')
}

export function foregroundColor(rgba: Uint8Array, core: Uint8Array, differences: Float32Array, percentile = 0.78) {
  const levels = new Uint32Array(256)
  let count = 0
  for (let n = 0; n < core.length; n++) {
    if (!core[n]) continue
    levels[Math.round(differences[n])]++
    count++
  }
  if (!count) throw new Error('选区内没有可靠的旧字笔画。')
  // Sample the strongest part of the observed strokes, even when they all have the same colour.
  const lower = histogramRank(levels, Math.ceil(count * percentile))
  const channels = Array.from({ length: 3 }, () => new Uint32Array(256))
  let sampled = 0
  for (let n = 0; n < core.length; n++) {
    if (!core[n] || Math.round(differences[n]) < lower) continue
    for (let c = 0; c < channels.length; c++) channels[c][rgba[n * 4 + c]]++
    sampled++
  }
  return channels.map((histogram) => histogramRank(histogram, Math.ceil(sampled / 2)))
}

export function followsInk(rgba: Uint8Array, background: Uint8Array, solid: number[] | undefined, position: number, color: number[]) {
  let dot = 0, magnitude = 0, direction = 0
  for (let c = 0; c < 3; c++) {
    const base = solid?.[c] ?? background[position + c]
    const observed = rgba[position + c] - base
    const expected = color[c] - base
    dot += observed * expected
    magnitude += observed ** 2
    direction += expected ** 2
  }
  return dot > 0 && dot ** 2 >= magnitude * direction * 0.45
}

function solvePlane(rows: number[][]) {
  for (let col = 0; col < 3; col++) {
    let pivot = col
    for (let r = col + 1; r < 3; r++) if (Math.abs(rows[r][col]) > Math.abs(rows[pivot][col])) pivot = r
    ;[rows[col], rows[pivot]] = [rows[pivot], rows[col]]
    const scale = rows[col][col]
    if (Math.abs(scale) < 1e-6) return
    for (let c = col; c < 6; c++) rows[col][c] /= scale
    for (let r = 0; r < 3; r++) {
      if (r === col) continue
      const factor = rows[r][col]
      for (let c = col; c < 6; c++) rows[r][c] -= factor * rows[col][c]
    }
  }
  return rows
}

export function rebuildSmoothBackground(rgba: Uint8Array, erase: Uint8Array, nearby: Uint8Array,
  width: number, height: number, base?: number[]) {
  const rows = Array.from({ length: 3 }, () => [0, 0, 0, 0, 0, 0])
  const candidates: number[] = []
  const channels = Array.from({ length: 3 }, () => new Uint32Array(256))
  for (let n = 0; n < erase.length; n++) {
    if (erase[n] || !nearby[n] || rgba[n * 4 + 3] < 245) continue
    candidates.push(n)
    if (!base) for (let c = 0; c < 3; c++) channels[c][rgba[n * 4 + c]]++
  }
  if (candidates.length < 24) return
  const reference = base ?? channels.map((histogram) => histogramRank(histogram, Math.ceil(candidates.length / 2)))
  let suitable = 0
  const basis = (n: number) => [1, (n % width) / width - 0.5, Math.floor(n / width) / height - 0.5]
  for (const n of candidates) {
    if (reference.some((value, c) => Math.abs(rgba[n * 4 + c] - value) > 16)) continue
    suitable++
    const b = basis(n)
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      rows[r][c] += b[r] * b[c]
      rows[r][c + 3] += b[r] * rgba[n * 4 + c]
    }
  }
  if (suitable < 24 || suitable < candidates.length * 0.92) return
  const coefficients = solvePlane(rows)
  if (!coefficients) return
  const predict = (b: number[], channel: number) =>
    coefficients[0][channel + 3] + b[1] * coefficients[1][channel + 3] + b[2] * coefficients[2][channel + 3]
  // A flat surface or a gentle gradient fits this model. Leave edges and texture to local inpainting.
  let agreement = 0
  for (const n of candidates) {
    const b = basis(n)
    if (reference.every((_, c) => Math.abs(rgba[n * 4 + c] - predict(b, c)) <= 3)) agreement++
  }
  if (agreement < candidates.length * 0.94) return
  const result = new Uint8ClampedArray(rgba)
  for (let n = 0; n < erase.length; n++) {
    if (!erase[n]) continue
    const b = basis(n)
    for (let c = 0; c < 3; c++) result[n * 4 + c] = predict(b, c)
  }
  return result
}
