/**
 * Génération des arrivées (§5.3 de docs/ARCHITECTURE.md).
 *
 * Chaque entrée possède son propre flux aléatoire (`seed ⊕ hash("entry:" + nodeId)`) : ajouter, retirer ou
 * modifier une entrée ne décale pas les tirages des autres. Le trafic interne utilise le flux `"internal"`.
 * Deux scénarios partageant la même demande et les mêmes nœuds frontières produisent donc exactement les
 * mêmes arrivées (variables aléatoires communes), même si le réseau a été modifié ailleurs.
 */
import type { Demand, EdgeId, NetEdge, Network, NodeId, SimSettings } from '@/model/types'
import { INTERNAL_TRIP_WEIGHT } from '@/model/defaults'
import { createRng, exponential, streamSeed } from './rng'

export interface Arrival {
  /** Horodatage (s depuis le début de la simulation, chauffe comprise). */
  time: number
  /** Nœud frontière d'entrée, ou `null` pour une origine interne. */
  entryId: NodeId | null
  /** Tronçon d'origine (trajet né dans la zone), ou `null`. */
  originEdgeId: EdgeId | null
  /** Nœud frontière de sortie visé, ou `null` si la destination est un tronçon interne. */
  exitId: NodeId | null
  /** Tronçon de destination (trajet se terminant dans la zone), ou `null`. */
  destEdgeId: EdgeId | null
}

/** Ensemble de tirage pondéré, avec poids cumulés pour une recherche dichotomique. */
interface WeightedSet<T> {
  items: T[]
  cum: Float64Array
  total: number
}

function makeWeighted<T>(items: T[], weight: (x: T) => number): WeightedSet<T> {
  const cum = new Float64Array(items.length)
  let s = 0
  for (let i = 0; i < items.length; i++) {
    s += Math.max(0, weight(items[i]))
    cum[i] = s
  }
  return { items, cum, total: s }
}

function pickIndex<T>(set: WeightedSet<T>, rng: () => number): number {
  if (set.total <= 0 || set.items.length === 0) return -1
  const u = rng() * set.total
  let lo = 0
  let hi = set.cum.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (u < set.cum[mid]) hi = mid
    else lo = mid + 1
  }
  return lo
}

/**
 * Tronçons éligibles comme origine/destination interne : les deux extrémités à l'intérieur de la zone,
 * poids `INTERNAL_TRIP_WEIGHT[classe] × longueur`.
 */
export function internalTripEdges(network: Network): WeightedSet<NetEdge> {
  const candidates: NetEdge[] = []
  for (const id of Object.keys(network.edges).sort()) {
    const e = network.edges[id]
    if (e.closed) continue
    const a = network.nodes[e.from]
    const b = network.nodes[e.to]
    if (!a || !b || a.boundary || b.boundary) continue
    if (INTERNAL_TRIP_WEIGHT[e.highway] * e.length <= 0) continue
    candidates.push(e)
  }
  return makeWeighted(candidates, (e) => INTERNAL_TRIP_WEIGHT[e.highway] * e.length)
}

/**
 * Tire une sortie en excluant `excludeNode` (la sortie portée par le nœud d'entrée) :
 * un retirage, puis repli sur la sortie suivante de la liste. `null` si aucune sortie utilisable.
 */
function pickExit(set: WeightedSet<NodeId>, rng: () => number, excludeNode: NodeId | null): NodeId | null {
  let i = pickIndex(set, rng)
  if (i < 0) return null
  if (excludeNode !== null && set.items[i] === excludeNode) {
    i = pickIndex(set, rng)
    if (i < 0) return null
    if (set.items[i] === excludeNode) {
      const n = set.items.length
      for (let k = 1; k <= n; k++) {
        const j = (i + k) % n
        if (set.items[j] !== excludeNode) return set.items[j]
      }
      return null
    }
  }
  return set.items[i]
}

