/**
 * Panneau « Feux » : liste des contrôleurs, éditeur de plan (mode, décalage, orange, rouge intégral),
 * cartes de phases avec le schéma du carrefour cliquable et diagramme temporel du cycle.
 *
 * Le schéma place chaque approche à son `approachAngle` et chaque sortie à son `exitAngle` (src/model/geometry.ts) ;
 * un mouvement est une courbe de Bézier de l'une vers l'autre, dont un clic fait tourner l'état
 * rouge → protégé → permis.
 */
import { useId, useMemo } from 'react'
import type { JSX } from 'react'
import { useAppStore } from '@/state/store'
import type { ControllerId, GreenKind, MovementKey, Network, SignalController, SignalPhase } from '@/model/types'
import type { Movement } from '@/model/geometry'
import {
  controllerCycle, controllerMovements, describeMovement, phaseAllRed, phaseAmber, phaseDuration, validateController,
} from '@/model/signals'
import { NumberField } from '@/ui/components/NumberField'
import { GREEN_KIND_LABELS, S, SIGNAL_MODE_LABELS, formatNumber } from '@/ui/strings'

const SIGNAL_MODES: SignalController['mode'][] = ['fixed', 'actuated', 'flashing', 'off']

export function FeuxPanel(): JSX.Element {
  const network = useAppStore((s) => s.project?.network)
  const selection = useAppStore((s) => s.selection)

  const controllers = useMemo(
    () => (network ? Object.values(network.controllers).sort((a, b) => a.name.localeCompare(b.name, 'fr')) : []),
    [network],
  )

  if (!network) return <div className="panel"><p className="hint">{S.app.aucunProjet}</p></div>

  const activeId = selection?.kind === 'controller'
    ? selection.id
    : selection?.kind === 'node' ? network.controls[selection.id]?.controllerId : undefined
  const active = activeId ? network.controllers[activeId] : undefined

  return (
    <div className="panel">
      <section className="block">
        <h2>{S.feux.titre}</h2>
        {controllers.length ? (
          <ul className="list">
            {controllers.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={`list-row${c.id === activeId ? ' active' : ''}`}
                  onClick={() => useAppStore.getState().select({ kind: 'controller', id: c.id }, { reveal: true })}
                >
                  <span className="list-main">{c.name}</span>
                  <span className="list-side">
                    {SIGNAL_MODE_LABELS[c.mode]} · {S.feux.cycle} {formatNumber(controllerCycle(c))} {S.unites.s}
                    {c.nodeIds.length > 1 ? ` · ${c.nodeIds.length} ${S.feux.noeuds}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">{S.feux.aucun}</p>
        )}
      </section>
      {active ? <ControllerEditor network={network} controller={active} /> : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Éditeur d'un contrôleur                                            */
/* ------------------------------------------------------------------ */

function ControllerEditor({ network, controller }: { network: Network; controller: SignalController }): JSX.Element {
  const movements = useMemo(() => controllerMovements(network, controller), [network, controller])
  const anomalies = useMemo(() => validateController(network, controller), [network, controller])
  // Phase en cours dans la simulation : sélecteur scalaire, l'éditeur ne se redessine qu'au changement de phase.
  const currentPhase = useAppStore((s) => s.sim.frame?.controllers.find((c) => c.id === controller.id)?.phaseIndex ?? -1)
  const cycle = controllerCycle(controller)
  const update = useAppStore.getState().updateController

  return (
    <section className="block">
      <h3>{controller.name}</h3>
      <label className="field">
        <span className="field-label">{S.reseau.label}</span>
        <span className="field-input">
          <input type="text" value={controller.name} onChange={(e) => update(controller.id, { name: e.target.value })} />
        </span>
      </label>
      <label className="field">
        <span className="field-label">{S.feux.mode}</span>
        <select
          value={controller.mode}
          data-testid="mode-feux"
          onChange={(e) => update(controller.id, { mode: e.target.value as SignalController['mode'] })}
        >
          {SIGNAL_MODES.map((m) => <option key={m} value={m}>{SIGNAL_MODE_LABELS[m]}</option>)}
        </select>
      </label>
      <div className="row">
        <NumberField label={S.feux.decalage} value={controller.offset} min={0} unit={S.unites.s} onChange={(v) => update(controller.id, { offset: v })} />
        <NumberField label={S.feux.orange} value={controller.amber} min={0} max={10} step={0.5} unit={S.unites.s} onChange={(v) => update(controller.id, { amber: v })} />
        <NumberField label={S.feux.rougeIntegral} value={controller.allRed} min={0} max={10} step={0.5} unit={S.unites.s} onChange={(v) => update(controller.id, { allRed: v })} />
      </div>
      {controller.mode === 'actuated' ? (
        <label className="check">
          <input
            type="checkbox"
            checked={controller.actuated.skipEmpty}
            onChange={(e) => update(controller.id, { actuated: { skipEmpty: e.target.checked } })}
          />
          {S.feux.sauterPhases}
        </label>
      ) : null}

      <h4>{S.feux.diagramme} · {formatNumber(cycle)} {S.unites.s}</h4>
      <CycleDiagram controller={controller} currentPhase={currentPhase} />

      <h4>{S.feux.anomalies}</h4>
      {anomalies.length ? (
        <ul className="warnings">{anomalies.map((a, i) => <li key={i}>{a}</li>)}</ul>
      ) : (
        <p className="hint">{S.feux.aucuneAnomalie}</p>
      )}

      <h4>{S.feux.phases}</h4>
      {!movements.length ? <p className="hint">{S.feux.mouvementsAucun}</p> : null}
      {controller.phases.map((phase, index) => (
        <PhaseCard
          key={phase.id}
          network={network}
          controller={controller}
          phase={phase}
          index={index}
          movements={movements}
          current={index === currentPhase}
        />
      ))}
      <div className="row">
        <button type="button" className="button" onClick={() => useAppStore.getState().addPhase(controller.id)}>{S.feux.ajouterPhase}</button>
        <button
          type="button"
          className="button"
          onClick={() => { if (confirm(S.feux.confirmerRegenerer)) useAppStore.getState().resetControllerPlan(controller.id) }}
        >
          {S.feux.regenerer}
        </button>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/*  Carte d'une phase                                                  */
/* ------------------------------------------------------------------ */

function PhaseCard(props: {
  network: Network
  controller: SignalController
  phase: SignalPhase
  index: number
  movements: Movement[]
  current: boolean
}): JSX.Element {
  const { network, controller, phase, index, movements, current } = props
  const store = useAppStore.getState()
  const actuated = controller.mode === 'actuated'

  return (
    <article className={`phase-card${current ? ' current' : ''}`}>
      <header>
        <input
          type="text"
          className="phase-name"
          value={phase.name}
          aria-label={S.feux.nomPhase}
          onChange={(e) => store.updatePhase(controller.id, phase.id, { name: e.target.value })}
        />
        {current ? <span className="badge">{S.feux.phaseCourante}</span> : null}
        <button type="button" className="icon-button" title={S.feux.monter} aria-label={S.feux.monter} onClick={() => store.movePhase(controller.id, phase.id, -1)}>↑</button>
        <button type="button" className="icon-button" title={S.feux.descendre} aria-label={S.feux.descendre} onClick={() => store.movePhase(controller.id, phase.id, 1)}>↓</button>
        <button type="button" className="icon-button danger" title={S.feux.supprimerPhase} aria-label={S.feux.supprimerPhase} onClick={() => store.removePhase(controller.id, phase.id)}>×</button>
      </header>
      <div className="row">
        <NumberField
          label={S.feux.vert}
          value={phase.green}
          min={0}
          unit={S.unites.s}
          disabled={actuated}
          onChange={(v) => store.updatePhase(controller.id, phase.id, { green: v })}
        />
        {actuated ? (
          <>
            <NumberField label={S.feux.vertMin} value={phase.minGreen} min={1} unit={S.unites.s} onChange={(v) => store.updatePhase(controller.id, phase.id, { minGreen: v })} />
            <NumberField label={S.feux.vertMax} value={phase.maxGreen} min={1} unit={S.unites.s} onChange={(v) => store.updatePhase(controller.id, phase.id, { maxGreen: v })} />
            <NumberField label={S.feux.prolongation} value={phase.gap} min={0} step={0.5} unit={S.unites.s} onChange={(v) => store.updatePhase(controller.id, phase.id, { gap: v })} />
          </>
        ) : null}
      </div>
      <IntersectionDiagram
        network={network}
        movements={movements}
        phase={phase}
        onToggle={(key, kind) => store.setPhaseMovement(controller.id, phase.id, key, kind)}
      />
      <p className="hint">{S.feux.schema} · {index + 1}/{controller.phases.length}</p>
    </article>
  )
}

/* ------------------------------------------------------------------ */
/*  Schéma du carrefour                                                */
/* ------------------------------------------------------------------ */

const SIZE = 240
const CENTER = SIZE / 2
/** Rayon des extrémités de flèche, du bord du carrefour, des amorces de voirie et des étiquettes. */
const R_ARROW = 92
const R_INNER = 32
const R_STUB = 108
const R_TEXT = 114
/** Position du point de contrôle de Bézier, en fraction de la distance au centre, selon le type de mouvement. */
const CONTROL_FACTOR: Record<Movement['turn'], number> = { through: 0.5, right: 0.45, left: 1.1, uturn: 1.45 }
const MOVEMENT_STATES: (GreenKind | null)[] = [null, 'protected', 'permitted']

/** Repère mathématique (y vers le nord) → repère SVG (y vers le bas). */
function point(angle: number, radius: number): [number, number] {
  return [CENTER + radius * Math.cos(angle), CENTER - radius * Math.sin(angle)]
}

function movementPath(m: Movement): string {
  const [x1, y1] = point(m.inAngle, R_ARROW)
  const [x2, y2] = point(m.outAngle, R_ARROW)
  const k = CONTROL_FACTOR[m.turn]
  const c1x = x1 + (CENTER - x1) * k
  const c1y = y1 + (CENTER - y1) * k
  const c2x = x2 + (CENTER - x2) * k
  const c2y = y2 + (CENTER - y2) * k
  return `M${x1.toFixed(1)} ${y1.toFixed(1)} C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`
}

function stateClass(kind: GreenKind | undefined): string {
  if (kind === 'protected') return 'protege'
  if (kind === 'permitted') return 'permis'
  return 'rouge'
}

function IntersectionDiagram(props: {
  network: Network
  movements: Movement[]
  phase: SignalPhase
  onToggle(key: MovementKey, kind: GreenKind | null): void
}): JSX.Element {
  const { network, movements, phase, onToggle } = props
  const markerPrefix = useId().replace(/[^a-zA-Z0-9]/g, '')

  // Amorces de voirie : un trait par angle d'approche et de sortie (les deux voies d'une rue forment un V).
  const stubs = useMemo(() => {
    const seen = new Map<string, { angle: number; label: string; approach: boolean }>()
    for (const m of movements) {
      const inName = network.edges[m.from]?.name ?? ''
      const outName = network.edges[m.to]?.name ?? ''
      const inKey = `i${m.from}`
      const outKey = `o${m.to}`
      if (!seen.has(inKey)) seen.set(inKey, { angle: m.inAngle, label: inName, approach: true })
      if (!seen.has(outKey)) seen.set(outKey, { angle: m.outAngle, label: outName, approach: false })
    }
    return [...seen.values()]
  }, [movements, network])

  const approachCount = stubs.filter((s) => s.approach).length

  return (
    <svg className="carrefour" viewBox={`${-18} ${-18} ${SIZE + 36} ${SIZE + 36}`} role="group" aria-label={S.feux.schema}>
      <defs>
        {(['rouge', 'protege', 'permis'] as const).map((name) => (
          <marker key={name} id={`${markerPrefix}-${name}`} viewBox="0 0 8 8" refX="6" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path className={`pointe ${name}`} d="M0 0 L8 4 L0 8 z" />
          </marker>
        ))}
      </defs>
      <circle className="chaussee" cx={CENTER} cy={CENTER} r={R_INNER} />
      {stubs.map((stub, i) => {
        const [x1, y1] = point(stub.angle, R_INNER)
        const [x2, y2] = point(stub.angle, R_STUB)
        const [tx, ty] = point(stub.angle, R_TEXT)
        const anchor = Math.abs(Math.cos(stub.angle)) < 0.3 ? 'middle' : Math.cos(stub.angle) > 0 ? 'start' : 'end'
        return (
          <g key={i}>
            <line className="amorce" x1={x1} y1={y1} x2={x2} y2={y2} />
            {stub.approach && stub.label && approachCount <= 4 ? (
              <text className="amorce-label" x={tx} y={ty + 3} textAnchor={anchor}>
                {stub.label.length > 12 ? `${stub.label.slice(0, 11)}…` : stub.label}
              </text>
            ) : null}
          </g>
        )
      })}
      {movements.map((m) => {
        const kind = phase.movements[m.key]
        const css = stateClass(kind)
        const next = MOVEMENT_STATES[(MOVEMENT_STATES.indexOf(kind ?? null) + 1) % MOVEMENT_STATES.length]
        const d = movementPath(m)
        const description = `${describeMovement(network, m)} — ${kind ? GREEN_KIND_LABELS[kind] : S.feux.rouge}`
        return (
          <g key={m.key} className="mouvement" onClick={() => onToggle(m.key, next)} role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(m.key, next) } }}>
            <title>{description}</title>
            <path className="cible" d={d} />
            <path className={`fleche ${css}`} d={d} markerEnd={`url(#${markerPrefix}-${css})`} />
          </g>
        )
      })}
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/*  Diagramme temporel du cycle                                        */
/* ------------------------------------------------------------------ */

function CycleDiagram({ controller, currentPhase }: { controller: SignalController; currentPhase: number }): JSX.Element {
  const cycle = controllerCycle(controller)
  if (!controller.phases.length || cycle <= 0) return <p className="hint">{S.feux.aucunePhase}</p>
  let start = 0
  return (
    <div className="cycle-diagram">
      {controller.phases.map((phase, i) => {
        const green = phase.green
        const amber = phaseAmber(controller, phase)
        const allRed = phaseAllRed(controller, phase)
        const offset = start
        start += phaseDuration(controller, phase)
        const pct = (v: number): string => `${(v / cycle) * 100}%`
        return (
          <div className={`cycle-row${i === currentPhase ? ' current' : ''}`} key={phase.id}>
            <span className="cycle-label" title={phase.name}>{phase.name}</span>
            <span className="cycle-track">
              <span className="cycle-bar vert" style={{ left: pct(offset), width: pct(green) }} title={`${S.feux.vert} ${formatNumber(green)} ${S.unites.s}`} />
              <span className="cycle-bar orange" style={{ left: pct(offset + green), width: pct(amber) }} title={`${S.feux.orange} ${formatNumber(amber)} ${S.unites.s}`} />
              <span className="cycle-bar rouge" style={{ left: pct(offset + green + amber), width: pct(allRed) }} title={`${S.feux.rougeIntegral} ${formatNumber(allRed)} ${S.unites.s}`} />
            </span>
            <span className="cycle-value">{formatNumber(green)} {S.unites.s}</span>
          </div>
        )
      })}
    </div>
  )
}
