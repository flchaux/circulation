/**
 * Graphe de tronçons et itinéraires (§5.5 de docs/ARCHITECTURE.md).
 *
 * Le moteur raisonne sur un graphe dont les sommets sont les tronçons orientés et les arcs les mouvements
 * autorisés (`nodeMovements`, qui exclut demi-tours, interdictions de tourner, tronçons fermés et
 * traversée des nœuds frontières). `buildGraph` construit une fois pour toutes les index (CSR) partagés
 * par le routage, les feux, les priorités et la simulation.
 */
import type { EdgeId, MovementKey, Network, NodeId } from '@/model/types'
import type { Movement } from '@/model/geometry'
import { buildAdjacency, nodeMovements } from '@/model/geometry'

/** Vitesse libre plancher (km/h) pour éviter les temps de parcours infinis. */
const MIN_SPEED_KMH = 5

/** Index complet du réseau utilisé par le moteur. Toutes les tables sont indexées par entier. */
export interface EngineGraph {
  network: Network
  /** Tronçons dans l'ordre stable (tri des identifiants) : c'est l'`edgeIndex` du protocole. */
  edgeIds: EdgeId[]
  edgeOf: Map<EdgeId, number>
  nodeIds: NodeId[]
  nodeOf: Map<NodeId, number>

  length: Float64Array
  /** Vitesse libre en m/s. */
  speed: Float64Array
  /** Temps de parcours à vide (s). */
  freeTime: Float64Array
  lanes: Int32Array
  closed: Uint8Array
  edgeFromNode: Int32Array
  edgeToNode: Int32Array
  boundary: Uint8Array

  movements: Movement[]
  movementFrom: Int32Array
  movementTo: Int32Array
  movementNode: Int32Array
  movementOf: Map<MovementKey, number>

  /** CSR des mouvements sortant d'un tronçon (successeurs). */
  succStart: Int32Array
  succList: Int32Array
  /** CSR des mouvements entrant vers un tronçon (prédécesseurs). */
  predStart: Int32Array
  predList: Int32Array
  /** CSR des mouvements d'un nœud. */
  nodeMovStart: Int32Array
  nodeMovList: Int32Array
  /** CSR des tronçons sortants / entrants d'un nœud (tous, y compris fermés). */
  outStart: Int32Array
  outList: Int32Array
  inStart: Int32Array
  inList: Int32Array
}

function csrFromCounts(counts: Int32Array): Int32Array {
  const start = new Int32Array(counts.length + 1)
  let acc = 0
  for (let i = 0; i < counts.length; i++) {
    start[i] = acc
    acc += counts[i]
  }
  start[counts.length] = acc
  return start
}

