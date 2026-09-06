/**
 * Automates de feux (§5.4 de docs/ARCHITECTURE.md) : plan fixe, mode adaptatif à détecteur de ligne d'arrêt,
 * clignotant et éteint. L'état est maintenu par mouvement (`state` / `since`) pour que la décharge puisse
 * appliquer le temps perdu au démarrage et la part utilisable de l'orange.
 */
import type { ControllerId, Network, NodeId, SignalController } from '@/model/types'
import type { ControllerState } from './protocol'
import { phaseAllRed, phaseAmber } from '@/model/signals'
import type { EngineGraph } from './routing'

/** Mouvement au rouge. */
export const SIG_RED = 0
/** Vert sans cession (protégé). */
export const SIG_GREEN_PROTECTED = 1
/** Vert avec cession (permis) : le mouvement cède aux mouvements verts en conflit. */
export const SIG_GREEN_PERMITTED = 2
export const SIG_AMBER = 3
/** Mouvement non piloté : carrefour sans feux, approche interne à un regroupement, contrôleur clignotant/éteint. */
export const SIG_FREE = 4

/** État interne d'un contrôleur : vert, orange, rouge intégral. */
const K_GREEN = 0
const K_AMBER = 1
const K_ALLRED = 2

/** Informations de trafic dont le mode adaptatif a besoin. */
export interface SignalProbe {
  /** Dernier instant où un véhicule a franchi la ligne d'arrêt ou est arrivé en tête sur ce tronçon. */
  lastActivity(edgeIdx: number): number
  /** Nombre de véhicules arrivés en tête (en attente) sur ce tronçon. */
  queueLength(edgeIdx: number): number
}

interface PhaseRuntime {
  green: number
  amber: number
  allRed: number
  minGreen: number
  maxGreen: number
  gap: number
  /** États des mouvements pilotés (alignés sur `ControllerRuntime.allMovs`) pendant le vert. */
  greenStates: Uint8Array
  /** Idem pendant l'orange : les mouvements verts de la phase passent à `SIG_AMBER`. */
  amberStates: Uint8Array
  /** Tronçons d'approche distincts des mouvements verts de la phase. */
  approaches: Int32Array
}

interface ControllerRuntime {
  id: ControllerId
  mode: SignalController['mode']
  offset: number
  cycle: number
  skipEmpty: boolean
  phases: PhaseRuntime[]
  /** Tous les mouvements pilotés par le contrôleur. */
  allMovs: Int32Array
  phaseIndex: number
  kind: number
  stateStart: number
  /** Signature JSON : un contrôleur inchangé conserve son état lors d'un `updateSignals`. */
  signature: string
}

export class SignalEngine {
  /** État courant par index de mouvement. */
  readonly state: Uint8Array
  /** Début de l'état courant du mouvement (s). */
  readonly since: Float64Array
  /** Nœuds réellement pilotés par des feux (modes `fixed` / `actuated`). */
  readonly signalizedNodes: Set<NodeId> = new Set()
  /** Avertissements de construction, en français. */
  readonly warnings: string[] = []

  private readonly controllers: ControllerRuntime[] = []
  private readonly g: EngineGraph

