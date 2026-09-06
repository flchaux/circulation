/**
 * Panneau « Comparer » : fige un scénario de référence, puis met en regard la référence et la variante
 * courante — synthèse du réseau, écarts par tronçon et par sortie, bascule de la carte en mode delta.
 *
 * La comparaison n'a de sens qu'à variables aléatoires communes : tant que la graine et la demande sont
 * inchangées, les deux exécutions injectent exactement les mêmes véhicules et les écarts ne viennent que
 * des modifications de voirie ou de signalisation.
 */
import { useMemo, useState } from 'react'
import type { JSX } from 'react'
import { useAppStore } from '@/state/store'
import type { EdgeId, NodeId, Project, ReferenceSnapshot, SimResults } from '@/model/types'
import type { ColorMode } from '@/state/storeTypes'
import { DataTable } from '@/ui/components/DataTable'
import type { DataTableColumn } from '@/ui/components/DataTable'
import { S, formatDateTime, formatDuration, formatNumber, formatSigned } from '@/ui/strings'

/** Bornage du rendu des tableaux d'écarts. */
const MAX_ROWS = 200

/** Nombre de lignes du journal des modifications affichées. */
const MAX_CHANGES = 30

/* ------------------------------------------------------------------ */
/*  Synthèse réseau                                                    */
/* ------------------------------------------------------------------ */

interface SummaryMetric {
  key: string
  label: string
  value(results: SimResults): number
  /** Mise en forme d'une valeur absolue (référence et variante). */
  format(value: number): string
  /** Mise en forme de l'écart (signé). */
  formatDelta(value: number): string
}

const SUMMARY_METRICS: SummaryMetric[] = [
  {
    key: 'entered',
    label: S.resultats.entres,
    value: (r) => r.network.entered,
    format: (v) => formatNumber(v),
    formatDelta: (v) => formatSigned(v),
  },
  {
    key: 'exited',
    label: S.resultats.sortis,
    value: (r) => r.network.exited,
    format: (v) => formatNumber(v),
    formatDelta: (v) => formatSigned(v),
  },
  {
    key: 'inCirculation',
    label: S.resultats.enCirculation,
    value: (r) => r.network.inCirculation,
    format: (v) => formatNumber(v),
    formatDelta: (v) => formatSigned(v),
  },
  {
    key: 'notInjected',
    label: S.resultats.nonInjectes,
    value: (r) => r.network.notInjected,
    format: (v) => formatNumber(v),
    formatDelta: (v) => formatSigned(v),
  },
  {
    key: 'meanDelay',
    label: `${S.resultats.retardMoyen} (${S.unites.s})`,
    value: (r) => r.network.meanDelayS,
    format: (v) => formatNumber(v, 1),
    formatDelta: (v) => formatSigned(v, 1),
  },
  {
    key: 'totalDelay',
    label: S.resultats.retardTotal,
    value: (r) => r.network.totalDelayS,
    format: (v) => formatDuration(v),
    formatDelta: (v) => `${formatSigned(v / 60, 1)} ${S.unites.min}`,
  },
  {
    key: 'travelTime',
    label: `${S.resultats.tempsParcours} (${S.unites.s})`,
    value: (r) => r.network.meanTravelTimeS,
    format: (v) => formatNumber(v, 1),
    formatDelta: (v) => formatSigned(v, 1),
  },
  {
    key: 'vehKm',
    label: `${S.resultats.vehKm} (${S.unites.vehKm})`,
    value: (r) => r.network.vehKm,
    format: (v) => formatNumber(v, 1),
    formatDelta: (v) => formatSigned(v, 1),
  },
]

/* ------------------------------------------------------------------ */
/*  Lignes d'écarts                                                    */
/* ------------------------------------------------------------------ */

interface EdgeDeltaRow {
  id: EdgeId
  nom: string
  retard: number
  debit: number
  fileMax: number
}

interface ExitDeltaRow {
  id: NodeId
  nom: string
  vehicules: number
  parcours: number
  retard: number
}

function buildEdgeDeltas(variant: SimResults, reference: SimResults, project: Project): EdgeDeltaRow[] {
  const rows: EdgeDeltaRow[] = []
  for (const [id, stats] of Object.entries(variant.edges)) {
    const ref = reference.edges[id]
    if (!ref) continue
    const row: EdgeDeltaRow = {
      id,
      nom: project.network.edges[id]?.name ?? id,
      retard: stats.meanDelayS - ref.meanDelayS,
      debit: stats.flowVehH - ref.flowVehH,
      fileMax: stats.maxQueue - ref.maxQueue,
    }
    // Un tronçon strictement identique dans les deux exécutions n'apporte rien à la lecture.
    if (row.retard !== 0 || row.debit !== 0 || row.fileMax !== 0) rows.push(row)
  }
  return rows
}

