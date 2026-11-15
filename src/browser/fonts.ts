import type { AddedFont, FontCatalog, FontChoice, FontFace as FontFaceView, FontScript, OnlineFontPage } from '../drafts'
import type { Typeface } from './types'
import { siteBase, vision } from './runtime'
import { change, list, read } from './storage'

type Asset = { filename: string; size: number; blob: string }
type Entry = { id: string; label: string; aliases: string[]; category: string; subsets: string[]; font: Asset; license: Asset }
type Catalogue = { revision: string; fonts: Entry[] }
type Stored = { face: FontFaceView; binary: ArrayBuffer; variable: boolean; license?: ArrayBuffer }
let catalogue: Promise<Catalogue> | undefined
const uploadLimit = 24 * 1024 * 1024
const storedLimit = 256 * 1024 * 1024
const systems: FontFaceView[] = [
  { id: 'system-sans', label: '系统黑体', style: '设备默认字体', weights: [400, 700], source: 'bundled', default_weight: 400, aliases: ['黑体', 'sans'] },
  { id: 'system-serif', label: '系统宋体', style: '设备默认字体', weights: [400, 700], source: 'bundled', default_weight: 400, aliases: ['宋体', 'serif'] },
]
const scripts: Record<Exclude<FontScript, 'all'>, string[]> = {
  zh: ['chinese-simplified', 'chinese-traditional', 'chinese-hongkong'],
  'zh-Hans': ['chinese-simplified'], 'zh-Hant': ['chinese-traditional', 'chinese-hongkong'],
  latin: ['latin'], japanese: ['japanese'], korean: ['korean'],
}
const scriptLabels: Record<string, string> = {
  'chinese-simplified': '简体', 'chinese-traditional': '繁体', 'chinese-hongkong': '香港繁体',
  latin: '英文／数字', japanese: '日文', korean: '韩文',
}

async function getCatalogue() {
  catalogue ??= fetch(new URL('google-fonts-catalog.json', siteBase)).then(async (response) => {
    if (!response.ok) throw new Error('无法打开字体目录。')
    return await response.json() as Catalogue
  }).catch((error) => { catalogue = undefined; throw error })
  return catalogue
}

function table(data: DataView, name: string) {
  const count = data.getUint16(4)
  for (let n = 0; n < count; n++) {
    const entry = 12 + n * 16
    const tag = String.fromCharCode(...Array.from({ length: 4 }, (_, i) => data.getUint8(entry + i)))
    if (tag !== name) continue
    const start = data.getUint32(entry + 8)
    const length = data.getUint32(entry + 12)
    if (start + length > data.byteLength) throw new Error('字体文件损坏。')
    return new DataView(data.buffer, data.byteOffset + start, length)
  }
}

function unicodeMap(binary: ArrayBuffer) {
  const cmap = table(new DataView(binary), 'cmap')
  if (!cmap) throw new Error('字体缺少字符表。')
  const maps: { start: number; format: number }[] = []
  for (let n = 0; n < cmap.getUint16(2); n++) {
    const record = 4 + 8 * n
    const platform = cmap.getUint16(record), encoding = cmap.getUint16(record + 2)
    if (platform !== 0 && !(platform === 3 && (encoding === 1 || encoding === 10))) continue
    const start = cmap.getUint32(record + 4)
    const format = cmap.getUint16(start)
    if ([4, 12, 13].includes(format)) maps.push({ start, format })
  }
  if (!maps.length) throw new Error('字体缺少可用的 Unicode 字符表。')
  return (code: number) => maps.some(({ start, format }) => {
    if (format === 12 || format === 13) {
      let left = 0, right = cmap.getUint32(start + 12) - 1
      while (left <= right) {
        const middle = (left + right) >>> 1
        const group = start + 16 + middle * 12
        const first = cmap.getUint32(group)
        if (code < first) right = middle - 1
        else if (code > cmap.getUint32(group + 4)) left = middle + 1
        else return (cmap.getUint32(group + 8) + (format === 12 ? code - first : 0)) !== 0
      }
      return false
    }
    if (code > 0xffff) return false
    const segments = cmap.getUint16(start + 6) / 2
    let left = 0, right = segments - 1
    while (left <= right) {
      const middle = (left + right) >>> 1
      if (code > cmap.getUint16(start + 14 + middle * 2)) left = middle + 1
      else right = middle - 1
    }
    if (left === segments) return false
    const first = cmap.getUint16(start + 16 + (segments + left) * 2)
    if (code < first) return false
    const delta = cmap.getInt16(start + 16 + (2 * segments + left) * 2)
    const offset = start + 16 + (3 * segments + left) * 2
    const index = cmap.getUint16(offset)
    if (!index) return ((code + delta) & 0xffff) !== 0
    const glyph = cmap.getUint16(offset + index + (code - first) * 2)
    return glyph !== 0 && ((glyph + delta) & 0xffff) !== 0
  })
}

