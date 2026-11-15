import { copyFile, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const runtime = 'public/runtime'
const files = ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']
await mkdir(runtime, { recursive: true })
for (const name of files) await copyFile(join('node_modules/onnxruntime-web/dist', name), join(runtime, name))
const notices = [
  ['node_modules/onnxruntime-web/LICENSE', 'ONNX-RUNTIME-LICENSE.txt'],
  ['node_modules/@techstark/opencv-js/LICENSE', 'OPENCV-JS-LICENSE.txt'],
]
for (const [source, name] of notices) {
  if (await stat(source).catch(() => undefined)) await copyFile(source, join('public', name))
}
