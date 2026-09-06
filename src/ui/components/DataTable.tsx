/**
 * Tableau triable et compact. Le tri s'appuie sur `value(row)` (nombre ou chaîne) et l'affichage sur
 * `format(row)` ; une ligne peut être sélectionnée (surbrillance + clic vers la carte).
 * `maxRows` borne le rendu : sur un réseau de plusieurs milliers de tronçons, seules les premières
 * lignes du tri courant sont montées dans le DOM.
 */
import { useMemo, useState } from 'react'
import type { JSX } from 'react'
import { S, formatNumber } from '@/ui/strings'

export interface DataTableColumn<T> {
  key: string
  label: string
  align?: 'left' | 'right'
  format?(row: T): string
  value(row: T): number | string
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[]
  rows: T[]
  rowKey(row: T): string
  onRowClick?(row: T): void
  selectedKey?: string
  initialSort?: { key: string; dir: 'asc' | 'desc' }
  maxRows?: number
}

const collator = new Intl.Collator('fr-FR', { numeric: true, sensitivity: 'base' })

function cellText<T>(column: DataTableColumn<T>, row: T): string {
  if (column.format) return column.format(row)
  const v = column.value(row)
  return typeof v === 'number' ? formatNumber(v, Number.isInteger(v) ? 0 : 1) : v
}

export function DataTable<T>(props: DataTableProps<T>): JSX.Element {
  const { columns, rows, rowKey, onRowClick, selectedKey, initialSort, maxRows } = props
  const [sort, setSort] = useState(initialSort ?? null)

  const sorted = useMemo(() => {
    if (!sort) return rows
    const column = columns.find((c) => c.key === sort.key)
    if (!column) return rows
    const sign = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const va = column.value(a)
      const vb = column.value(b)
      if (typeof va === 'number' && typeof vb === 'number') return sign * (va - vb)
      return sign * collator.compare(String(va), String(vb))
    })
  }, [rows, columns, sort])

  const visible = maxRows !== undefined ? sorted.slice(0, maxRows) : sorted

  function toggle(key: string): void {
    setSort((current) => {
      if (!current || current.key !== key) return { key, dir: 'desc' }
      return { key, dir: current.dir === 'desc' ? 'asc' : 'desc' }
    })
  }

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={c.align === 'right' ? 'right' : undefined}
                aria-sort={sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                <button type="button" onClick={() => toggle(c.key)}>
                  {c.label}
                  <span className="sort-mark">{sort?.key === c.key ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => {
            const key = rowKey(row)
            return (
              <tr
                key={key}
                className={key === selectedKey ? 'selected' : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(row) } : undefined}
              >
                {columns.map((c) => (
                  <td key={c.key} className={c.align === 'right' ? 'right' : undefined}>{cellText(c, row)}</td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
      {visible.length < sorted.length ? (
        <p className="table-note">
          {S.resultats.lignesAffichees.replace('{n}', formatNumber(visible.length)).replace('{total}', formatNumber(sorted.length))}
        </p>
      ) : null}
    </div>
  )
}
