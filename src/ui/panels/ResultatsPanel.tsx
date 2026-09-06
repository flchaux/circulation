/**
 * Panneau « Résultats » : synthèse du réseau en tuiles, tableaux triables (tronçons, sorties, carrefours),
 * courbe temporelle de l'élément sélectionné et choix du mode de couleur de la carte.
 *
 * Un clic sur une ligne sélectionne l'élément et recentre la carte (`select(…, { reveal: true })`).
 * Les tableaux s'exportent en CSV à partir des mêmes définitions de colonnes que l'affichage : ce qui est
 * lisible à l'écran est exactement ce qui est exporté.
 */
import { useMemo, useState } from 'react'
import type { JSX } from 'react'
import { useAppStore } from '@/state/store'
import type { EdgeId, Network, NodeId, Project, SimResults } from '@/model/types'
import { effectiveControl } from '@/model/defaults'
import { buildAdjacency } from '@/model/geometry'
import type { ColorMode, Selection } from '@/state/storeTypes'
import { DataTable } from '@/ui/components/DataTable'
import type { DataTableColumn } from '@/ui/components/DataTable'
import { LineChart } from '@/ui/components/LineChart'
import type { LineChartSeries } from '@/ui/components/LineChart'
import {
  COLOR_MODE_LABELS, CONTROL_LABELS, HIGHWAY_LABELS, S, SERIES_COLORS,
  csvCell, downloadText, exportFileName, formatClock, formatDuration, formatNumber, formatPercent,
} from '@/ui/strings'

/** Bornage du rendu : au-delà, seules les premières lignes du tri courant sont montées dans le DOM. */
const MAX_ROWS = 300

const COLOR_MODES: ColorMode[] = ['class', 'flow', 'delay', 'saturation', 'speed', 'queue', 'deltaDelay', 'deltaFlow']
const DELTA_MODES: ColorMode[] = ['deltaDelay', 'deltaFlow']

/* ------------------------------------------------------------------ */
/*  Lignes des tableaux                                                */
/* ------------------------------------------------------------------ */

interface EdgeRow {
  id: EdgeId
  nom: string
  classe: string
  debit: number
  vitesse: number
  retard: number
  /** Retard cumulé sur le tronçon, en véhicules-secondes. */
  retardTotal: number
  saturation: number
  fileMax: number
  fileMoy: number
  entres: number
  sortis: number
}

interface ExitRow {
  id: NodeId
  nom: string
  vehicules: number
  debit: number
  parcours: number
  retard: number
}

interface NodeRow {
  id: NodeId
  nom: string
  regulation: string
  approches: number
  vehicules: number
  retard: number
  retardMax: number
  fileMax: number
}

function edgeName(network: Network, id: EdgeId): string {
  return network.edges[id]?.name ?? `${S.reseau.troncon} ${id}`
}

function nodeName(project: Project, id: NodeId, kind: 'exit' | 'node'): string {
  const config = kind === 'exit' ? project.demand.exits[id] : undefined
  return config?.label ?? project.network.nodes[id]?.label ?? id
}

function buildEdgeRows(results: SimResults, network: Network): EdgeRow[] {
  const rows: EdgeRow[] = []
  for (const [id, stats] of Object.entries(results.edges)) {
    const edge = network.edges[id]
    if (!edge) continue
    rows.push({
      id,
      nom: edge.name ?? id,
      classe: HIGHWAY_LABELS[edge.highway],
      debit: stats.flowVehH,
      vitesse: stats.meanSpeedKmh,
      retard: stats.meanDelayS,
      retardTotal: stats.totalDelayS,
      saturation: stats.saturation,
      fileMax: stats.maxQueue,
      fileMoy: stats.meanQueue,
      entres: stats.entered,
      sortis: stats.exited,
    })
  }
  return rows
}

function buildExitRows(results: SimResults, project: Project): ExitRow[] {
  const rows: ExitRow[] = []
  for (const [id, stats] of Object.entries(results.exits)) {
    rows.push({
      id,
      nom: nodeName(project, id, 'exit'),
      vehicules: stats.count,
      debit: stats.flowVehH,
      parcours: stats.meanTravelTimeS,
      retard: stats.meanDelayS,
    })
  }
  return rows
}

