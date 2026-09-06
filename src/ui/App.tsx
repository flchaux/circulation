/**
 * Coquille de l'application : barre supérieure (projet, historique, import/export, contrôles de simulation),
 * barre latérale à onglets et carte.
 *
 * La barre supérieure est découpée en deux composants indépendants : `ProjetActions` ne se redessine qu'aux
 * modifications du projet, `SimControls` à chaque frame du moteur. L'onglet actif et la carte sont ainsi
 * épargnés par le rafraîchissement de l'horloge.
 */
import { useRef } from 'react'
import type { JSX } from 'react'
import { useAppStore } from '@/state/store'
import type { SidebarTab } from '@/state/storeTypes'
import { MapView } from '@/ui/map/MapView'
import { VillePanel } from '@/ui/panels/VillePanel'
import { ReseauPanel } from '@/ui/panels/ReseauPanel'
import { FeuxPanel } from '@/ui/panels/FeuxPanel'
import { TraficPanel } from '@/ui/panels/TraficPanel'
import { ResultatsPanel } from '@/ui/panels/ResultatsPanel'
import { ComparerPanel } from '@/ui/panels/ComparerPanel'
import {
  S, TAB_LABELS, downloadText, exportFileName, formatClock, formatNumber, formatSpeed,
} from '@/ui/strings'

const TABS: SidebarTab[] = ['ville', 'reseau', 'feux', 'trafic', 'resultats', 'comparer']

/** Cadences proposées (secondes simulées par seconde réelle). */
const SPEEDS = [1, 2, 5, 10, 20, 60, 120]

/** Durée avancée par un clic sur « pas à pas » (s). */
const STEP_SECONDS = 60

