/**
 * Priorités hors feux (§5.6 de docs/ARCHITECTURE.md) : pour chaque mouvement, la liste précalculée des
 * mouvements auxquels il cède, le créneau critique associé, et la capacité de cession instantanée.
 *
 * Les mouvements « permis » aux feux dépendent des mouvements verts à l'instant courant : on précalcule
 * seulement leurs conflits (et le sens de la priorité à droite entre deux permis), la sélection est faite
 * au pas de simulation.
 */
import type { Movement } from '@/model/geometry'
import { movementsConflict, passesEntry, relativeSide } from '@/model/geometry'
import type { NetEdge, Network, NodeId, SimSettings } from '@/model/types'
import { highwayRank } from '@/model/types'
import { effectiveControl } from '@/model/defaults'
import type { EngineGraph } from './routing'

export interface PriorityTables {
  /** CSR : mouvements auxquels `m` cède (carrefours sans feux). */
  yieldStart: Int32Array
  yieldList: Int32Array
  /** Créneau critique (s) du mouvement. */
  gap: Float64Array
  /** Le mouvement est soumis à une cession (capacité limitée par le flux prioritaire). */
  yielding: Uint8Array
  /** Le mouvement est protégé par un stop : arrêt marqué obligatoire avant de repartir. */
  stopRequired: Uint8Array
  /** CSR : mouvements en conflit au même nœud (rempli seulement aux carrefours à feux). */
  conflictStart: Int32Array
  conflictList: Int32Array
  /** Pour chaque entrée de `conflictList` : `m` cède-t-il à ce mouvement par priorité à droite ? */
  conflictYieldRight: Uint8Array
}

/**
 * Règle « priorité à droite » : `m` cède à `n` (conflictuels) si l'approche de `n` est à droite ;
 * si les approches sont opposées, seul le tourne-à-gauche (ou demi-tour) cède au tout-droit et au tourne-à-droite.
 */
export function yieldsByRight(m: Movement, n: Movement): boolean {
  const side = relativeSide(m.inAngle, n.inAngle)
  if (side === 'right') return true
  if (side === 'opposite') {
    return (m.turn === 'left' || m.turn === 'uturn') && (n.turn === 'through' || n.turn === 'right')
  }
  return false
}

/**
 * Capacité de cession (véh/s) pour un flux conflictuel `qc` (véh/s), un créneau critique `tc`
 * et un temps de suite `tf` — formule d'acceptation de créneaux exponentiels.
 */
export function yieldCapacity(qc: number, tc: number, tf: number): number {
  if (!(qc > 0)) return 1 / tf
  const denom = 1 - Math.exp(-qc * tf)
  if (denom <= 1e-12) return 1 / tf
  return (qc * Math.exp(-qc * tc)) / denom
}

/**
 * Construit les tables de priorité. `signalizedNodes` = nœuds réellement pilotés par des feux
 * (les contrôleurs en clignotant ou éteints ne s'y trouvent pas : leurs nœuds suivent `priority_class`).
 */
