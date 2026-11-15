import { useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react'
import { paintMarks } from './image'
import type { Mark, Point, SourceImage, Tool } from './image'
import Icon from './Icon'

type Props = {
  image: SourceImage
  sourceUrl: string
  editingUrl?: string
  resultUrl: string | null
  zoom: number
  tool: Tool
  brushSize: number
  marks: readonly Mark[]
  editable: boolean
  onMark: (mark: Mark) => void
}

type Gesture =
  | { pointer: number; mark: Mark }
  | { pointer: number; scroll: { left: number; top: number }; position: Point }

function pointAt(event: ReactPointerEvent<HTMLCanvasElement>, image: SourceImage): Point {
  const bounds = event.currentTarget.getBoundingClientRect()
  return {
    x: Math.max(0, Math.min(image.width, (event.clientX - bounds.left) * image.width / bounds.width)),
    y: Math.max(0, Math.min(image.height, (event.clientY - bounds.top) * image.height / bounds.height)),
  }
}

function extendMark(mark: Mark, point: Point): Mark {
  if (mark.kind === 'rectangle') return { ...mark, end: point }
  const previous = mark.points.at(-1)!
  if (mark.points.length >= 1024 || Math.hypot(point.x - previous.x, point.y - previous.y) < 0.5) return mark
  return { ...mark, points: [...mark.points, point] }
}

function ComparisonDivider({ stage, position, onPosition }: {
  stage: RefObject<HTMLDivElement | null>
  position: number
  onPosition: (position: number) => void
}) {
  const drag = useRef<{ pointer: number; offset: number } | null>(null)

  function begin(event: ReactPointerEvent<HTMLSpanElement>) {
    if (!event.isPrimary || event.button !== 0 || drag.current) return
    const bounds = stage.current?.getBoundingClientRect()
    if (!bounds?.width) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointer: event.pointerId, offset: event.clientX - bounds.left - bounds.width * position / 100 }
  }

  function move(event: ReactPointerEvent<HTMLSpanElement>) {
    const gesture = drag.current
    if (gesture?.pointer !== event.pointerId) return
    const bounds = stage.current?.getBoundingClientRect()
    if (!bounds?.width) return
    const next = 100 * (event.clientX - bounds.left - gesture.offset) / bounds.width
    onPosition(Math.round(Math.max(0, Math.min(100, next))))
  }

  function stop(event: ReactPointerEvent<HTMLSpanElement>) {
    if (drag.current?.pointer === event.pointerId) drag.current = null
  }

  function keyDown(event: KeyboardEvent<HTMLSpanElement>) {
    let next: number
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown': next = position - 1; break
      case 'ArrowRight':
      case 'ArrowUp': next = position + 1; break
      case 'PageDown': next = position - 10; break
      case 'PageUp': next = position + 10; break
      case 'Home': next = 0; break
      case 'End': next = 100; break
      default: return
    }
    event.preventDefault()
    onPosition(Math.max(0, Math.min(100, next)))
  }

  return <div className="compare-divider" data-split={position > 0 && position < 100} style={{ left: `${position}%` }}>
    <span className="compare-handle" role="slider" tabIndex={0} aria-label="图片对比手柄"
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={position}
      aria-valuetext={`原图 ${position}%，结果 ${100 - position}%`}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={(event) => { move(event); stop(event) }}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onKeyDown={keyDown}>
      <Icon name="split" />
    </span>
  </div>
}