export function buildGraph(network: Network): EngineGraph {
  const edgeIds = Object.keys(network.edges).sort()
  const nEdges = edgeIds.length
  const edgeOf = new Map<EdgeId, number>()
  for (let i = 0; i < nEdges; i++) edgeOf.set(edgeIds[i], i)

  const nodeIds = Object.keys(network.nodes).sort()
  const nNodes = nodeIds.length
  const nodeOf = new Map<NodeId, number>()
  for (let i = 0; i < nNodes; i++) nodeOf.set(nodeIds[i], i)

  const length = new Float64Array(nEdges)
  const speed = new Float64Array(nEdges)
  const freeTime = new Float64Array(nEdges)
  const lanes = new Int32Array(nEdges)
  const closed = new Uint8Array(nEdges)
  const edgeFromNode = new Int32Array(nEdges).fill(-1)
  const edgeToNode = new Int32Array(nEdges).fill(-1)
  const boundary = new Uint8Array(nNodes)

  for (let i = 0; i < nNodes; i++) boundary[i] = network.nodes[nodeIds[i]].boundary ? 1 : 0

  const outCounts = new Int32Array(nNodes)
  const inCounts = new Int32Array(nNodes)
  for (let i = 0; i < nEdges; i++) {
    const e = network.edges[edgeIds[i]]
    length[i] = Math.max(0.1, e.length)
    speed[i] = (Math.max(MIN_SPEED_KMH, e.maxspeed) * 1000) / 3600
    freeTime[i] = length[i] / speed[i]
    lanes[i] = Math.max(1, Math.round(e.lanes))
    closed[i] = e.closed ? 1 : 0
    const f = nodeOf.get(e.from)
    const t = nodeOf.get(e.to)
    if (f !== undefined) { edgeFromNode[i] = f; outCounts[f]++ }
    if (t !== undefined) { edgeToNode[i] = t; inCounts[t]++ }
  }

  const outStart = csrFromCounts(outCounts)
  const inStart = csrFromCounts(inCounts)
  const outList = new Int32Array(outStart[nNodes])
  const inList = new Int32Array(inStart[nNodes])
  const outFill = outStart.slice(0, nNodes)
  const inFill = inStart.slice(0, nNodes)
  // Les tronçons étant parcourus dans l'ordre trié, les listes d'adjacence le sont aussi (déterminisme).
  for (let i = 0; i < nEdges; i++) {
    const f = edgeFromNode[i]
    if (f >= 0) outList[outFill[f]++] = i
    const t = edgeToNode[i]
    if (t >= 0) inList[inFill[t]++] = i
  }

  // Mouvements, nœud par nœud dans l'ordre trié.
  const adjacency = buildAdjacency(network)
  const movements: Movement[] = []
  const nodeMovStart = new Int32Array(nNodes + 1)
  const movementNodeList: number[] = []
  for (let n = 0; n < nNodes; n++) {
    nodeMovStart[n] = movements.length
    const id = nodeIds[n]
    // Listes triées : `nodeMovements` conserve l'ordre reçu, on garantit ainsi l'ordre des mouvements.
    const ins = (adjacency.incoming.get(id) ?? []).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const outs = (adjacency.outgoing.get(id) ?? []).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    for (const m of nodeMovements(network, id, ins, outs)) {
      movements.push(m)
      movementNodeList.push(n)
    }
  }
  nodeMovStart[nNodes] = movements.length

  const nMov = movements.length
  const movementFrom = new Int32Array(nMov)
  const movementTo = new Int32Array(nMov)
  const movementNode = Int32Array.from(movementNodeList)
  const movementOf = new Map<MovementKey, number>()
  const succCounts = new Int32Array(nEdges)
  const predCounts = new Int32Array(nEdges)
  for (let m = 0; m < nMov; m++) {
    const mv = movements[m]
    const f = edgeOf.get(mv.from)
    const t = edgeOf.get(mv.to)
    movementFrom[m] = f ?? -1
    movementTo[m] = t ?? -1
    movementOf.set(mv.key, m)
    if (f !== undefined) succCounts[f]++
    if (t !== undefined) predCounts[t]++
  }

  const succStart = csrFromCounts(succCounts)
  const predStart = csrFromCounts(predCounts)
  const succList = new Int32Array(succStart[nEdges])
  const predList = new Int32Array(predStart[nEdges])
  const succFill = succStart.slice(0, nEdges)
  const predFill = predStart.slice(0, nEdges)
  for (let m = 0; m < nMov; m++) {
    const f = movementFrom[m]
    if (f >= 0) succList[succFill[f]++] = m
    const t = movementTo[m]
    if (t >= 0) predList[predFill[t]++] = m
  }

  const nodeMovList = new Int32Array(nMov)
  for (let m = 0; m < nMov; m++) nodeMovList[m] = m

  return {
    network, edgeIds, edgeOf, nodeIds, nodeOf,
    length, speed, freeTime, lanes, closed, edgeFromNode, edgeToNode, boundary,
    movements, movementFrom, movementTo, movementNode, movementOf,
    succStart, succList, predStart, predList, nodeMovStart, nodeMovList,
    outStart, outList, inStart, inList,
  }
}

/* ----------------------------- Tas binaire ----------------------------- */

/** Tas min sur des couples (clé flottante, valeur entière), sans allocation par opération. */
class MinHeap {
  private keys: Float64Array
  private vals: Int32Array
  private n = 0
  /** Clé du dernier élément extrait. */
  lastKey = 0

  constructor(capacity = 64) {
    this.keys = new Float64Array(Math.max(4, capacity))
    this.vals = new Int32Array(Math.max(4, capacity))
  }

  get size(): number { return this.n }
  clear(): void { this.n = 0 }

  push(key: number, val: number): void {
    if (this.n === this.keys.length) {
      const k = new Float64Array(this.n * 2)
      const v = new Int32Array(this.n * 2)
      k.set(this.keys); v.set(this.vals)
      this.keys = k; this.vals = v
    }
    let i = this.n++
    this.keys[i] = key
    this.vals[i] = val
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.keys[p] <= this.keys[i]) break
      this.swap(p, i)
      i = p
    }
  }

  pop(): number {
    const val = this.vals[0]
    this.lastKey = this.keys[0]
    this.n--
    if (this.n > 0) {
      this.keys[0] = this.keys[this.n]
      this.vals[0] = this.vals[this.n]
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let s = i
        if (l < this.n && this.keys[l] < this.keys[s]) s = l
        if (r < this.n && this.keys[r] < this.keys[s]) s = r
        if (s === i) break
        this.swap(s, i)
        i = s
      }
    }
    return val
  }

  private swap(a: number, b: number): void {
    const k = this.keys[a]; this.keys[a] = this.keys[b]; this.keys[b] = k
    const v = this.vals[a]; this.vals[a] = this.vals[b]; this.vals[b] = v
  }
}

/* ----------------------------- Itinéraires ----------------------------- */