function buildExitDeltas(variant: SimResults, reference: SimResults, project: Project): ExitDeltaRow[] {
  const rows: ExitDeltaRow[] = []
  for (const [id, stats] of Object.entries(variant.exits)) {
    const ref = reference.exits[id]
    if (!ref) continue
    rows.push({
      id,
      nom: project.demand.exits[id]?.label ?? project.network.nodes[id]?.label ?? id,
      vehicules: stats.count - ref.count,
      parcours: stats.meanTravelTimeS - ref.meanTravelTimeS,
      retard: stats.meanDelayS - ref.meanDelayS,
    })
  }
  return rows
}

/* ------------------------------------------------------------------ */
/*  Panneau                                                            */
/* ------------------------------------------------------------------ */

export function ComparerPanel(): JSX.Element {
  const project = useAppStore((s) => s.project)
  const liveResults = useAppStore((s) => s.sim.results)
  const colorMode = useAppStore((s) => s.ui.colorMode)
  const selection = useAppStore((s) => s.selection)
  const [label, setLabel] = useState('')

  // Variante : résultats de la simulation en cours, sinon les derniers résultats enregistrés dans le projet.
  const variant = liveResults ?? project?.lastResults ?? null
  const reference: ReferenceSnapshot | undefined = project?.reference
  const refResults = reference?.results ?? null

  const edgeRows = useMemo(
    () => (variant && refResults && project ? buildEdgeDeltas(variant, refResults, project) : []),
    [variant, refResults, project],
  )
  const exitRows = useMemo(
    () => (variant && refResults && project ? buildExitDeltas(variant, refResults, project) : []),
    [variant, refResults, project],
  )

  if (!project) return <div className="panel"><p className="hint">{S.app.aucunProjet}</p></div>

  const store = useAppStore.getState()
  const sameSeed = !!reference && reference.demand.seed === project.demand.seed
  const changes = reference
    ? project.changes.filter((c) => c.at >= reference.frozenAt).slice(-MAX_CHANGES).reverse()
    : []

  // Le tri par défaut porte sur la valeur absolue de l'écart : `value` renvoie |Δ|, `format` affiche le signe.
  const edgeColumns: DataTableColumn<EdgeDeltaRow>[] = [
    { key: 'nom', label: S.resultats.col.troncon, value: (r) => r.nom },
    { key: 'retard', label: S.comparer.ecartRetard, align: 'right', value: (r) => Math.abs(r.retard), format: (r) => formatSigned(r.retard, 1) },
    { key: 'debit', label: S.comparer.ecartDebit, align: 'right', value: (r) => Math.abs(r.debit), format: (r) => formatSigned(r.debit) },
    { key: 'fileMax', label: S.comparer.ecartFileMax, align: 'right', value: (r) => Math.abs(r.fileMax), format: (r) => formatSigned(r.fileMax) },
  ]

  const exitColumns: DataTableColumn<ExitDeltaRow>[] = [
    { key: 'nom', label: S.resultats.col.sortie, value: (r) => r.nom },
    { key: 'vehicules', label: S.comparer.ecartVehicules, align: 'right', value: (r) => Math.abs(r.vehicules), format: (r) => formatSigned(r.vehicules) },
    { key: 'parcours', label: S.comparer.ecartParcours, align: 'right', value: (r) => Math.abs(r.parcours), format: (r) => formatSigned(r.parcours, 1) },
    { key: 'retard', label: S.comparer.ecartRetard, align: 'right', value: (r) => Math.abs(r.retard), format: (r) => formatSigned(r.retard, 1) },
  ]

  return (
    <div className="panel">
      <section className="block">
        <h2>{S.comparer.titre}</h2>
        <label className="field">
          <span className="field-label">{S.comparer.libelle}</span>
          <span className="field-input">
            <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
          </span>
        </label>
        <div className="row">
          <button
            type="button"
            className="button primary"
            data-testid="figer-reference"
            title={S.comparer.figerAide}
            onClick={() => { store.freezeReference(label.trim() || undefined); setLabel('') }}
          >
            {S.comparer.figer}
          </button>
          {reference ? (
            <button
              type="button"
              className="button danger"
              onClick={() => { if (confirm(S.comparer.confirmerEffacer)) store.clearReference() }}
            >
              {S.comparer.effacer}
            </button>
          ) : null}
        </div>
        <p className="hint">{S.comparer.figerAide}</p>
        {reference ? (
          <dl className="stats">
            <dt>{S.comparer.reference}</dt><dd>{reference.label}</dd>
            <dt>{S.comparer.figeeLe}</dt><dd>{formatDateTime(reference.frozenAt)}</dd>
            <dt>{S.trafic.graine}</dt><dd>{formatNumber(reference.demand.seed)}</dd>
          </dl>
        ) : (
          <p className="hint">{S.comparer.aucuneReference}</p>
        )}
        {reference ? <p className="hint">{sameSeed ? S.comparer.memeGraine : S.comparer.grainesDifferentes}</p> : null}
        {reference && !refResults ? <p className="hint error">{S.comparer.sansResultats}</p> : null}
        {reference && refResults && !variant ? <p className="hint error">{S.comparer.varianteSansResultats}</p> : null}
      </section>

      {reference && refResults && variant ? (
        <>
          <section className="block">
            <h3>{S.comparer.synthese}</h3>
            <div className="table-wrap">
              <table className="data-table comparaison">
                <thead>
                  <tr>
                    <th>{S.comparer.indicateur}</th>
                    <th className="right">{S.comparer.reference}</th>
                    <th className="right">{S.comparer.variante}</th>
                    <th className="right">{S.comparer.ecart}</th>
                  </tr>
                </thead>
                <tbody>
                  {SUMMARY_METRICS.map((metric) => {
                    const before = metric.value(refResults)
                    const after = metric.value(variant)
                    return (
                      <tr key={metric.key}>
                        <th scope="row">{metric.label}</th>
                        <td className="right">{metric.format(before)}</td>
                        <td className="right">{metric.format(after)}</td>
                        <td className={`right ${after > before ? 'hausse' : after < before ? 'baisse' : 'muted'}`}>
                          {metric.formatDelta(after - before)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="block">
            <h3>{S.resultats.couleurCarte}</h3>
            <div className="segmented" role="group" aria-label={S.resultats.couleurCarte}>
              {([['deltaDelay', S.comparer.carteRetard], ['deltaFlow', S.comparer.carteDebit]] as [ColorMode, string][]).map(([mode, texte]) => (
                <button
                  key={mode}
                  type="button"
                  className={colorMode === mode ? 'active' : ''}
                  data-testid={mode === 'deltaDelay' ? 'carte-delta-retard' : 'carte-delta-debit'}
                  onClick={() => store.setColorMode(mode)}
                >
                  {texte}
                </button>
              ))}
            </div>
          </section>

          <section className="block">
            <h3>{S.comparer.troncons}</h3>
            {!edgeRows.length ? <p className="hint">{S.comparer.aucunEcart}</p> : null}
            <DataTable
              columns={edgeColumns}
              rows={edgeRows}
              rowKey={(r) => r.id}
              maxRows={MAX_ROWS}
              initialSort={{ key: 'retard', dir: 'desc' }}
              selectedKey={selection?.kind === 'edge' ? selection.id : undefined}
              onRowClick={(r) => store.select({ kind: 'edge', id: r.id }, { reveal: true })}
            />
          </section>

          <section className="block">
            <h3>{S.comparer.sorties}</h3>
            {!exitRows.length ? <p className="hint">{S.comparer.aucunEcart}</p> : null}
            <DataTable
              columns={exitColumns}
              rows={exitRows}
              rowKey={(r) => r.id}
              maxRows={MAX_ROWS}
              initialSort={{ key: 'vehicules', dir: 'desc' }}
              selectedKey={selection?.kind === 'node' ? selection.id : undefined}
              onRowClick={(r) => store.select({ kind: 'node', id: r.id }, { reveal: true })}
            />
          </section>
        </>
      ) : null}

      {reference ? (
        <section className="block">
          <h3>{S.comparer.modifications}</h3>
          {changes.length ? (
            <ul className="list">
              {changes.map((change, i) => (
                <li key={`${change.at}-${i}`} className="list-item">
                  <span className="list-main">{change.label}</span>
                  <span className="list-side">{formatDateTime(change.at)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">{S.comparer.aucuneModification}</p>
          )}
        </section>
      ) : null}
    </div>
  )
}