export default function ImageStage({ image, sourceUrl, editingUrl, resultUrl, zoom, tool, brushSize, marks, editable, onMark }: Props) {
  const viewport = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const active = useRef<Gesture | null>(null)
  const [viewportSize, setViewportSize] = useState({ width: 320, height: 360 })
  const [draft, setDraft] = useState<Mark | null>(null)
  const [divider, setDivider] = useState(0)
  const comparison = 100 - divider
  const scale = Math.max(0.01, Math.min((viewportSize.width - 30) / image.width, (viewportSize.height - 30) / image.height, 2))
  const displayScale = scale * (resultUrl ? 1 : zoom)

  useLayoutEffect(() => {
    const node = viewport.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => setViewportSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const context = canvas.current?.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, image.width, image.height)
    if (draft?.kind !== 'rectangle' && !(draft?.kind === 'brush' && marks[0]?.kind === 'rectangle')) {
      paintMarks(context, marks, 'rgba(206, 69, 46, 0.19)')
    }
    if (draft) paintMarks(context, [draft], 'rgba(206, 69, 46, 0.31)')
  }, [image, marks, draft, resultUrl])

  useLayoutEffect(() => {
    const node = viewport.current
    if (node) {
      node.scrollLeft = (node.scrollWidth - node.clientWidth) / 2
      node.scrollTop = (node.scrollHeight - node.clientHeight) / 2
    }
  }, [zoom, resultUrl])

  function begin(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!editable || event.button !== 0 || active.current) return
    const node = viewport.current!
    event.currentTarget.setPointerCapture(event.pointerId)

    if (tool === 'pan') {
      active.current = {
        pointer: event.pointerId,
        scroll: { left: node.scrollLeft, top: node.scrollTop },
        position: { x: event.clientX, y: event.clientY },
      }
      return
    }

    const point = pointAt(event, image)
    const mark: Mark = tool === 'rectangle'
      ? { kind: 'rectangle', start: point, end: point }
      : { kind: 'brush', points: [point], diameter: brushSize }
    active.current = { pointer: event.pointerId, mark }
    setDraft(mark)
  }

  function move(event: ReactPointerEvent<HTMLCanvasElement>) {
    const gesture = active.current
    if (!gesture || gesture.pointer !== event.pointerId) return
    if ('scroll' in gesture) {
      viewport.current?.scrollTo(
        gesture.scroll.left - (event.clientX - gesture.position.x),
        gesture.scroll.top - (event.clientY - gesture.position.y),
      )
    } else {
      gesture.mark = extendMark(gesture.mark, pointAt(event, image))
      setDraft(gesture.mark)
    }
  }

  function finish(event: ReactPointerEvent<HTMLCanvasElement>, cancelled: boolean) {
    const gesture = active.current
    if (!gesture || gesture.pointer !== event.pointerId) return
    active.current = null
    setDraft(null)
    if (cancelled || !editable || !('mark' in gesture)) return

    const mark = extendMark(gesture.mark, pointAt(event, image))
    if (mark.kind === 'rectangle' && (Math.abs(mark.start.x - mark.end.x) < 2 || Math.abs(mark.start.y - mark.end.y) < 2)) return
    onMark(mark)
  }

  return <>
    <div className="image-viewport stage-grid" ref={viewport}>
      <div className="image-centering">
        <div className="image-stage" ref={stage} style={{ width: image.width * displayScale, height: image.height * displayScale }}>
          <img src={resultUrl ? sourceUrl : editingUrl ?? sourceUrl} alt="画布图像" draggable={false} />
          {resultUrl ? <>
            <img className="result-layer" src={resultUrl} alt="改字结果" draggable={false} style={{ clipPath: `inset(0 0 0 ${divider}%)` }} />
            <ComparisonDivider stage={stage} position={divider} onPosition={setDivider} />
            {comparison <= 88 && <span className="compare-tag compare-original">原图</span>}
            {comparison >= 12 && <span className="compare-tag compare-result">结果</span>}
          </> : <canvas
            ref={canvas}
            aria-label="图片选区画布"
            width={image.width}
            height={image.height}
            className={`selection-canvas ${editable ? `tool-${tool}` : ''}`}
            onPointerDown={begin}
            onPointerMove={move}
            onPointerUp={(event) => finish(event, false)}
            onPointerCancel={(event) => finish(event, true)}
            onLostPointerCapture={(event) => finish(event, true)}
            onContextMenu={(event) => event.preventDefault()}
          />}
        </div>
      </div>
    </div>
    {resultUrl && <label className="comparison-control">
      <span>原图</span>
      <input type="range" aria-label="原图和结果对比" min="0" max="100" value={comparison} onChange={(event) => setDivider(100 - event.currentTarget.valueAsNumber)} />
      <span>结果</span>
    </label>}
  </>
}