export interface RouteResult {
  /** Indices de tronçons, du premier au dernier. */
  route: Int32Array
  /** Indices de mouvements entre tronçons consécutifs (longueur = route.length − 1). */
  moves: Int32Array
}

/**
 * Calcul des itinéraires sur le graphe de tronçons.
 * Coût courant = temps libre, ou EMA des temps mesurés en routage dynamique (`setCosts`).
 */
export class Router {
  private cost: Float64Array
  private readonly exitTables = new Map<NodeId, Float64Array>()
  private readonly routeCache = new Map<string, RouteResult | null>()
  private readonly heap = new MinHeap(256)
  // Tampons réutilisés du Dijkstra direct (marquage par estampille : pas de remise à zéro).
  private readonly fDist: Float64Array
  private readonly fPar: Int32Array
  private readonly fMark: Int32Array
  private stamp = 0

  constructor(private readonly g: EngineGraph) {
    this.cost = g.freeTime.slice()
    this.fDist = new Float64Array(g.edgeIds.length)
    this.fPar = new Int32Array(g.edgeIds.length)
    this.fMark = new Int32Array(g.edgeIds.length)
  }

  /** Remplace les coûts (routage dynamique) et vide les tables et le cache d'itinéraires. */
  setCosts(cost: Float64Array): void {
    this.cost = cost
    this.exitTables.clear()
    this.routeCache.clear()
  }

  /** `costToGo[e]` : temps minimal entre l'entrée sur `e` et le nœud de sortie (traversée de `e` comprise). */
  costToGo(exitId: NodeId): Float64Array {
    const cached = this.exitTables.get(exitId)
    if (cached) return cached
    const g = this.g
    const n = g.edgeIds.length
    const dist = new Float64Array(n).fill(Infinity)
    const nodeIdx = g.nodeOf.get(exitId)
    if (nodeIdx !== undefined) {
      const heap = this.heap
      heap.clear()
      for (let k = g.inStart[nodeIdx]; k < g.inStart[nodeIdx + 1]; k++) {
        const e = g.inList[k]
        if (g.closed[e]) continue
        dist[e] = this.cost[e]
        heap.push(dist[e], e)
      }
      while (heap.size > 0) {
        const e = heap.pop()
        const d = heap.lastKey
        if (d > dist[e]) continue
        for (let k = g.predStart[e]; k < g.predStart[e + 1]; k++) {
          const p = g.movementFrom[g.predList[k]]
          if (p < 0 || g.closed[p]) continue
          const nd = this.cost[p] + d
          if (nd < dist[p]) {
            dist[p] = nd
            heap.push(nd, p)
          }
        }
      }
    }
    this.exitTables.set(exitId, dist)
    return dist
  }

  /** Meilleur tronçon de départ parmi les sorties d'un nœud d'entrée, puis descente gloutonne. */
  routeFromNodeToExit(nodeIdx: number, exitId: NodeId): RouteResult | null {
    const g = this.g
    const table = this.costToGo(exitId)
    let best = -1
    let bestValue = Infinity
    for (let k = g.outStart[nodeIdx]; k < g.outStart[nodeIdx + 1]; k++) {
      const e = g.outList[k]
      if (g.closed[e]) continue
      if (table[e] < bestValue) { bestValue = table[e]; best = e }
    }
    if (best < 0 || !Number.isFinite(bestValue)) return null
    return this.descend(best, table, exitId)
  }

  routeToExit(startEdge: number, exitId: NodeId): RouteResult | null {
    const table = this.costToGo(exitId)
    if (!Number.isFinite(table[startEdge])) return null
    return this.descend(startEdge, table, exitId)
  }

  /** Descente gloutonne : à chaque pas, le successeur de moindre `costToGo`. */
  private descend(start: number, table: Float64Array, exitId: NodeId): RouteResult | null {
    const g = this.g
    const exitNode = g.nodeOf.get(exitId)
    if (exitNode === undefined) return null
    const route: number[] = [start]
    const moves: number[] = []
    let cur = start
    let guard = g.edgeIds.length + 2
    while (g.edgeToNode[cur] !== exitNode) {
      if (guard-- <= 0) return null
      let best = -1
      let bestValue = Infinity
      for (let k = g.succStart[cur]; k < g.succStart[cur + 1]; k++) {
        const mv = g.succList[k]
        const nx = g.movementTo[mv]
        if (nx < 0) continue
        if (table[nx] < bestValue) { bestValue = table[nx]; best = mv }
      }
      if (best < 0 || !Number.isFinite(bestValue)) return null
      moves.push(best)
      cur = g.movementTo[best]
      route.push(cur)
    }
    return { route: Int32Array.from(route), moves: Int32Array.from(moves) }
  }