  constructor(graph: EngineGraph, network: Network) {
    this.g = graph
    const nMov = graph.movements.length
    this.state = new Uint8Array(nMov).fill(SIG_FREE)
    this.since = new Float64Array(nMov).fill(-Infinity)

    for (const id of Object.keys(network.controllers).sort()) {
      const c = network.controllers[id]
      const inside = new Set(c.nodeIds)
      // Un nœud n'est piloté que si sa régulation le déclare : `controls` et `controllers` restent ainsi
      // cohérents avec `effectiveControl` (utilisé par les tables de priorité).
      const piloted = c.nodeIds.filter((id) => network.controls[id]?.type === 'signals')
      // Mouvements pilotés : ceux des nœuds couverts dont l'approche vient de l'extérieur du regroupement.
      const controlled: number[] = []
      for (const nodeId of piloted) {
        const n = graph.nodeOf.get(nodeId)
        if (n === undefined) continue
        for (let k = graph.nodeMovStart[n]; k < graph.nodeMovStart[n + 1]; k++) {
          const mv = graph.nodeMovList[k]
          const fromEdge = graph.movementFrom[mv]
          if (fromEdge < 0) continue
          const fromNode = graph.edgeFromNode[fromEdge]
          if (fromNode >= 0 && inside.has(graph.nodeIds[fromNode])) continue
          controlled.push(mv)
        }
      }
      const active = c.mode === 'fixed' || c.mode === 'actuated'
      if (active) for (const nodeId of piloted) if (graph.nodeOf.has(nodeId)) this.signalizedNodes.add(nodeId)

      const slotOf = new Map<number, number>()
      controlled.forEach((mv, i) => slotOf.set(mv, i))
      const phases: PhaseRuntime[] = []
      for (const p of c.phases) {
        const greenStates = new Uint8Array(controlled.length).fill(SIG_RED)
        const amberStates = new Uint8Array(controlled.length).fill(SIG_RED)
        const approaches = new Set<number>()
        for (const [key, kind] of Object.entries(p.movements)) {
          const mv = graph.movementOf.get(key)
          if (mv === undefined) continue
          const slot = slotOf.get(mv)
          if (slot === undefined) continue // mouvement interne au regroupement : toujours franchissable
          greenStates[slot] = kind === 'permitted' ? SIG_GREEN_PERMITTED : SIG_GREEN_PROTECTED
          amberStates[slot] = SIG_AMBER
          approaches.add(graph.movementFrom[mv])
        }
        phases.push({
          green: Math.max(0, p.green),
          amber: Math.max(0, phaseAmber(c, p)),
          allRed: Math.max(0, phaseAllRed(c, p)),
          minGreen: Math.max(0, p.minGreen),
          maxGreen: Math.max(Math.max(0, p.minGreen), p.maxGreen),
          gap: Math.max(0, p.gap),
          greenStates,
          amberStates,
          approaches: Int32Array.from([...approaches].sort((a, b) => a - b)),
        })
      }
      let cycle = 0
      for (const p of phases) cycle += p.green + p.amber + p.allRed
      if (active && cycle <= 0) {
        this.warnings.push(`Contrôleur « ${c.name || id} » : temps de cycle nul, tous les mouvements restent au rouge.`)
      }
      this.controllers.push({
        id, mode: c.mode, offset: c.offset, cycle, skipEmpty: c.actuated.skipEmpty,
        phases, allMovs: Int32Array.from(controlled),
        phaseIndex: 0, kind: K_GREEN, stateStart: Number.NaN,
        signature: JSON.stringify(c),
      })
    }
  }

  /** Reprend l'état courant des contrôleurs identiques (modification de feux à chaud). */
  adoptStateFrom(previous: SignalEngine): void {
    const old = new Map(previous.controllers.map((c) => [c.id, c]))
    for (const c of this.controllers) {
      const p = old.get(c.id)
      if (p && p.signature === c.signature) {
        c.phaseIndex = p.phaseIndex
        c.kind = p.kind
        c.stateStart = p.stateStart
      }
    }
  }

  reset(): void {
    this.state.fill(SIG_FREE)
    this.since.fill(-Infinity)
    for (const c of this.controllers) {
      c.phaseIndex = 0
      c.kind = K_GREEN
      c.stateStart = Number.NaN
    }
  }

  /** Fait avancer tous les contrôleurs au temps `t` et publie l'état de chaque mouvement piloté. */
  update(t: number, probe: SignalProbe): void {
    for (const c of this.controllers) {
      if (c.mode === 'flashing' || c.mode === 'off') {
        // Le carrefour se comporte comme un `priority_class` : les mouvements redeviennent libres.
        for (let i = 0; i < c.allMovs.length; i++) this.setState(c.allMovs[i], SIG_FREE, t)
        continue
      }
      if (c.phases.length === 0 || c.cycle <= 0) {
        for (let i = 0; i < c.allMovs.length; i++) this.setState(c.allMovs[i], SIG_RED, t)
        continue
      }
      if (c.mode === 'fixed') this.advanceFixed(c, t)
      else this.advanceActuated(c, t, probe)
      this.publish(c)
    }
  }

  private setState(mv: number, s: number, since: number): void {
    if (this.state[mv] !== s) {
      this.state[mv] = s
      this.since[mv] = since
    }
  }

  private advanceFixed(c: ControllerRuntime, t: number): void {
    let tau = (t - c.offset) % c.cycle
    if (tau < 0) tau += c.cycle
    let acc = 0
    for (let i = 0; i < c.phases.length; i++) {
      const p = c.phases[i]
      const total = p.green + p.amber + p.allRed
      if (tau < acc + total || i === c.phases.length - 1) {
        const local = tau - acc
        c.phaseIndex = i
        if (local < p.green) { c.kind = K_GREEN; c.stateStart = t - local }
        else if (local < p.green + p.amber) { c.kind = K_AMBER; c.stateStart = t - (local - p.green) }
        else { c.kind = K_ALLRED; c.stateStart = t - (local - p.green - p.amber) }
        return
      }
      acc += total
    }
  }