export function App(): JSX.Element {
  const tab = useAppStore((s) => s.ui.tab)
  const error = useAppStore((s) => s.error)
  const busy = useAppStore((s) => s.busy)

  return (
    <div className="app">
      <header className="topbar">
        <ProjetActions />
        <SimControls />
      </header>

      {error ? (
        <div className="banner error" role="alert">
          <strong>{S.app.erreur}</strong>
          <span className="banner-message">{error}</span>
          <button
            type="button"
            className="icon-button"
            title={S.app.fermer}
            aria-label={S.app.fermer}
            onClick={() => useAppStore.getState().clearError()}
          >
            ×
          </button>
        </div>
      ) : null}

      {busy.active ? (
        <div className="banner busy" role="status">
          <span className="spinner" aria-hidden="true" />
          <span className="banner-message">{busy.message || S.app.chargement}</span>
          {busy.cancellable ? (
            <button
              type="button"
              className="banner-action"
              data-testid="annuler-chargement"
              onClick={() => useAppStore.getState().cancelLoad()}
            >
              {S.app.annulerChargement}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="workspace">
        <aside className="sidebar">
          <nav className="tabs" role="tablist" aria-label={S.app.onglets}>
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                id={`onglet-${t}`}
                aria-selected={t === tab}
                aria-controls={`panneau-${t}`}
                className={t === tab ? 'active' : ''}
                data-testid={`onglet-${t}`}
                onClick={() => useAppStore.getState().setTab(t)}
              >
                {TAB_LABELS[t]}
              </button>
            ))}
          </nav>
          <div className="sidebar-body" role="tabpanel" id={`panneau-${tab}`} aria-labelledby={`onglet-${tab}`}>
            <ActivePanel tab={tab} />
          </div>
        </aside>
        <MapView />
      </div>
    </div>
  )
}

function ActivePanel({ tab }: { tab: SidebarTab }): JSX.Element {
  switch (tab) {
    case 'ville':
      return <VillePanel />
    case 'reseau':
      return <ReseauPanel />
    case 'feux':
      return <FeuxPanel />
    case 'trafic':
      return <TraficPanel />
    case 'resultats':
      return <ResultatsPanel />
    case 'comparer':
      return <ComparerPanel />
  }
}

/* ------------------------------------------------------------------ */
/*  Projet : nom, historique, bibliothèque, import / export            */
/* ------------------------------------------------------------------ */

function ProjetActions(): JSX.Element {
  const name = useAppStore((s) => s.project?.meta.name ?? '')
  const hasProject = useAppStore((s) => s.project !== null)
  const canUndo = useAppStore((s) => s.canUndo)
  const canRedo = useAppStore((s) => s.canRedo)
  const dirty = useAppStore((s) => s.dirty)
  const fileRef = useRef<HTMLInputElement | null>(null)

  return (
    <div className="topbar-group projet">
      <span className="app-title">{S.app.titre}</span>
      <input
        type="text"
        className="project-name"
        value={name}
        aria-label={S.app.nomProjet}
        placeholder={S.app.projetSansNom}
        disabled={!hasProject}
        data-testid="nom-projet"
        onChange={(e) => useAppStore.getState().setProjectName(e.target.value)}
      />
      <button
        type="button"
        className="icon-button"
        title={S.app.annuler}
        aria-label={S.app.annuler}
        disabled={!canUndo}
        data-testid="annuler"
        onClick={() => useAppStore.getState().undo()}
      >
        ↶
      </button>
      <button
        type="button"
        className="icon-button"
        title={S.app.retablir}
        aria-label={S.app.retablir}
        disabled={!canRedo}
        data-testid="retablir"
        onClick={() => useAppStore.getState().redo()}
      >
        ↷
      </button>
      <button
        type="button"
        className="button"
        disabled={!hasProject}
        title={dirty ? S.app.modifications : S.app.enregistre}
        onClick={() => void useAppStore.getState().saveToLibrary()}
      >
        {S.app.enregistrer}
        {dirty ? <span className="dot" aria-hidden="true" /> : null}
      </button>
      <button type="button" className="button" onClick={() => fileRef.current?.click()}>
        {S.app.importer}
      </button>
      <button
        type="button"
        className="button"
        disabled={!hasProject}
        data-testid="exporter-json"
        onClick={() => {
          const store = useAppStore.getState()
          const json = store.exportProjectJson()
          if (!json) return
          downloadText(exportFileName(store.project?.meta.name ?? S.app.projetSansNom, 'json'), 'application/json', json)
        }}
      >
        {S.app.exporter}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        hidden
        data-testid="importer-json"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (!file) return
          void file.text().then(
            (text) => useAppStore.getState().importProjectJson(text),
            (cause: unknown) => useAppStore.getState().setError(String(cause)),
          )
        }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Contrôles de simulation (redessinés à chaque frame)                */
/* ------------------------------------------------------------------ */

function SimControls(): JSX.Element {
  const hasProject = useAppStore((s) => s.project !== null)
  const status = useAppStore((s) => s.sim.status)
  const speed = useAppStore((s) => s.sim.speed)
  const fast = useAppStore((s) => s.sim.fast)
  const stale = useAppStore((s) => s.sim.stale)
  const stepsPerSecond = useAppStore((s) => s.sim.stepsPerSecond)
  // L'horloge lit `sim.frame.time` (repli sur `sim.time`, qui n'est mis à jour qu'aux changements de statut).
  const time = useAppStore((s) => s.sim.frame?.time ?? s.sim.time)
  const endTime = useAppStore((s) => s.sim.endTime)
  const counts = useAppStore((s) => s.sim.frame?.counts ?? null)
  const network = useAppStore((s) => s.sim.results?.network ?? null)
  const warmupMin = useAppStore((s) => s.project?.settings.warmupMin ?? 0)
  const durationMin = useAppStore((s) => s.project?.settings.durationMin ?? 0)

  const running = status === 'running'
  const total = endTime > 0 ? endTime : (warmupMin + durationMin) * 60
  const warmupS = warmupMin * 60
  const ratio = total > 0 ? Math.min(1, Math.max(0, time / total)) : 0
  const percent = (value: number): string => `${(total > 0 ? Math.min(1, value / total) : 0) * 100}%`

  const enCirculation = counts?.inCirculation ?? network?.inCirculation ?? 0
  const entres = counts?.entered ?? network?.entered ?? 0
  const sortis = counts?.exited ?? network?.exited ?? 0
  const attente = counts?.waitingAtEntries ?? 0

  return (
    <div className="topbar-group simulation">
      <button
        type="button"
        className="button primary"
        disabled={!hasProject}
        data-testid="sim-lecture"
        onClick={() => (running ? useAppStore.getState().simPause() : useAppStore.getState().simStart())}
      >
        {running ? S.sim.pause : S.sim.demarrer}
      </button>
      <button
        type="button"
        className="icon-button"
        title={S.sim.reinitialiser}
        aria-label={S.sim.reinitialiser}
        disabled={!hasProject}
        data-testid="sim-reinitialiser"
        onClick={() => useAppStore.getState().simReset()}
      >
        ⟲
      </button>
      <button
        type="button"
        className="button"
        title={S.sim.pasAPasAide}
        disabled={!hasProject || running}
        data-testid="sim-pas-a-pas"
        onClick={() => useAppStore.getState().simStep(STEP_SECONDS)}
      >
        {S.sim.pasAPas}
      </button>
      <label className="field inline">
        <span className="field-label">{S.sim.vitesse}</span>
        <select
          value={speed}
          aria-label={S.sim.vitesse}
          disabled={!hasProject}
          data-testid="sim-vitesse"
          onChange={(e) => useAppStore.getState().simSetSpeed(Number(e.target.value))}
        >
          {SPEEDS.map((v) => <option key={v} value={v}>{formatSpeed(v)}</option>)}
        </select>
      </label>
      <button
        type="button"
        className="button"
        disabled={!hasProject || fast}
        data-testid="sim-rapide"
        onClick={() => useAppStore.getState().simRunFast()}
      >
        {fast ? S.sim.rapideEnCours : S.sim.rapide}
      </button>

      <div className="clock" title={S.sim.horloge}>
        <span className="clock-time" data-testid="sim-horloge">{formatClock(time)}</span>
        <span className="clock-total">/ {formatClock(total)}</span>
        {time < warmupS ? <span className="badge">{S.sim.chauffe}</span> : null}
      </div>
      <div
        className="progress-bar"
        role="progressbar"
        aria-label={S.sim.progression}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
      >
        <span className="progress-warmup" style={{ width: percent(warmupS) }} title={S.sim.chauffe} />
        <span className="progress-fill" style={{ width: percent(time) }} />
      </div>

      <dl className="counters">
        <div><dt>{S.sim.enCirculation}</dt><dd>{formatNumber(enCirculation)}</dd></div>
        <div><dt>{S.sim.entres}</dt><dd>{formatNumber(entres)}</dd></div>
        <div><dt>{S.sim.sortis}</dt><dd>{formatNumber(sortis)}</dd></div>
        {attente > 0 ? <div><dt>{S.sim.attente}</dt><dd>{formatNumber(attente)}</dd></div> : null}
      </dl>

      <span className="status">
        <span className="badge">{S.sim.statut[status]}</span>
        {running ? <span className="muted">{formatNumber(stepsPerSecond)} {S.sim.pasParSeconde}</span> : null}
      </span>
      {stale && (counts || network) ? <span className="hint stale">{S.sim.perime}</span> : null}
    </div>
  )
}