  /** Itinéraire vers un tronçon de destination (trajet interne), avec cache (origine, destination). */
  routeToEdge(startEdge: number, destEdge: number): RouteResult | null {
    const key = `e${startEdge}|${destEdge}`
    const hit = this.routeCache.get(key)
    if (hit !== undefined) return hit
    const r = startEdge === destEdge
      ? { route: Int32Array.of(startEdge), moves: new Int32Array(0) }
      : this.forward([startEdge], destEdge)
    this.routeCache.set(key, r)
    return r
  }

  /** Itinéraire d'un nœud d'entrée vers un tronçon de destination. */
  routeFromNodeToEdge(nodeIdx: number, destEdge: number): RouteResult | null {
    const key = `n${nodeIdx}|${destEdge}`
    const hit = this.routeCache.get(key)
    if (hit !== undefined) return hit
    const g = this.g
    const sources: number[] = []
    for (let k = g.outStart[nodeIdx]; k < g.outStart[nodeIdx + 1]; k++) {
      const e = g.outList[k]
      if (!g.closed[e]) sources.push(e)
    }
    const r = sources.includes(destEdge)
      ? { route: Int32Array.of(destEdge), moves: new Int32Array(0) }
      : this.forward(sources, destEdge)
    this.routeCache.set(key, r)
    return r
  }

  /** Dijkstra direct à cible unique (arrêt dès que la cible est extraite). */
  private forward(sources: number[], dest: number): RouteResult | null {
    const g = this.g
    const stamp = ++this.stamp
    const dist = this.fDist
    const par = this.fPar
    const mark = this.fMark
    const heap = this.heap
    heap.clear()
    for (const s of sources) {
      if (g.closed[s]) continue
      mark[s] = stamp
      dist[s] = this.cost[s]
      par[s] = -1
      heap.push(dist[s], s)
    }
    let reached = false
    while (heap.size > 0) {
      const e = heap.pop()
      const d = heap.lastKey
      if (d > dist[e]) continue
      if (e === dest) { reached = true; break }
      for (let k = g.succStart[e]; k < g.succStart[e + 1]; k++) {
        const mv = g.succList[k]
        const nx = g.movementTo[mv]
        if (nx < 0 || g.closed[nx]) continue
        const nd = d + this.cost[nx]
        if (mark[nx] !== stamp || nd < dist[nx]) {
          mark[nx] = stamp
          dist[nx] = nd
          par[nx] = mv
          heap.push(nd, nx)
        }
      }
    }
    if (!reached) return null
    const route: number[] = []
    const moves: number[] = []
    let cur = dest
    for (;;) {
      route.push(cur)
      const mv = par[cur]
      if (mv < 0) break
      moves.push(mv)
      cur = g.movementFrom[mv]
    }
    route.reverse()
    moves.reverse()
    return { route: Int32Array.from(route), moves: Int32Array.from(moves) }
  }
}

/**
 * Plus court chemin en nœuds sur les temps de parcours libres (onde verte, ajout de tronçon).
 * Un nœud frontière n'est jamais traversé : il ne peut être qu'origine ou destination.
 * Renvoie `[]` si aucun chemin n'existe.
 */
export function shortestPathNodes(network: Network, from: NodeId, to: NodeId): NodeId[] {
  if (!network.nodes[from] || !network.nodes[to]) return []
  if (from === to) return [from]
  const adjacency = buildAdjacency(network)
  const dist = new Map<NodeId, number>([[from, 0]])
  const parent = new Map<NodeId, NodeId>()
  const settled = new Set<NodeId>()
  // File de priorité simple (tableau trié à l'insertion) : usage ponctuel, hors boucle de simulation.
  const queue: { d: number; id: NodeId }[] = [{ d: 0, id: from }]
  while (queue.length) {
    let bi = 0
    for (let i = 1; i < queue.length; i++) if (queue[i].d < queue[bi].d) bi = i
    const cur = queue.splice(bi, 1)[0]
    if (settled.has(cur.id)) continue
    settled.add(cur.id)
    if (cur.id === to) break
    // On ne traverse pas un nœud frontière (sauf s'il est l'origine).
    if (cur.id !== from && network.nodes[cur.id].boundary) continue
    for (const e of adjacency.outgoing.get(cur.id) ?? []) {
      if (e.closed) continue
      const speed = (Math.max(MIN_SPEED_KMH, e.maxspeed) * 1000) / 3600
      const nd = cur.d + Math.max(0.1, e.length) / speed
      const known = dist.get(e.to)
      if (known === undefined || nd < known) {
        dist.set(e.to, nd)
        parent.set(e.to, cur.id)
        queue.push({ d: nd, id: e.to })
      }
    }
  }
  if (!dist.has(to)) return []
  const path: NodeId[] = [to]
  let cur = to
  while (cur !== from) {
    const p = parent.get(cur)
    if (p === undefined) return []
    path.push(p)
    cur = p
  }
  path.reverse()
  return path
}
