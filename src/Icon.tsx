import type { SVGProps } from 'react'

const paths = {
  brand: 'M4 9V4h5m6 0h5v5m0 6v5h-5m-6 0H4v-5m4-6h8m-4 0v8',
  upload: 'M12 16V3m-5 5 5-5 5 5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
  photo: 'M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Zm0 12 5-5 4 4 3-3 4 4m-4-9h.01',
  rectangle: 'M4 9V4h5m6 0h5v5m0 6v5h-5m-6 0H4v-5',
  brush: 'M14.5 6.5 17 9m-7.2 6.2 9.8-9.8a1.8 1.8 0 0 0-2.6-2.6l-9.8 9.8m2.6 2.6c.8 1.1.7 2.8-.4 3.9-1.7 1.7-4.8 1.9-6.4 1.9 1.3-1.3 1.8-2.9 2-4.1.4-2.5 3.2-3.8 4.8-1.7Z',
  hand: 'M8 13V5a1.5 1.5 0 0 1 3 0v6-8a1.5 1.5 0 0 1 3 0v8-6a1.5 1.5 0 0 1 3 0v7-3a1.5 1.5 0 0 1 3 0v5c0 5-2.5 8-7 8-2 0-4-1-5-3l-4-6a1.5 1.5 0 0 1 2.4-1.8L8 13Z',
  undo: 'M8 5 3 10l5 5m-5-5h11a6 6 0 0 1 0 12',
  trash: 'M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7m4 4v6m4-6v6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  download: 'M12 3v13m-5-5 5 5 5-5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
  arrow: 'M4 12h15m-6-6 6 6-6 6',
  edit: 'm14 5 5 5M4 16 16 4a2.8 2.8 0 0 1 4 4L8 20l-5 1Z',
  compare: 'M12 3v18M9 5H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4m6 0h4a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-4',
  check: 'm5 12 5 5L20 7',
  alert: 'M12 8v4m0 4h.01M10 4l-8 14a2 2 0 0 0 2 3h16a2 2 0 0 0 2-3L14 4a2.3 2.3 0 0 0-4 0Z',
  split: 'm9 8-4 4 4 4m6-8 4 4-4 4',
  settings: 'M4 7h4m4 0h8M4 17h8m4 0h4M8 4v6m8 4v6',
  close: 'm6 6 12 12M18 6 6 18',
} as const

export default function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: keyof typeof paths }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <path d={paths[name]} />
  </svg>
}