function buildNodeRows(results: SimResults, project: Project): NodeRow[] {
  const network = project.network
  const adjacency = buildAdjacency(network)
  const rows: NodeRow[] = []
  for (const [id, intersection] of Object.entries(results.intersections)) {
    if (!network.nodes[id]) continue
    const approaches = Object.values(intersection.approaches)
    if (!approaches.length) continue
    let vehicules = 0
    let retardCumule = 0
    let retardMax = 0
    let fileMax = 0
    for (const a of approaches) {
      vehicules += a.vehicles
      retardCumule += a.meanDelayS * a.vehicles
      if (a.meanDelayS > retardMax) retardMax = a.meanDelayS
      if (a.maxQueue > fileMax) fileMax = a.maxQueue
    }
    const control = effectiveControl(network, id, adjacency.incoming.get(id))
    rows.push({
      id,
      nom: nodeName(project, id, 'node'),
      regulation: CONTROL_LABELS[control.type],
      approches: approaches.length,
      vehicules,
      // Retard moyen du carrefour : moyenne des approches pondérée par leur trafic.
      retard: vehicules > 0 ? retardCumule / vehicules : 0,
      retardMax,
      fileMax,
    })
  }
  return rows
}

/* ------------------------------------------------------------------ */
/*  Export CSV                                                         */
/*  Les colonnes servent à la fois à l'affichage et au fichier.        */
/* ------------------------------------------------------------------ */

function exportTable<T>(fileName: string, columns: DataTableColumn<T>[], rows: T[]): void {
  const lines = [columns.map((c) => csvCell(c.label)).join(';')]
  for (const row of rows) lines.push(columns.map((c) => csvCell(c.value(row))).join(';'))
  downloadText(fileName, 'text/csv', `${lines.join('\n')}\n`)
}

/* ------------------------------------------------------------------ */
/*  Panneau                                                            */
/* ------------------------------------------------------------------ */