export function buildPriorityTables(
  graph: EngineGraph,
  network: Network,
  settings: SimSettings,
  signalizedNodes: Set<NodeId>,
): PriorityTables {
  const nMov = graph.movements.length
  const gap = new Float64Array(nMov)
  const yielding = new Uint8Array(nMov)
  const stopRequired = new Uint8Array(nMov)
  const yieldsOf: number[][] = new Array(nMov)
  const conflictsOf: number[][] = new Array(nMov)
  const rightOf: number[][] = new Array(nMov)
  for (let i = 0; i < nMov; i++) { yieldsOf[i] = []; conflictsOf[i] = []; rightOf[i] = [] }

  const G = settings.criticalGap
  const edgeOfIdx = (i: number): NetEdge => network.edges[graph.edgeIds[i]]

  const addYield = (a: number, b: number, tc: number): void => {
    yieldsOf[a].push(b)
    if (tc > gap[a]) gap[a] = tc
  }

  for (let n = 0; n < graph.nodeIds.length; n++) {
    const start = graph.nodeMovStart[n]
    const end = graph.nodeMovStart[n + 1]
    if (end - start < 1) continue
    const nodeId = graph.nodeIds[n]
    const movs: number[] = []
    for (let k = start; k < end; k++) movs.push(graph.nodeMovList[k])

    if (signalizedNodes.has(nodeId)) {
      // Carrefour à feux : seuls les conflits sont utiles (mouvements « permis »).
      for (const a of movs) {
        gap[a] = G.permittedLeft
        for (const b of movs) {
          if (a === b) continue
          if (!movementsConflict(graph.movements[a], graph.movements[b])) continue
          conflictsOf[a].push(b)
          rightOf[a].push(yieldsByRight(graph.movements[a], graph.movements[b]) ? 1 : 0)
        }
      }
      continue
    }

    const incoming: NetEdge[] = []
    for (let k = graph.inStart[n]; k < graph.inStart[n + 1]; k++) incoming.push(edgeOfIdx(graph.inList[k]))
    const control = effectiveControl(network, nodeId, incoming)
    // Un nœud « signals » dont le contrôleur est clignotant, éteint ou absent suit la priorité par classe.
    const type = control.type === 'signals' ? 'priority_class' : control.type

    if (type === 'roundabout') {
      const hasRing = incoming.some((e) => e.roundabout)
      for (const a of movs) {
        const ma = graph.movements[a]
        if (hasRing && edgeOfIdx(graph.movementFrom[a]).roundabout) continue // déjà sur l'anneau
        for (const b of movs) {
          if (a === b) continue
          const mb = graph.movements[b]
          if (hasRing) {
            if (!edgeOfIdx(graph.movementFrom[b]).roundabout) continue
            if (!movementsConflict(ma, mb)) continue
          } else if (!passesEntry(mb, ma)) {
            continue // mini-giratoire : `b` ne passe pas devant l'entrée de `a`
          }
          addYield(a, b, G.roundabout)
        }
      }
    } else if (type === 'stop' || type === 'give_way') {
      const explicit = control.yieldEdges ?? []
      const yieldEdges = new Set(explicit)
      const all = yieldEdges.size === 0 // `yieldEdges` vide : toutes les approches cèdent
      const cedes = (m: number): boolean => all || yieldEdges.has(graph.edgeIds[graph.movementFrom[m]])
      const tc = type === 'stop' ? G.stop : G.giveWay
      for (const a of movs) {
        const ya = cedes(a)
        if (type === 'stop' && ya) {
          stopRequired[a] = 1
          if (tc > gap[a]) gap[a] = tc
        }
        for (const b of movs) {
          if (a === b) continue
          if (!movementsConflict(graph.movements[a], graph.movements[b])) continue
          const yb = cedes(b)
          if (ya && !yb) addYield(a, b, tc)
          else if (ya === yb && yieldsByRight(graph.movements[a], graph.movements[b])) addYield(a, b, G.priorityRight)
        }
      }
    } else if (type === 'priority_class') {
      for (const a of movs) {
        const ra = highwayRank(edgeOfIdx(graph.movementFrom[a]).highway)
        for (const b of movs) {
          if (a === b) continue
          if (!movementsConflict(graph.movements[a], graph.movements[b])) continue
          const rb = highwayRank(edgeOfIdx(graph.movementFrom[b]).highway)
          if (rb < ra) addYield(a, b, G.giveWay)
          else if (rb === ra && yieldsByRight(graph.movements[a], graph.movements[b])) addYield(a, b, G.priorityRight)
        }
      }
    } else {
      // priority_right
      for (const a of movs) {
        for (const b of movs) {
          if (a === b) continue
          if (!movementsConflict(graph.movements[a], graph.movements[b])) continue
          if (yieldsByRight(graph.movements[a], graph.movements[b])) addYield(a, b, G.priorityRight)
        }
      }
    }
  }

  for (let i = 0; i < nMov; i++) {
    if (yieldsOf[i].length > 0 || stopRequired[i]) yielding[i] = 1
    if (yielding[i] && gap[i] <= 0) gap[i] = G.priorityRight
  }

  const yields = toCsr(yieldsOf)
  const conflicts = toCsr(conflictsOf)
  const conflictYieldRight = new Uint8Array(conflicts.list.length)
  let k = 0
  for (const row of rightOf) for (const v of row) conflictYieldRight[k++] = v

  return {
    yieldStart: yields.start,
    yieldList: yields.list,
    gap,
    yielding,
    stopRequired,
    conflictStart: conflicts.start,
    conflictList: conflicts.list,
    conflictYieldRight,
  }
}

/** Aplatit une liste d'adjacence en représentation compressée (CSR). */
function toCsr(lists: number[][]): { start: Int32Array; list: Int32Array } {
  let total = 0
  const start = new Int32Array(lists.length + 1)
  for (let i = 0; i < lists.length; i++) { start[i] = total; total += lists[i].length }
  start[lists.length] = total
  const list = new Int32Array(total)
  let k = 0
  for (const row of lists) for (const v of row) list[k++] = v
  return { start, list }
}