function missing(binary: ArrayBuffer, text: string) {
  const covers = unicodeMap(binary)
  return [...new Set(text)].filter((char) => !covers(char.codePointAt(0)!))
}

function familyName(binary: ArrayBuffer) {
  const name = table(new DataView(binary), 'name')
  if (!name) return ''
  const start = name.getUint16(4)
  const names: { rank: number; text: string }[] = []
  for (let i = 0, count = name.getUint16(2); i < count; i++) {
    const offset = 6 + i * 12
    const platform = name.getUint16(offset), id = name.getUint16(offset + 6)
    if ((platform !== 3 && platform !== 0) || ![1, 4, 16].includes(id)) continue
    const bytes = new Uint8Array(name.buffer, name.byteOffset + start + name.getUint16(offset + 10), name.getUint16(offset + 8))
    const text = new TextDecoder('utf-16be').decode(bytes).replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 100)
    if (text) names.push({ rank: id === 4 ? 0 : id === 16 ? 1 : 2, text })
  }
  return names.sort((a, b) => a.rank - b.rank)[0]?.text ?? ''
}

const normalized = (value: string) => value.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
const toHex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((n) => n.toString(16).padStart(2, '0')).join('')

export async function getFontCatalog(text: string, signal?: AbortSignal): Promise<FontCatalog> {
  const [fonts, online] = await Promise.all([list<Stored>('fonts'), getCatalogue().catch(() => undefined)])
  signal?.throwIfAborted()
  return { fonts: [...systems, ...fonts.map(({ face, binary }) => ({ ...face, missing: missing(binary, text) }))],
    online: [], online_total: online?.fonts.length, max_font_bytes: uploadLimit }
}

export async function searchOnlineFonts(query: string, script: FontScript, page: number, signal?: AbortSignal): Promise<OnlineFontPage> {
  const [source, local] = await Promise.all([getCatalogue(), list<Stored>('fonts')])
  signal?.throwIfAborted()
  const stored = new Set(local.map(({ face }) => face.id))
  const parts = query.trim().split(/\s+/u).map(normalized).filter(Boolean)
  const wanted = normalized(query), scriptKeys = script === 'all' ? undefined : scripts[script]
  const results = source.fonts.flatMap((entry) => {
    if (scriptKeys && !scriptKeys.some((key) => entry.subsets.includes(key))) return []
    const titles = [entry.label, entry.id, ...entry.aliases].map(normalized)
    const searchable = [...titles, normalized(entry.category), ...entry.subsets.map((label) => normalized(scriptLabels[label] ?? label))]
    if (wanted && !searchable.some((value) => value.includes(wanted)) &&
      !parts.every((part) => searchable.some((value) => value.includes(part)))) return []
    return [{ entry, rank: titles.includes(wanted) ? 0 : titles.some((item) => item.startsWith(wanted)) ? 1 : 2 }]
  }).sort((a, b) => a.rank - b.rank)
  return {
    items: results.slice((page - 1) * 10, page * 10).map(({ entry }) => ({
      id: entry.id, label: entry.label, aliases: entry.aliases, installed: stored.has(entry.id), size_bytes: entry.font.size,
      style: [entry.category, ...entry.subsets.flatMap((key) => scriptLabels[key] ? [scriptLabels[key]] : []).slice(0, 3)].join(' · '),
      source_url: 'https://github.com/google/fonts/tree/' + source.revision + '/ofl/' + entry.id,
    })),
    total: results.length, page, page_size: 10,
  }
}

export async function namedCandidates(ids: string[]) {
  const [source, local] = await Promise.all([getCatalogue(), list<Stored>('fonts')])
  const cached = new Set(local.map(({ face }) => face.id))
  return ids.flatMap((id) => {
    const entry = source.fonts.find((item) => item.id === id)
    return entry ? [{ id, name: entry.label, size: entry.font.size, installed: cached.has(id) }] : []
  })
}

async function validate(binary: ArrayBuffer) {
  const covers = unicodeMap(binary)
  covers(65)
  await new FontFace('textmeld-check', binary).load()
}

