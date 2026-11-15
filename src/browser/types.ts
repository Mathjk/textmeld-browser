import type { TextOrientation } from '../drafts'

export type Box = { x: number; y: number; width: number; height: number }
export type Letter = { text: string; position: number; left: number; right: number }
export type Prepared = {
  crop: Box
  originalImage: Blob
  background: Blob
  erase: Uint8Array
  matrix: number[]
  plane: { width: number; height: number }
  ink: Box
  color: number[]
  original: string
  letters: Letter[]
  orientation: TextOrientation
  candidates: string[]
  softness: number
}
export type Typeface = { key: string; weight: number; binary?: ArrayBuffer; serif?: boolean; variable?: boolean }
export type RenderOptions = { text: string; font: Typeface; spacing?: number; texture?: boolean }
export type Output = { patch: Blob; preview: Blob; softened: boolean }

export type WorkerActions = {
  prepare: { image: Blob; mask: Blob; orientation: TextOrientation }
  render: { prepared: Prepared; options: RenderOptions }
  sample: { options: RenderOptions }
}