  private advanceActuated(c: ControllerRuntime, t: number, probe: SignalProbe): void {
    if (!Number.isFinite(c.stateStart)) {
      c.phaseIndex = 0
      c.kind = K_GREEN
      c.stateStart = t
      return
    }
    let guard = 8
    while (guard-- > 0) {
      const p = c.phases[c.phaseIndex]
      if (c.kind === K_GREEN) {
        const g = t - c.stateStart
        let terminate = g >= p.maxGreen
        if (!terminate && g >= p.minGreen) {
          // Détecteur à la ligne d'arrêt : la file qui se décharge repousse la fin du vert jusqu'à maxGreen.
          let last = -Infinity
          for (let i = 0; i < p.approaches.length; i++) {
            const a = probe.lastActivity(p.approaches[i])
            if (a > last) last = a
          }
          terminate = t - last >= p.gap
        }
        if (!terminate) return
        c.kind = K_AMBER
        c.stateStart = t
      } else if (c.kind === K_AMBER) {
        if (t - c.stateStart < p.amber) return
        c.kind = K_ALLRED
        c.stateStart = t
      } else {
        if (t - c.stateStart < p.allRed) return
        c.phaseIndex = this.nextPhase(c, probe)
        c.kind = K_GREEN
        c.stateStart = t
        return
      }
    }
  }

  /** Phase suivante ; en `skipEmpty`, première phase suivante ayant de la demande (sinon on reste sur place). */
  private nextPhase(c: ControllerRuntime, probe: SignalProbe): number {
    const n = c.phases.length
    if (!c.skipEmpty) return (c.phaseIndex + 1) % n
    for (let k = 1; k <= n; k++) {
      const idx = (c.phaseIndex + k) % n
      const p = c.phases[idx]
      for (let i = 0; i < p.approaches.length; i++) {
        if (probe.queueLength(p.approaches[i]) > 0) return idx
      }
    }
    return c.phaseIndex
  }

  /**
   * Publie l'état de chaque mouvement piloté. `setState` ne rafraîchit `since` que sur changement :
   * un mouvement vert dans deux phases consécutives conserve donc son début de vert (pas de temps perdu
   * au démarrage réappliqué).
   */
  private publish(c: ControllerRuntime): void {
    const since = c.stateStart
    const p = c.phases[c.phaseIndex]
    const table = c.kind === K_GREEN ? p.greenStates : c.kind === K_AMBER ? p.amberStates : null
    for (let i = 0; i < c.allMovs.length; i++) {
      this.setState(c.allMovs[i], table ? table[i] : SIG_RED, since)
    }
  }

  /** États publiés dans les frames. */
  states(t: number): ControllerState[] {
    const out: ControllerState[] = []
    for (const c of this.controllers) {
      if (c.mode === 'flashing' || c.mode === 'off') {
        out.push({ id: c.id, phaseIndex: -1, state: c.mode === 'flashing' ? 'flashing' : 'off', remaining: 0 })
        continue
      }
      if (c.phases.length === 0 || c.cycle <= 0) {
        out.push({ id: c.id, phaseIndex: 0, state: 'allred', remaining: 0 })
        continue
      }
      const p = c.phases[c.phaseIndex]
      const elapsed = Number.isFinite(c.stateStart) ? t - c.stateStart : 0
      const total = c.kind === K_GREEN
        ? (c.mode === 'actuated' ? p.maxGreen : p.green)
        : c.kind === K_AMBER ? p.amber : p.allRed
      out.push({
        id: c.id,
        phaseIndex: c.phaseIndex,
        state: c.kind === K_GREEN ? 'green' : c.kind === K_AMBER ? 'amber' : 'allred',
        remaining: Math.max(0, total - elapsed),
      })
    }
    return out
  }

  /**
   * Part du cycle pendant laquelle au moins un mouvement du tronçon est vert (1 hors feux) —
   * dénominateur de la saturation (§5.7).
   */
  greenShareByEdge(): Float64Array {
    const share = new Float64Array(this.g.edgeIds.length).fill(1)
    for (const c of this.controllers) {
      if (c.mode !== 'fixed' && c.mode !== 'actuated') continue
      if (c.cycle <= 0) continue
      const green = new Map<number, number>()
      const controlledEdges = new Set<number>()
      for (let i = 0; i < c.allMovs.length; i++) {
        const from = this.g.movementFrom[c.allMovs[i]]
        if (from >= 0) controlledEdges.add(from)
      }
      for (const p of c.phases) {
        for (let i = 0; i < p.approaches.length; i++) {
          const e = p.approaches[i]
          green.set(e, (green.get(e) ?? 0) + p.green)
        }
      }
      for (const e of controlledEdges) share[e] = (green.get(e) ?? 0) / c.cycle
    }
    return share
  }
}
