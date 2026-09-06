/**
 * Courbe temporelle en SVG (aucune bibliothèque de graphiques).
 *
 * Règles de lecture appliquées : une seule échelle verticale (toutes les séries partagent l'unité),
 * traits fins, grille discrète, légende dès deux séries, curseur de survol avec les valeurs de l'instant.
 * Le SVG est dessiné à l'échelle réelle du conteneur (mesuré par `ResizeObserver`) : le texte reste net.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { JSX, PointerEvent } from 'react'
import { formatClock, formatNumber } from '@/ui/strings'

export interface LineChartSeries {
  label: string
  color: string
  values: number[]
}

export interface LineChartProps {
  series: LineChartSeries[]
  /** Instants (s) correspondant aux valeurs. */
  times: number[]
  unit?: string
  height?: number
}

const PADDING = { top: 8, right: 10, bottom: 18, left: 44 }
const DEFAULT_HEIGHT = 120
const FALLBACK_WIDTH = 320

/** Pas de graduation « rond » couvrant `span` en ~4 intervalles. */
function niceStep(span: number): number {
  if (span <= 0) return 1
  const raw = span / 4
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const normalized = raw / magnitude
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10
  return step * magnitude
}

function tickDigits(step: number): number {
  if (step >= 10) return 0
  if (step >= 1) return step % 1 === 0 ? 0 : 1
  return Math.min(3, Math.ceil(-Math.log10(step)))
}

export function LineChart(props: LineChartProps): JSX.Element {
  const { series, times, unit, height = DEFAULT_HEIGHT } = props
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(FALLBACK_WIDTH)
  const [cursor, setCursor] = useState<number | null>(null)

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width)
      if (w > 0) setWidth(w)
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  // Le curseur pointe un index : il doit rester valide quand la série s'allonge ou se raccourcit.
  useEffect(() => {
    setCursor((c) => (c === null || c < times.length ? c : null))
  }, [times.length])

  const count = Math.min(times.length, ...series.map((s) => s.values.length))
  if (!series.length || count === 0) {
    return <div className="chart empty" ref={hostRef} style={{ height }} />
  }

  let max = 0
  let min = 0
  for (const s of series) {
    for (let i = 0; i < count; i++) {
      const v = s.values[i]
      if (!Number.isFinite(v)) continue
      if (v > max) max = v
      if (v < min) min = v
    }
  }
  if (max === min) max = min + 1

  const step = niceStep(max - min)
  const top = Math.ceil(max / step) * step
  const bottom = Math.floor(min / step) * step
  const digits = tickDigits(step)

  const plotW = Math.max(10, width - PADDING.left - PADDING.right)
  const plotH = Math.max(10, height - PADDING.top - PADDING.bottom)
  const x = (i: number): number => PADDING.left + (count === 1 ? plotW / 2 : (i * plotW) / (count - 1))
  const y = (v: number): number => PADDING.top + plotH - ((v - bottom) / (top - bottom)) * plotH

  const ticks: number[] = []
  for (let v = bottom; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6)

  function path(values: number[]): string {
    let d = ''
    for (let i = 0; i < count; i++) {
      const v = values[i]
      if (!Number.isFinite(v)) continue
      d += `${d ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`
    }
    return d
  }

  function pick(event: PointerEvent<SVGSVGElement>): void {
    const rect = event.currentTarget.getBoundingClientRect()
    const px = event.clientX - rect.left
    const i = count === 1 ? 0 : Math.round(((px - PADDING.left) / plotW) * (count - 1))
    setCursor(Math.max(0, Math.min(count - 1, i)))
  }

  const tooltipRight = cursor !== null && x(cursor) > PADDING.left + plotW * 0.6

  return (
    <div className="chart" ref={hostRef}>
      {series.length > 1 ? (
        <ul className="chart-legend">
          {series.map((s) => (
            <li key={s.label}>
              <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
              {s.label}
            </li>
          ))}
        </ul>
      ) : null}
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={series.map((s) => s.label).join(', ')}
        onPointerMove={pick}
        onPointerLeave={() => setCursor(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={PADDING.left} x2={PADDING.left + plotW} y1={y(t)} y2={y(t)} />
            <text className="axis" x={PADDING.left - 5} y={y(t) + 3} textAnchor="end">{formatNumber(t, digits)}</text>
          </g>
        ))}
        <text className="axis" x={PADDING.left} y={height - 5}>{formatClock(times[0])}</text>
        <text className="axis" x={PADDING.left + plotW} y={height - 5} textAnchor="end">{formatClock(times[count - 1])}</text>
        {series.map((s) => (
          count === 1
            ? <circle key={s.label} cx={x(0)} cy={y(s.values[0])} r={4} fill={s.color} />
            : <path key={s.label} className="serie" d={path(s.values)} stroke={s.color} />
        ))}
        {cursor !== null ? (
          <g>
            <line className="cursor" x1={x(cursor)} x2={x(cursor)} y1={PADDING.top} y2={PADDING.top + plotH} />
            {series.map((s) => (
              Number.isFinite(s.values[cursor])
                ? <circle key={s.label} cx={x(cursor)} cy={y(s.values[cursor])} r={3.5} fill={s.color} stroke="#fff" strokeWidth={1.5} />
                : null
            ))}
            <g transform={`translate(${tooltipRight ? x(cursor) - 8 : x(cursor) + 8}, ${PADDING.top + 4})`}>
              <text className="tooltip" textAnchor={tooltipRight ? 'end' : 'start'}>
                <tspan x={0} dy={0}>{formatClock(times[cursor])}</tspan>
                {series.map((s) => (
                  <tspan key={s.label} x={0} dy={11}>
                    {`${series.length > 1 ? `${s.label} : ` : ''}${formatNumber(s.values[cursor], digits)}${unit ? ` ${unit}` : ''}`}
                  </tspan>
                ))}
              </text>
            </g>
          </g>
        ) : null}
      </svg>
    </div>
  )
}
