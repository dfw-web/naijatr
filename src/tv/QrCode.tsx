import { useMemo } from 'react'
import qrcode from 'qrcode-generator'

interface QrCodeProps {
  url: string
  /** Rendered width and height in CSS (the code scales cleanly). */
  size?: string
  label: string
}

/** A QR code as an inline SVG (sharp at any size, no image request). */
export function QrCode({ url, size = '10rem', label }: QrCodeProps) {
  const { path, count } = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(url)
    qr.make()
    const n = qr.getModuleCount()
    let d = ''
    for (let row = 0; row < n; row += 1) {
      for (let col = 0; col < n; col += 1) {
        if (qr.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`
      }
    }
    return { path: d, count: n }
  }, [url])

  // A 2-module white border (the "quiet zone") so phones can read it on a dark page.
  return (
    <svg
      className="qr-code"
      role="img"
      aria-label={label}
      viewBox={`-2 -2 ${count + 4} ${count + 4}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
    >
      <rect x="-2" y="-2" width={count + 4} height={count + 4} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}
