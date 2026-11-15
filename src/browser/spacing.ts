import type { GlyphSlot, Letter } from './types'

const han = /^\p{Script=Han}{2,}$/u
const punctuation = /^\p{P}$/u

export function hanReference(original: string) {
  const text = original.trim().replace(/^\p{P}+|\p{P}+$/gu, '')
  return han.test(text) ? text : undefined
}

export function usesOriginalPositions(original: string, replacement: string) {
  const reference = hanReference(original)
  return Boolean(reference && han.test(replacement) && [...reference].length === [...replacement].length)
}

function inkBands(core: Uint8Array, width: number, height: number, inkHeight: number): GlyphSlot[] {
  const occupied = new Uint8Array(width)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (core[y * width + x]) occupied[x] = 1
  }
  const minimumGap = Math.max(2, Math.round(inkHeight * 0.08))
  const groups: GlyphSlot[] = []
  for (let x = 0; x < occupied.length; x++) {
    if (!occupied[x]) continue
    const prior = groups.at(-1)
    if (prior && x - prior.right < minimumGap) prior.right = x + 1
    else groups.push({ left: x, right: x + 1 })
  }
  return groups
}

export function protectBoundaryPunctuation(
  letters: Letter[], core: Uint8Array, erase: Uint8Array, selection: Uint8Array,
  width: number, height: number, inkHeight: number,
) {
  const bands = inkBands(core, width, height, inkHeight)
  if (bands.length !== letters.length || letters.length < 2) return false
  let protectedPunctuation = false
  for (const index of [0, letters.length - 1]) {
    if (!punctuation.test(letters[index].text)) continue
    const { left, right } = bands[index]
    if (right - left > Math.max(4, inkHeight * 0.55)) continue
    let total = 0, selected = 0
    for (let y = 0; y < height; y++) for (let x = left; x < right; x++) {
      const pixel = y * width + x
      if (!core[pixel]) continue
      total++
      if (selection[pixel]) selected++
    }
    if (!total || selected / total >= 0.55) continue
    protectedPunctuation = true
    const leftLimit = index ? Math.ceil((bands[index - 1].right + left) / 2) : 0
    const rightLimit = index + 1 < bands.length ? Math.floor((right + bands[index + 1].left) / 2) : width
    for (let y = 0; y < height; y++) for (let x = Math.max(leftLimit, left - 3); x < Math.min(rightLimit, right + 3); x++) {
      core[y * width + x] = 0
      erase[y * width + x] = 0
    }
  }
  return protectedPunctuation
}

export function measuredSlots(letters: Letter[], core: Uint8Array, width: number, height: number, inkHeight: number) {
  const reference = hanReference(letters.map(({ text }) => text).join(''))
  if (!reference) return []
  const count = [...reference].length
  const bands = inkBands(core, width, height, inkHeight)
  const glyphs = bands.filter((band) => band.right - band.left >= Math.max(3, inkHeight * 0.27))
  if (glyphs.length !== count) return []
  if (glyphs.some((band) => band.right - band.left > inkHeight * 1.45)) return []
  return glyphs
}