async function saveFont(id: string, label: string, alias: string[], style: string, source: 'upload' | 'download',
  binary: ArrayBuffer, text: string, license?: ArrayBuffer): Promise<AddedFont> {
  try { await validate(binary) } catch { throw new Error('此文件无法作为 TTF 或 OTF 字体使用。') }
  if (!(await read('fonts', id))) {
    const data = new DataView(binary)
    const variable = Boolean(table(data, 'fvar'))
    const weightData = table(data, 'OS/2')
    const weight = weightData && weightData.byteLength >= 6 ? weightData.getUint16(4) || 400 : 400
    const files = await list<Stored>('fonts')
    if (files.length >= 48 || files.reduce((sum, item) => sum + item.binary.byteLength, binary.byteLength) > storedLimit)
      throw new Error('此浏览器的字体库已达容量上限。')
    await change<Stored>('fonts', id, (current) => current ?? { face: { id, label, aliases: alias, style, source,
      weights: variable ? [100, 200, 300, 400, 500, 600, 700, 800, 900] : [weight], default_weight: variable ? 400 : weight },
      binary, variable, license })
  }
  return { ...(await getFontCatalog(text)), added_id: id }
}

export async function uploadFont(file: File, text: string, signal: AbortSignal) {
  if (!/\.(ttf|otf)$/iu.test(file.name) || file.size > uploadLimit) throw new Error('请选择 24 MiB 以内的 TTF 或 OTF。')
  const buffer = await file.arrayBuffer()
  signal.throwIfAborted()
  const hash = toHex(await crypto.subtle.digest('SHA-256', buffer)).slice(0, 32)
  let family = ''
  try { family = familyName(buffer) } catch { throw new Error('无法读取此字体文件。') }
  return saveFont('font-' + hash, family || file.name, [file.name], '上传字体', 'upload', buffer, text)
}

async function fetchFontAsset(source: Catalogue, entry: Entry, asset: Asset, signal: AbortSignal) {
  const url = 'https://raw.githubusercontent.com/google/fonts/' + source.revision + '/ofl/' + entry.id + '/' + encodeURIComponent(asset.filename)
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error('字体源暂时无法下载。可改用已保存或上传的字体。')
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength !== asset.size) throw new Error('下载的文件未通过校验。')
  const header = new TextEncoder().encode('blob ' + asset.size + '\0')
  const object = new Uint8Array(header.length + bytes.byteLength)
  object.set(header); object.set(new Uint8Array(bytes), header.length)
  if (toHex(await crypto.subtle.digest('SHA-1', object)) !== asset.blob) throw new Error('下载的字体未通过校验。')
  return bytes
}

export async function downloadFont(id: string, text: string, signal: AbortSignal) {
  if (await read('fonts', id)) return { ...(await getFontCatalog(text)), added_id: id }
  const source = await getCatalogue()
  const entry = source.fonts.find((item) => item.id === id)
  if (!entry) throw new Error('此字体不在开放目录中。')
  const [binary, license] = await Promise.all([fetchFontAsset(source, entry, entry.font, signal), fetchFontAsset(source, entry, entry.license, signal)])
  signal.throwIfAborted()
  return saveFont(id, entry.label, entry.aliases, entry.category, 'download', binary, text, license)
}

export async function typeface(choice: FontChoice | undefined, text: string, serif = false): Promise<Typeface> {
  const key = choice?.family ?? (serif ? 'system-serif' : 'system-sans')
  const weight = choice?.weight ?? 400
  if (systems.some((item) => item.id === key)) return { key, weight, serif: key === 'system-serif' }
  const found = await read<Stored>('fonts', key)
  if (!found) throw new Error('请重新下载或上传这款字体。')
  const unsupported = missing(found.binary, text)
  if (unsupported.length) throw new Error('所选字体缺少字符：' + unsupported.slice(0, 10).join(' '))
  return { key, weight, binary: found.binary, variable: found.variable }
}

export function imageBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export async function previewFontSample(text: string, font: FontChoice, signal: AbortSignal) {
  const selected = await typeface(font, text)
  const { fonts } = await getFontCatalog(text)
  const face = fonts.find(({ id }) => id === font.family)
  const png = await vision<Blob>('sample', { options: { text, font: selected } }, signal)
  return { id: font.family, label: face?.label ?? font.family, style: face?.style ?? '', weight: font.weight, preview: await imageBase64(png) }
}