export function ResultatsPanel(): JSX.Element {
  const project = useAppStore((s) => s.project)
  const liveResults = useAppStore((s) => s.sim.results)
  const status = useAppStore((s) => s.sim.status)
  const selection = useAppStore((s) => s.selection)
  const colorMode = useAppStore((s) => s.ui.colorMode)
  const hasReference = useAppStore((s) => !!s.project?.reference?.results)

  // Résultats affichés : ceux de la simulation en cours, sinon les derniers résultats enregistrés dans le projet.
  const results = liveResults ?? project?.lastResults ?? null

  const edgeRows = useMemo(
    () => (results && project ? buildEdgeRows(results, project.network) : []),
    [results, project],
  )
  const exitRows = useMemo(() => (results && project ? buildExitRows(results, project) : []), [results, project])
  const nodeRows = useMemo(() => (results && project ? buildNodeRows(results, project) : []), [results, project])

  if (!project) return <div className="panel"><p className="hint">{S.app.aucunProjet}</p></div>

  const store = useAppStore.getState()
  const name = project.meta.name

  const edgeColumns: DataTableColumn<EdgeRow>[] = [
    { key: 'nom', label: S.resultats.col.troncon, value: (r) => r.nom },
    { key: 'classe', label: S.resultats.col.classe, value: (r) => r.classe },
    { key: 'debit', label: S.resultats.col.debit, align: 'right', value: (r) => r.debit, format: (r) => formatNumber(r.debit) },
    { key: 'vitesse', label: S.resultats.col.vitesse, align: 'right', value: (r) => r.vitesse, format: (r) => formatNumber(r.vitesse) },
    { key: 'retard', label: S.resultats.col.retard, align: 'right', value: (r) => r.retard, format: (r) => formatNumber(r.retard, 1) },
    { key: 'retardTotal', label: S.resultats.col.retardTotalTroncon, align: 'right', value: (r) => r.retardTotal, format: (r) => formatDuration(r.retardTotal) },
    { key: 'saturation', label: S.resultats.col.saturation, align: 'right', value: (r) => r.saturation, format: (r) => formatPercent(r.saturation) },
    { key: 'fileMax', label: S.resultats.col.fileMax, align: 'right', value: (r) => r.fileMax, format: (r) => formatNumber(r.fileMax) },
    { key: 'fileMoy', label: S.resultats.col.fileMoy, align: 'right', value: (r) => r.fileMoy, format: (r) => formatNumber(r.fileMoy, 1) },
    { key: 'entres', label: S.resultats.col.entres, align: 'right', value: (r) => r.entres, format: (r) => formatNumber(r.entres) },
    { key: 'sortis', label: S.resultats.col.sortis, align: 'right', value: (r) => r.sortis, format: (r) => formatNumber(r.sortis) },
  ]

  const exitColumns: DataTableColumn<ExitRow>[] = [
    { key: 'nom', label: S.resultats.col.sortie, value: (r) => r.nom },
    { key: 'vehicules', label: S.resultats.col.vehicules, align: 'right', value: (r) => r.vehicules, format: (r) => formatNumber(r.vehicules) },
    { key: 'debit', label: S.resultats.col.debit, align: 'right', value: (r) => r.debit, format: (r) => formatNumber(r.debit) },
    { key: 'parcours', label: S.resultats.col.tempsParcours, align: 'right', value: (r) => r.parcours, format: (r) => formatNumber(r.parcours) },
    { key: 'retard', label: S.resultats.col.retard, align: 'right', value: (r) => r.retard, format: (r) => formatNumber(r.retard, 1) },
  ]

  const nodeColumns: DataTableColumn<NodeRow>[] = [
    { key: 'nom', label: S.resultats.col.carrefour, value: (r) => r.nom },
    { key: 'regulation', label: S.resultats.col.regulation, value: (r) => r.regulation },
    { key: 'approches', label: S.resultats.col.approches, align: 'right', value: (r) => r.approches, format: (r) => formatNumber(r.approches) },
    { key: 'vehicules', label: S.resultats.col.vehicules, align: 'right', value: (r) => r.vehicules, format: (r) => formatNumber(r.vehicules) },
    { key: 'retard', label: S.resultats.col.retard, align: 'right', value: (r) => r.retard, format: (r) => formatNumber(r.retard, 1) },
    { key: 'retardMax', label: S.resultats.col.retardMax, align: 'right', value: (r) => r.retardMax, format: (r) => formatNumber(r.retardMax, 1) },
    { key: 'fileMax', label: S.resultats.col.fileMaxCarrefour, align: 'right', value: (r) => r.fileMax, format: (r) => formatNumber(r.fileMax) },
  ]

  return (
    <div className="panel">
      <section className="block">
        <h2>
          {S.resultats.titre}
          {results && !results.completed ? <span className="badge">{S.resultats.partiels}</span> : null}
        </h2>
        {!results ? <p className="hint">{S.resultats.aucun}</p> : null}
        {results && status === 'running' ? <p className="hint">{S.resultats.enCours}</p> : null}
        {results ? (
          <>
            <h3>{S.resultats.synthese}</h3>
            <ul className="tiles">
              <Tile label={S.resultats.entres} value={formatNumber(results.network.entered)} unit={S.unites.veh} />
              <Tile label={S.resultats.sortis} value={formatNumber(results.network.exited)} unit={S.unites.veh} />
              <Tile label={S.resultats.enCirculation} value={formatNumber(results.network.inCirculation)} unit={S.unites.veh} />
              <Tile label={S.resultats.nonInjectes} value={formatNumber(results.network.notInjected)} unit={S.unites.veh} />
              <Tile label={S.resultats.retardMoyen} value={formatNumber(results.network.meanDelayS, 1)} unit={S.unites.s} />
              <Tile label={S.resultats.retardTotal} value={formatDuration(results.network.totalDelayS)} />
              <Tile label={S.resultats.tempsParcours} value={formatNumber(results.network.meanTravelTimeS, 1)} unit={S.unites.s} />
              <Tile label={S.resultats.vehKm} value={formatNumber(results.network.vehKm, 1)} unit={S.unites.vehKm} />
            </ul>
            <p className="hint">{S.sim.horloge} : {formatClock(results.reachedS)}</p>
          </>
        ) : null}
      </section>

      <section className="block">
        <h3>{S.resultats.couleurCarte}</h3>
        <label className="field">
          <span className="field-label">{S.carte.couleur}</span>
          <select
            value={colorMode}
            data-testid="mode-couleur"
            onChange={(e) => store.setColorMode(e.target.value as ColorMode)}
          >
            {COLOR_MODES.map((mode) => (
              <option key={mode} value={mode} disabled={DELTA_MODES.includes(mode) && !hasReference}>
                {COLOR_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>
        {!results && colorMode !== 'class' ? <p className="hint">{S.carte.aucuneDonnee}</p> : null}
      </section>

      {results ? (
        <>
          <SeriesBlock results={results} project={project} selection={selection} />

          <section className="block">
            <h3>{S.resultats.troncons}</h3>
            <DataTable
              columns={edgeColumns}
              rows={edgeRows}
              rowKey={(r) => r.id}
              maxRows={MAX_ROWS}
              initialSort={{ key: 'retard', dir: 'desc' }}
              selectedKey={selection?.kind === 'edge' ? selection.id : undefined}
              onRowClick={(r) => store.select({ kind: 'edge', id: r.id }, { reveal: true })}
            />
            <button
              type="button"
              className="button"
              onClick={() => exportTable(exportFileName(`${name}-troncons`, 'csv'), edgeColumns, edgeRows)}
            >
              {S.resultats.exporterCsv}
            </button>
          </section>

          <section className="block">
            <h3>{S.resultats.sorties}</h3>
            <DataTable
              columns={exitColumns}
              rows={exitRows}
              rowKey={(r) => r.id}
              maxRows={MAX_ROWS}
              initialSort={{ key: 'vehicules', dir: 'desc' }}
              selectedKey={selection?.kind === 'node' ? selection.id : undefined}
              onRowClick={(r) => store.select({ kind: 'node', id: r.id }, { reveal: true })}
            />
            <button
              type="button"
              className="button"
              onClick={() => exportTable(exportFileName(`${name}-sorties`, 'csv'), exitColumns, exitRows)}
            >
              {S.resultats.exporterCsv}
            </button>
          </section>

          <section className="block">
            <h3>{S.resultats.carrefours}</h3>
            <DataTable
              columns={nodeColumns}
              rows={nodeRows}
              rowKey={(r) => r.id}
              maxRows={MAX_ROWS}
              initialSort={{ key: 'retard', dir: 'desc' }}
              selectedKey={selection?.kind === 'node' ? selection.id : undefined}
              onRowClick={(r) => store.select({ kind: 'node', id: r.id }, { reveal: true })}
            />
            <button
              type="button"
              className="button"
              onClick={() => exportTable(exportFileName(`${name}-carrefours`, 'csv'), nodeColumns, nodeRows)}
            >
              {S.resultats.exporterCsv}
            </button>
          </section>

          {results.warnings.length ? (
            <section className="block">
              <h3>{S.resultats.avertissements}</h3>
              <ul className="warnings">{results.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

function Tile({ label, value, unit }: { label: string; value: string; unit?: string }): JSX.Element {
  return (
    <li className="tile">
      <span className="tile-value">
        {value}
        {unit ? <span className="tile-unit">{unit}</span> : null}
      </span>
      <span className="tile-label">{label}</span>
    </li>
  )
}

/* ------------------------------------------------------------------ */
/*  Courbe temporelle de l'élément sélectionné                         */
/* ------------------------------------------------------------------ */

type SerieMetric = 'flow' | 'delay' | 'queue'

const METRIC_LABELS: Record<SerieMetric, string> = {
  flow: S.resultats.serieDebit,
  delay: S.resultats.serieRetard,
  queue: S.resultats.serieFile,
}

function SeriesBlock(props: { results: SimResults; project: Project; selection: Selection }): JSX.Element {
  const { results, project, selection } = props
  const [metric, setMetric] = useState<SerieMetric>('flow')
  const series = results.series

  const edgeSerie = selection?.kind === 'edge' ? series.edges[selection.id] : undefined
  const exitSerie = selection?.kind === 'node' ? series.exits[selection.id] : undefined

  let cible: string
  let unit: string
  let lines: LineChartSeries[]
  if (edgeSerie && selection?.kind === 'edge') {
    cible = edgeName(project.network, selection.id)
    if (metric === 'delay') {
      unit = S.unites.s
      lines = [{ label: S.resultats.col.retard, color: SERIES_COLORS.secondaire, values: edgeSerie.delay }]
    } else if (metric === 'queue') {
      unit = S.unites.veh
      lines = [{ label: S.resultats.col.fileMoy, color: SERIES_COLORS.tertiaire, values: edgeSerie.queue }]
    } else {
      unit = S.unites.vehH
      lines = [{ label: S.resultats.col.debit, color: SERIES_COLORS.principal, values: edgeSerie.flow }]
    }
  } else if (exitSerie && selection?.kind === 'node') {
    cible = nodeName(project, selection.id, 'exit')
    unit = S.unites.veh
    lines = [{ label: S.resultats.col.vehicules, color: SERIES_COLORS.principal, values: exitSerie.count }]
  } else {
    cible = S.resultats.reseauEntier
    if (metric === 'delay') {
      unit = S.unites.s
      lines = [{ label: S.resultats.retardMoyen, color: SERIES_COLORS.secondaire, values: series.network.meanDelay }]
    } else if (metric === 'queue') {
      unit = S.unites.veh
      lines = [{ label: S.resultats.enCirculation, color: SERIES_COLORS.tertiaire, values: series.network.inCirculation }]
    } else {
      unit = S.unites.veh
      lines = [
        { label: S.resultats.entres, color: SERIES_COLORS.principal, values: series.network.entered },
        { label: S.resultats.sortis, color: SERIES_COLORS.secondaire, values: series.network.exited },
      ]
    }
  }

  // La sortie n'a qu'un indicateur (le nombre de véhicules) : le sélecteur n'a alors aucun sens.
  const showMetrics = !exitSerie || (selection?.kind === 'edge' && !!edgeSerie)

  return (
    <section className="block">
      <h3>{S.resultats.serie}</h3>
      <p className="hint">{S.resultats.serieCible} : {cible}</p>
      {showMetrics ? (
        <div className="segmented" role="group" aria-label={S.resultats.serie}>
          {(['flow', 'delay', 'queue'] as SerieMetric[]).map((m) => (
            <button key={m} type="button" className={metric === m ? 'active' : ''} onClick={() => setMetric(m)}>
              {METRIC_LABELS[m]}
            </button>
          ))}
        </div>
      ) : null}
      {series.times.length ? (
        <LineChart series={lines} times={series.times} unit={unit} height={150} />
      ) : (
        <p className="hint">{S.resultats.serieAucune}</p>
      )}
    </section>
  )
}
