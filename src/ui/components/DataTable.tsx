/**
 * Tableau triable, filtrable et compact. Le tri s'appuie sur `value(row)` (nombre ou chaîne) et
 * l'affichage sur `format(row)` ; une ligne peut être sélectionnée (surbrillance + clic vers la carte).
 * `maxRows` borne le rendu : sur un réseau de plusieurs milliers de tronçons, seules les premières
 * lignes du tri courant sont montées dans le DOM.
 *
 * Un champ de recherche apparaît dès que la liste dépasse `SEUIL_RECHERCHE` lignes. Il porte sur les
 * colonnes textuelles (nom du tronçon, classe, régulation…) et s'applique avant le bornage : une voie
 * cherchée par son nom est trouvée même si son rang de tri la plaçait au-delà des lignes affichées.
 */
import { useMemo, useState } from 'react'
import type { JSX } from 'react'
import { ChampRecherche } from '@/ui/components/ChampRecherche'
import { SEUIL_RECHERCHE, filtrer } from '@/ui/components/recherche'
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
  /** Ce que le tableau liste, pour l'étiquette du champ de recherche : « les tronçons ». */
  searchLabel?: string
}

const collator = new Intl.Collator('fr-FR', { numeric: true, sensitivity: 'base' })

function cellText<T>(column: DataTableColumn<T>, row: T): string {
  if (column.format) return column.format(row)
  const v = column.value(row)
  return typeof v === 'number' ? formatNumber(v, Number.isInteger(v) ? 0 : 1) : v
}

export function DataTable<T>(props: DataTableProps<T>): JSX.Element {
  const { columns, rows, rowKey, onRowClick, selectedKey, initialSort, maxRows, searchLabel } = props
  const [sort, setSort] = useState(initialSort ?? null)
  const [requete, setRequete] = useState('')

  const filtered = useMemo(
    () => filtrer(rows, requete, (row) => columns.filter((c) => typeof c.value(row) === 'string').map((c) => cellText(c, row))),
    [rows, columns, requete],
  )

  const sorted = useMemo(() => {
    if (!sort) return filtered
    const column = columns.find((c) => c.key === sort.key)
    if (!column) return filtered
    const sign = sort.dir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      const va = column.value(a)
      const vb = column.value(b)
      if (typeof va === 'number' && typeof vb === 'number') return sign * (va - vb)
      return sign * collator.compare(String(va), String(vb))
    })
  }, [filtered, columns, sort])

  const visible = maxRows !== undefined ? sorted.slice(0, maxRows) : sorted
  const filtre = filtered.length !== rows.length

  function toggle(key: string): void {
    setSort((current) => {
      if (!current || current.key !== key) return { key, dir: 'desc' }
      return { key, dir: current.dir === 'desc' ? 'asc' : 'desc' }
    })
  }

  const notes: string[] = []
  // Le décompte n'accompagne que des lignes visibles : sans résultat, seul « Aucun résultat » s'affiche.
  if (filtre && filtered.length) {
    notes.push(S.recherche.resultats.replace('{n}', formatNumber(filtered.length)).replace('{total}', formatNumber(rows.length)))
  }
  if (visible.length < sorted.length) {
    notes.push(S.resultats.lignesAffichees.replace('{n}', formatNumber(visible.length)).replace('{total}', formatNumber(sorted.length)))
  }

  return (
    <>
      {rows.length >= SEUIL_RECHERCHE ? (
        <ChampRecherche value={requete} onChange={setRequete} label={searchLabel ?? S.resultats.titre} />
      ) : null}
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
        {!visible.length && rows.length ? <p className="table-note">{S.recherche.aucune}</p> : null}
        {notes.length ? <p className="table-note">{notes.join(' · ')}</p> : null}
      </div>
    </>
  )
}