/** Tire un tronçon interne différent de `excludeEdge` (même logique de repli). */
function pickInternalEdge(set: WeightedSet<NetEdge>, rng: () => number, excludeEdge: EdgeId | null): EdgeId | null {
  let i = pickIndex(set, rng)
  if (i < 0) return null
  if (excludeEdge !== null && set.items[i].id === excludeEdge) {
    i = pickIndex(set, rng)
    if (i < 0) return null
    if (set.items[i].id === excludeEdge) {
      const n = set.items.length
      for (let k = 1; k <= n; k++) {
        const j = (i + k) % n
        if (set.items[j].id !== excludeEdge) return set.items[j].id
      }
      return null
    }
  }
  return set.items[i].id
}

/**
 * Arrivées sur `[0, warmup + duration)`, triées par horodatage croissant.
 * L'ordre de la liste fixe la numérotation des véhicules (identifiants stables pour l'animation).
 */
export function generateArrivals(network: Network, demand: Demand, settings: SimSettings): Arrival[] {
  const horizon = Math.max(0, (settings.warmupMin + settings.durationMin) * 60)
  const factor = Math.max(0, demand.globalFactor)
  const out: Arrival[] = []
  if (horizon <= 0 || factor <= 0) return out

  const internalOn = demand.internal.enabled
  const internalEdges = internalTripEdges(network)

  const exitIds = Object.keys(demand.exits)
    .filter((id) => demand.exits[id].enabled && demand.exits[id].weight > 0 && !!network.nodes[id])
    .sort()
  const exitSet = makeWeighted(exitIds, (id) => demand.exits[id].weight)

  const outgoing = new Set<NodeId>()
  for (const e of Object.values(network.edges)) if (!e.closed) outgoing.add(e.from)

  const entryIds = Object.keys(demand.entries)
    .filter((id) => demand.entries[id].enabled && demand.entries[id].flow > 0 && !!network.nodes[id] && outgoing.has(id))
    .sort()

  for (const entryId of entryIds) {
    const rate = (demand.entries[entryId].flow * factor) / 3600
    if (!(rate > 0)) continue
    const rng = createRng(streamSeed(demand.seed, `entry:${entryId}`))
    // Ligne OD de l'entrée : utilisée seulement en mode `od` et si elle porte au moins une part non nulle.
    let destSet = exitSet
    if (demand.destinationMode === 'od') {
      const row = demand.od[entryId]
      if (row) {
        const ids = exitIds.filter((x) => (row[x] ?? 0) > 0)
        const candidate = makeWeighted(ids, (x) => row[x] ?? 0)
        if (candidate.total > 0) destSet = candidate
      }
    }
    const internalShare = internalOn ? Math.min(1, Math.max(0, demand.internal.entryInternalShare)) : 0

    let t = 0
    for (;;) {
      t += exponential(rng, rate)
      if (t >= horizon) break
      let destEdgeId: EdgeId | null = null
      if (internalShare > 0 && rng() < internalShare) destEdgeId = pickInternalEdge(internalEdges, rng, null)
      const exitId = destEdgeId === null ? pickExit(destSet, rng, entryId) : null
      if (destEdgeId === null && exitId === null) continue // aucune destination atteignable : arrivée abandonnée
      out.push({ time: t, entryId, originEdgeId: null, exitId, destEdgeId })
    }
  }

  if (internalOn && demand.internal.generationRate > 0 && internalEdges.items.length > 0) {
    const rate = (demand.internal.generationRate * factor) / 3600
    const rng = createRng(streamSeed(demand.seed, 'internal'))
    const destShare = Math.min(1, Math.max(0, demand.internal.internalDestinationShare))
    let t = 0
    for (;;) {
      t += exponential(rng, rate)
      if (t >= horizon) break
      const oi = pickIndex(internalEdges, rng)
      if (oi < 0) break
      const originEdgeId = internalEdges.items[oi].id
      let destEdgeId: EdgeId | null = null
      if (destShare > 0 && rng() < destShare) destEdgeId = pickInternalEdge(internalEdges, rng, originEdgeId)
      const exitId = destEdgeId === null ? pickExit(exitSet, rng, null) : null
      if (destEdgeId === null && exitId === null) continue
      out.push({ time: t, entryId: null, originEdgeId, exitId, destEdgeId })
    }
  }

  // `sort` est stable : à horodatage égal, l'ordre des flux (entrées triées puis interne) est conservé.
  out.sort((a, b) => a.time - b.time)
  return out
}
