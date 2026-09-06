/**
 * Panneau « Trafic » : intensité globale, graine, débits d'entrée, poids de sortie, matrice
 * origine-destination, trafic interne, import/export CSV et réglages de simulation.
 */
import { useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { useAppStore } from '@/state/store'
import type { Demand, Network, NodeId } from '@/model/types'
import type { CsvImportReport } from '@/state/storeTypes'
import { NumberField } from '@/ui/components/NumberField'
import { S, downloadText, exportFileName, formatNumber, formatPercent } from '@/ui/strings'

/** Au-delà, la matrice origine-destination n'est plus affichable ligne à ligne. */
const MAX_OD_CELLS = 2500

function label(demand: Demand, network: Network, id: NodeId, kind: 'entry' | 'exit'): string {
  const config = kind === 'entry' ? demand.entries[id] : demand.exits[id]
  return config?.label ?? network.nodes[id]?.label ?? id
}

/** Saisie numérique compacte pour les cellules de tableau : validée à la sortie du champ. */
function CellNumber(props: { value: number; min?: number; onCommit(v: number): void; ariaLabel: string }): JSX.Element {
  const { value, min = 0, onCommit, ariaLabel } = props
  const [text, setText] = useState<string | null>(null)
  const shown = text ?? String(Math.round(value * 100) / 100).replace('.', ',')
  return (
    <input
      className="cell-number"
      type="text"
      inputMode="decimal"
      aria-label={ariaLabel}
      value={shown}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
      onBlur={() => {
        const parsed = Number((text ?? '').trim().replace(',', '.'))
        setText(null)
        if (text !== null && text.trim() !== '' && Number.isFinite(parsed)) onCommit(Math.max(min, parsed))
      }}
    />
  )
}

export function TraficPanel(): JSX.Element {
  const project = useAppStore((s) => s.project)
  const [report, setReport] = useState<CsvImportReport | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const entryIds = useMemo(
    () => (project ? Object.keys(project.demand.entries).sort((a, b) => label(project.demand, project.network, a, 'entry').localeCompare(label(project.demand, project.network, b, 'entry'), 'fr')) : []),
    [project],
  )
  const exitIds = useMemo(
    () => (project ? Object.keys(project.demand.exits).sort((a, b) => label(project.demand, project.network, a, 'exit').localeCompare(label(project.demand, project.network, b, 'exit'), 'fr')) : []),
    [project],
  )

  if (!project) return <div className="panel"><p className="hint">{S.app.aucunProjet}</p></div>

  const { demand, settings, network } = project
  const store = useAppStore.getState()
  const totalFlow = entryIds.reduce((sum, id) => sum + (demand.entries[id].enabled ? demand.entries[id].flow : 0), 0)
  const odCells = entryIds.length * exitIds.length

  return (
    <div className="panel">
      <section className="block">
        <h2>{S.trafic.titre}</h2>
        <label className="field">
          <span className="field-label">{S.trafic.intensite} · {formatPercent(demand.globalFactor)}</span>
          <input
            type="range"
            min={0}
            max={3}
            step={0.05}
            value={demand.globalFactor}
            onChange={(e) => store.setGlobalFactor(Number(e.target.value))}
            data-testid="intensite-globale"
          />
        </label>
        <p className="hint">{S.trafic.intensiteAide}</p>
        <div className="row">
          <NumberField label={S.trafic.graine} value={demand.seed} min={0} onChange={(v) => store.setSeed(v)} />
          <button type="button" className="button" onClick={() => store.setSeed(Math.floor(Math.random() * 1e9))}>{S.trafic.nouvelleGraine}</button>
        </div>
        <p className="hint">{S.trafic.graineAide}</p>
      </section>

      <section className="block">
        <h3>{S.trafic.entrees} · {formatNumber(totalFlow)} {S.unites.vehH}</h3>
        {entryIds.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{S.trafic.entree}</th>
                  <th className="right">{S.trafic.debit}</th>
                  <th className="right">{S.trafic.activee}</th>
                </tr>
              </thead>
              <tbody>
                {entryIds.map((id) => {
                  const entry = demand.entries[id]
                  const name = label(demand, network, id, 'entry')
                  return (
                    <tr key={id}>
                      <th scope="row">
                        <button type="button" className="link" onClick={() => store.select({ kind: 'node', id }, { reveal: true })}>{name}</button>
                        {entry.estimated ? <span className="badge" title={S.reseau.estimeeAide}>{S.reseau.estimee}</span> : null}
                      </th>
                      <td className="right">
                        <CellNumber value={entry.flow} ariaLabel={`${S.trafic.debit} — ${name}`} onCommit={(v) => store.updateEntry(id, { flow: v })} />
                      </td>
                      <td className="right">
                        <input
                          type="checkbox"
                          checked={entry.enabled}
                          aria-label={`${S.trafic.activee} — ${name}`}
                          onChange={(e) => store.updateEntry(id, { enabled: e.target.checked })}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="hint">{S.trafic.aucuneEntree}</p>
        )}
      </section>

      <section className="block">
        <h3>{S.trafic.sorties}</h3>
        <label className="field">
          <span className="field-label">{S.trafic.destination}</span>
          <select value={demand.destinationMode} onChange={(e) => store.setDestinationMode(e.target.value as Demand['destinationMode'])}>
            <option value="weights">{S.trafic.modeWeights}</option>
            <option value="od">{S.trafic.modeOd}</option>
          </select>
        </label>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{S.trafic.sortie}</th>
                <th className="right">{S.trafic.poids}</th>
                <th className="right">{S.trafic.activee}</th>
              </tr>
            </thead>
            <tbody>
              {exitIds.map((id) => {
                const exit = demand.exits[id]
                const name = label(demand, network, id, 'exit')
                return (
                  <tr key={id}>
                    <th scope="row">
                      <button type="button" className="link" onClick={() => store.select({ kind: 'node', id }, { reveal: true })}>{name}</button>
                    </th>
                    <td className="right">
                      <CellNumber value={exit.weight} ariaLabel={`${S.trafic.poids} — ${name}`} onCommit={(v) => store.updateExit(id, { weight: v })} />
                    </td>
                    <td className="right">
                      <input
                        type="checkbox"
                        checked={exit.enabled}
                        aria-label={`${S.trafic.activee} — ${name}`}
                        onChange={(e) => store.updateExit(id, { enabled: e.target.checked })}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {demand.destinationMode === 'od' ? (
        <section className="block">
          <h3>{S.trafic.matrice}</h3>
          <p className="hint">{S.trafic.matriceAide}</p>
          {odCells > MAX_OD_CELLS ? (
            <p className="hint">{S.trafic.matriceTropGrande.replace('{n}', formatNumber(odCells))}</p>
          ) : (
            <div className="table-wrap scroll">
              <table className="data-table matrix">
                <thead>
                  <tr>
                    <th>{S.trafic.entree}</th>
                    {exitIds.map((id) => <th key={id} className="right">{label(demand, network, id, 'exit')}</th>)}
                    <th className="right">{S.trafic.total}</th>
                  </tr>
                </thead>
                <tbody>
                  {entryIds.map((entryId) => {
                    const row = demand.od[entryId] ?? {}
                    const sum = Object.values(row).reduce((a, b) => a + b, 0)
                    return (
                      <tr key={entryId}>
                        <th scope="row">{label(demand, network, entryId, 'entry')}</th>
                        {exitIds.map((exitId) => (
                          <td key={exitId} className="right">
                            <CellNumber
                              value={(row[exitId] ?? 0) * 100}
                              ariaLabel={`${label(demand, network, entryId, 'entry')} → ${label(demand, network, exitId, 'exit')}`}
                              onCommit={(v) => store.setOdShare(entryId, exitId, v / 100)}
                            />
                          </td>
                        ))}
                        <td className="right muted">{formatPercent(sum)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <button type="button" className="button" onClick={() => store.clearOd()}>{S.trafic.effacerMatrice}</button>
        </section>
      ) : null}

      <section className="block">
        <h3>{S.trafic.interne}</h3>
        <label className="check">
          <input type="checkbox" checked={demand.internal.enabled} onChange={(e) => store.updateInternal({ enabled: e.target.checked })} />
          {S.trafic.interneActive}
        </label>
        {demand.internal.enabled ? (
          <div className="row">
            <NumberField label={S.trafic.interneDebit} value={demand.internal.generationRate} min={0} unit={S.unites.vehH} onChange={(v) => store.updateInternal({ generationRate: v })} />
            <NumberField
              label={S.trafic.interneVersInterne}
              value={Math.round(demand.internal.internalDestinationShare * 100)}
              min={0}
              max={100}
              unit={S.unites.pourcent}
              onChange={(v) => store.updateInternal({ internalDestinationShare: v / 100 })}
            />
            <NumberField
              label={S.trafic.entreeVersInterne}
              value={Math.round(demand.internal.entryInternalShare * 100)}
              min={0}
              max={100}
              unit={S.unites.pourcent}
              onChange={(v) => store.updateInternal({ entryInternalShare: v / 100 })}
            />
          </div>
        ) : null}
      </section>

      <section className="block">
        <h3>{S.trafic.csv}</h3>
        <p className="hint">{S.trafic.csvAide}</p>
        <div className="row">
          <button type="button" className="button" onClick={() => fileRef.current?.click()}>{S.trafic.csvImporter}</button>
          <button
            type="button"
            className="button"
            onClick={() => downloadText(exportFileName(`${project.meta.name}-demande`, 'csv'), 'text/csv', store.exportDemandCsv())}
          >
            {S.trafic.csvExporter}
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (!file) return
            void file.text().then((text) => setReport(store.importDemandCsv(text, file.name)))
          }}
        />
        {demand.csvImport ? (
          <p className="hint">
            {S.trafic.csvDernier} : {demand.csvImport.fileName} ({formatNumber(demand.csvImport.rows)})
          </p>
        ) : null}
        {report ? (
          <div className="report">
            <strong>{S.trafic.csvBilan}</strong>
            <ul>
              <li>{formatNumber(report.entries)} {S.trafic.csvEntrees}</li>
              <li>{formatNumber(report.exits)} {S.trafic.csvSorties}</li>
              <li>{formatNumber(report.odCells)} {S.trafic.csvCellules}</li>
              {report.unknown.length ? <li>{S.trafic.csvInconnus} : {report.unknown.slice(0, 8).join(', ')}{report.unknown.length > 8 ? '…' : ''}</li> : null}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="block">
        <h3>{S.trafic.reglages}</h3>
        <div className="row">
          <NumberField label={S.trafic.duree} value={settings.durationMin} min={1} max={480} unit={S.unites.min} onChange={(v) => store.updateSettings({ durationMin: Math.round(v) })} />
          <NumberField label={S.trafic.chauffe} value={settings.warmupMin} min={0} max={120} unit={S.unites.min} onChange={(v) => store.updateSettings({ warmupMin: Math.round(v) })} />
          <NumberField label={S.trafic.intervalleStats} value={settings.statsIntervalMin} min={1} max={60} unit={S.unites.min} onChange={(v) => store.updateSettings({ statsIntervalMin: Math.round(v) })} />
        </div>
        <p className="hint">{S.trafic.chauffeAide}</p>
        <label className="check">
          <input type="checkbox" checked={settings.dynamicRouting} onChange={(e) => store.updateSettings({ dynamicRouting: e.target.checked })} />
          {S.trafic.routageDynamique}
        </label>
        {settings.dynamicRouting ? (
          <NumberField label={S.trafic.routageIntervalle} value={settings.routingIntervalMin} min={1} max={60} unit={S.unites.min} onChange={(v) => store.updateSettings({ routingIntervalMin: Math.round(v) })} />
        ) : null}

        <details className="advanced">
          <summary>{S.trafic.avances}</summary>
          <div className="row">
            <NumberField label={S.trafic.debitSaturation} value={settings.saturationFlow} min={600} max={2400} step={50} unit={S.unites.vehH} onChange={(v) => store.updateSettings({ saturationFlow: v })} />
            <NumberField label={S.trafic.longueurVehicule} value={settings.vehicleLength} min={4} max={12} step={0.5} unit={S.unites.m} onChange={(v) => store.updateSettings({ vehicleLength: v })} />
          </div>
          <div className="row">
            <NumberField label={S.trafic.tempsPerdu} value={settings.startupLostTime} min={0} max={5} step={0.5} unit={S.unites.s} onChange={(v) => store.updateSettings({ startupLostTime: v })} />
            <NumberField label={S.trafic.orangeUtile} value={settings.amberUsable} min={0} max={5} step={0.5} unit={S.unites.s} onChange={(v) => store.updateSettings({ amberUsable: v })} />
          </div>
          <fieldset className="fieldset">
            <legend>{S.trafic.creneaux}</legend>
            <div className="row">
              <NumberField label={S.trafic.creneauStop} value={settings.criticalGap.stop} min={2} max={12} step={0.5} unit={S.unites.s} onChange={(v) => store.updateSettings({ criticalGap: { ...settings.criticalGap, stop: v } })} />
              <NumberField label={S.trafic.creneauCedez} value={settings.criticalGap.giveWay} min={2} max={12} step={0.5} unit={S.unites.s} onChange={(v) => store.updateSettings({ criticalGap: { ...settings.criticalGap, giveWay: v } })} />
            </div>
            <div className="row">
              <NumberField label={S.trafic.creneauDroite} value={settings.criticalGap.priorityRight} min={2} max={12} step={0.5} unit={S.unites.s} onChange={(v) => store.updateSettings({ criticalGap: { ...settings.criticalGap, priorityRight: v } })} />
              <NumberField label={S.trafic.creneauGiratoire} value={settings.criticalGap.roundabout} min={2} max={12} step={0.5} unit={S.unites.s} onChange={(v) => store.updateSettings({ criticalGap: { ...settings.criticalGap, roundabout: v } })} />
            </div>
            <div className="row">
              <NumberField label={S.trafic.creneauTag} value={settings.criticalGap.permittedLeft} min={2} max={12} step={0.5} unit={S.unites.s} onChange={(v) => store.updateSettings({ criticalGap: { ...settings.criticalGap, permittedLeft: v } })} />
              <NumberField label={S.trafic.tempsSuite} value={settings.followUpTime} min={1} max={6} step={0.5} unit={S.unites.s} onChange={(v) => store.updateSettings({ followUpTime: v })} />
              <NumberField label={S.trafic.arretStop} value={settings.stopDelay} min={0} max={5} step={0.5} unit={S.unites.s} onChange={(v) => store.updateSettings({ stopDelay: v })} />
            </div>
          </fieldset>
        </details>
      </section>
    </div>
  )
}
