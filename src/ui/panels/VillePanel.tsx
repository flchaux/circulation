/**
 * Panneau « Ville » : recherche de commune (autocomplete geo.api.gouv.fr), démonstrations embarquées,
 * bibliothèque de projets, bilan de l'import OSM et attribution des données.
 *
 * La recherche est débattue de 250 ms et chaque frappe annule la requête précédente (`AbortController`),
 * de sorte qu'une saisie rapide ne produit qu'un appel réseau.
 */
import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { useAppStore } from '@/state/store'
import { searchCommunes } from '@/geo/communes'
import type { CommuneSummary } from '@/geo/types'
import { ATTRIBUTION } from '@/model/defaults'
import { S, formatDateTime, formatNumber } from '@/ui/strings'

/** Extraits livrés avec l'application (public/demo). */
const DEMOS: { slug: string; nom: string; detail: string }[] = [
  { slug: 'veauche', nom: 'Veauche', detail: '42340 · 8 975 habitants' },
  { slug: 'saint-just-saint-rambert', nom: 'Saint-Just-Saint-Rambert', detail: '42170 · 15 764 habitants' },
]

const DEBOUNCE_MS = 250

type SearchStatus = 'idle' | 'incomplete' | 'loading' | 'done' | 'error'

export function VillePanel(): JSX.Element {
  const project = useAppStore((s) => s.project)
  const library = useAppStore((s) => s.library)
  const busy = useAppStore((s) => s.busy)
  const loadCommune = useAppStore((s) => s.loadCommune)
  const loadDemo = useAppStore((s) => s.loadDemo)
  const loadFromLibrary = useAppStore((s) => s.loadFromLibrary)
  const deleteFromLibrary = useAppStore((s) => s.deleteFromLibrary)

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CommuneSummary[]>([])
  const [status, setStatus] = useState<SearchStatus>('idle')
  const [searchError, setSearchError] = useState('')

  useEffect(() => {
    const q = query.trim()
    if (!q) { setResults([]); setStatus('idle'); return }
    if (/^\d{1,4}$/.test(q)) { setResults([]); setStatus('incomplete'); return }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setStatus('loading')
      searchCommunes(q, controller.signal)
        .then((list) => { setResults(list); setStatus('done') })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          setResults([])
          setStatus('error')
          setSearchError(error instanceof Error ? error.message : String(error))
        })
    }, DEBOUNCE_MS)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query])

  const commune = project?.meta.commune
  const importInfo = project?.meta.import
  const stats = importInfo?.stats

  return (
    <div className="panel">
      <section className="block">
        <h2>{S.ville.titre}</h2>
        <label className="field">
          <span className="field-label">{S.ville.recherche}</span>
          <span className="field-input">
            <input
              type="search"
              value={query}
              placeholder={S.ville.recherchePlaceholder}
              autoComplete="off"
              onChange={(e) => setQuery(e.target.value)}
              data-testid="recherche-commune"
            />
          </span>
        </label>
        {status === 'incomplete' ? <p className="hint">{S.ville.codePostalIncomplet}</p> : null}
        {status === 'loading' ? <p className="hint">{S.ville.rechercheEnCours}</p> : null}
        {status === 'error' ? <p className="hint error">{searchError}</p> : null}
        {status === 'done' && !results.length ? <p className="hint">{S.ville.aucunResultat}</p> : null}
        {results.length ? (
          <ul className="list">
            {results.map((c) => (
              <li key={c.code}>
                <button type="button" className="list-row" disabled={busy.active} onClick={() => void loadCommune(c)}>
                  <span className="list-main">{c.nom}</span>
                  <span className="list-side">
                    {c.codesPostaux[0] ?? c.code}
                    {c.population ? ` · ${formatNumber(c.population)} ${S.ville.habitants}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {busy.active ? (
          <p className="progress" role="status">
            <span className="spinner" aria-hidden="true" />
            {busy.message || S.app.chargement}
          </p>
        ) : null}
      </section>

      <section className="block">
        <h3>{S.ville.demos}</h3>
        <p className="hint">{S.ville.demoAide}</p>
        <ul className="list">
          {DEMOS.map((demo) => (
            <li key={demo.slug}>
              <button
                type="button"
                className="list-row"
                disabled={busy.active}
                onClick={() => void loadDemo(demo.slug)}
                data-testid={`demo-${demo.slug}`}
              >
                <span className="list-main">{demo.nom}</span>
                <span className="list-side">{demo.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="block">
        <h3>{S.ville.bibliotheque}</h3>
        {library.length ? (
          <ul className="list">
            {library.map((entry) => (
              <li key={entry.id} className="list-item">
                <button type="button" className="list-row" disabled={busy.active} onClick={() => void loadFromLibrary(entry.id)}>
                  <span className="list-main">{entry.name}</span>
                  <span className="list-side">
                    {formatDateTime(entry.updatedAt)} · {formatNumber(entry.edgeCount)} {S.ville.troncons}
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-button danger"
                  title={S.ville.supprimer}
                  aria-label={`${S.ville.supprimer} : ${entry.name}`}
                  onClick={() => { if (confirm(S.ville.confirmerSuppression)) void deleteFromLibrary(entry.id) }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">{S.ville.bibliothequeVide}</p>
        )}
      </section>

      <section className="block">
        <h3>{S.ville.reseau}</h3>
        {project ? (
          <>
            <dl className="stats">
              {commune ? <><dt>{S.ville.titre}</dt><dd>{commune.nom} ({commune.code})</dd></> : null}
              {stats ? (
                <>
                  <dt>{S.ville.statsWays}</dt><dd>{formatNumber(stats.ways)}</dd>
                  <dt>{S.ville.statsEdges}</dt><dd>{formatNumber(stats.edges)}</dd>
                  <dt>{S.ville.statsNodes}</dt><dd>{formatNumber(stats.nodes)}</dd>
                  <dt>{S.ville.statsEntries}</dt><dd>{formatNumber(stats.entries)}</dd>
                  <dt>{S.ville.statsExits}</dt><dd>{formatNumber(stats.exits)}</dd>
                  <dt>{S.ville.statsControllers}</dt><dd>{formatNumber(stats.controllers)}</dd>
                  <dt>{S.ville.statsStops}</dt><dd>{formatNumber(stats.stops)}</dd>
                  <dt>{S.ville.statsGiveWays}</dt><dd>{formatNumber(stats.giveWays)}</dd>
                  <dt>{S.ville.statsRestrictions}</dt><dd>{formatNumber(stats.restrictions)}</dd>
                  <dt>{S.ville.statsDropped}</dt><dd>{formatNumber(stats.droppedEdges)}</dd>
                </>
              ) : (
                <>
                  <dt>{S.ville.statsEdges}</dt><dd>{formatNumber(Object.keys(project.network.edges).length)}</dd>
                  <dt>{S.ville.statsNodes}</dt><dd>{formatNumber(Object.keys(project.network.nodes).length)}</dd>
                </>
              )}
            </dl>
            {commune ? (
              <button
                type="button"
                className="button"
                disabled={busy.active}
                title={S.ville.rechargerAide}
                onClick={() => void loadCommune({
                  nom: commune.nom,
                  code: commune.code,
                  codesPostaux: commune.codesPostaux,
                  centre: { type: 'Point', coordinates: [project.meta.center.lon, project.meta.center.lat] },
                  ...(commune.population !== undefined ? { population: commune.population } : {}),
                }, { refresh: true })}
              >
                {S.ville.rechargerOsm}
              </button>
            ) : null}
            <h4>{S.ville.avertissements}</h4>
            {importInfo?.warnings.length ? (
              <ul className="warnings">
                {importInfo.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            ) : (
              <p className="hint">{S.ville.avertissementsAucun}</p>
            )}
          </>
        ) : (
          <p className="hint">{S.ville.aucunReseau}</p>
        )}
      </section>

      <section className="block">
        <h3>{S.ville.attribution}</h3>
        <p className="hint">{project?.meta.attribution || ATTRIBUTION}</p>
      </section>
    </div>
  )
}
