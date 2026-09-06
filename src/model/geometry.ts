/**
 * Géométrie des carrefours : angles, classification des tourne-à-gauche/droite, conflits entre mouvements.
 * Repère local : x vers l'est, y vers le nord, angles mathématiques en radians (sens trigonométrique).
 * Circulation à droite : tourner à gauche = sens trigonométrique (delta > 0).
 */
import type { EdgeId, MovementKey, NetEdge, Network, NodeId } from './types'
import { movementKey } from './types'

export const TAU = Math.PI * 2

/** Ramène un angle dans (-π, π]. */
export function normalizeAngle(a: number): number {
  a = a % TAU
  if (a > Math.PI) a -= TAU
  if (a <= -Math.PI) a += TAU
  return a
}

/** Ramène un angle dans [0, 2π). */
export function positiveAngle(a: number): number {
  a = a % TAU
  return a < 0 ? a + TAU : a
}

export function polylineLength(pts: [number, number][]): number {
  let s = 0
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  return s
}

/** Cap du tronçon à son origine (premier segment). */
export function edgeStartBearing(e: NetEdge): number {
  const g = e.geometry
  const p = g[0]
  const q = g.length > 1 ? g[1] : g[0]
  return Math.atan2(q[1] - p[1], q[0] - p[0])
}

/** Cap du tronçon à son extrémité (dernier segment). */
export function edgeEndBearing(e: NetEdge): number {
  const g = e.geometry
  const p = g.length > 1 ? g[g.length - 2] : g[0]
  const q = g[g.length - 1]
  return Math.atan2(q[1] - p[1], q[0] - p[0])
}

/** Distance (m) le long de la polyligne utilisée pour lisser les caps au carrefour (amorces courbes). */
export const BEARING_LOOKAHEAD_M = 20

/**
 * Cap « au loin » : direction du point situé à `dist` m le long de la polyligne depuis son premier point.
 */
export function bearingAlong(pts: [number, number][], dist: number): number {
  const p0 = pts[0]
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
    if (acc >= dist || i === pts.length - 1) return Math.atan2(pts[i][1] - p0[1], pts[i][0] - p0[0])
  }
  return 0
}

/** Cap d'arrivée lissé du tronçon en son nœud `to` (direction de circulation). */
export function arrivalBearing(e: NetEdge): number {
  const rev = [...e.geometry].reverse() as [number, number][]
  return normalizeAngle(bearingAlong(rev, BEARING_LOOKAHEAD_M) + Math.PI)
}

/** Cap de départ lissé du tronçon depuis son nœud `from`. */
export function departureBearing(e: NetEdge): number {
  return bearingAlong(e.geometry, BEARING_LOOKAHEAD_M)
}

/** Décalage angulaire (rad) séparant la voie d'approche de la voie de sortie d'une même rue (circulation à droite). */
export const LANE_SIDE_EPSILON = (5 * Math.PI) / 180

/** Angle de position de l'approche (où se trouve la voie d'où arrive le véhicule, vue du nœud). */
export function approachAngle(e: NetEdge): number {
  return positiveAngle(arrivalBearing(e) + Math.PI + LANE_SIDE_EPSILON)
}

/** Angle de position de la sortie (où se trouve la voie que rejoint le véhicule, vue du nœud). */
export function exitAngle(e: NetEdge): number {
  return positiveAngle(departureBearing(e) - LANE_SIDE_EPSILON)
}

export type TurnType = 'through' | 'left' | 'right' | 'uturn'

/** Classe le mouvement inEdge → outEdge d'après le changement de cap (caps lissés sur 20 m). */
export function turnType(inEdge: NetEdge, outEdge: NetEdge): TurnType {
  const delta = normalizeAngle(departureBearing(outEdge) - arrivalBearing(inEdge))
  const deg = (delta * 180) / Math.PI
  if (Math.abs(deg) <= 30) return 'through'
  if (Math.abs(deg) >= 150) return 'uturn'
  return deg > 0 ? 'left' : 'right'
}

/** Tolérance (rad) sous laquelle deux approches sont considérées opposées (cohérent avec le seuil 150° de turnType). */
export const OPPOSITE_TOLERANCE = Math.PI / 6

export type RelativeSide = 'right' | 'left' | 'opposite'

/** Position de l'approche `b` vue de l'approche `a` (angles de position vus du nœud). */
export function relativeSide(angleA: number, angleB: number): RelativeSide {
  const d = positiveAngle(angleB - angleA)
  if (Math.abs(d - Math.PI) <= OPPOSITE_TOLERANCE) return 'opposite'
  return d < Math.PI ? 'right' : 'left'
}

/** `b` est-il à droite de `a` ? */
export function isOnRight(angleA: number, angleB: number): boolean {
  return relativeSide(angleA, angleB) === 'right'
}

/** `b` est-il à gauche de `a` ? */
export function isOnLeft(angleA: number, angleB: number): boolean {
  return relativeSide(angleA, angleB) === 'left'
}

/** `x` est-il strictement dans l'arc trigonométrique allant de `from` à `to` ? */
export function inArcCCW(from: number, to: number, x: number): boolean {
  const span = positiveAngle(to - from)
  const off = positiveAngle(x - from)
  return off > 1e-9 && off < span - 1e-9
}

export interface Movement {
  key: MovementKey
  from: EdgeId
  to: EdgeId
  turn: TurnType
  /** Angle de position de l'approche. */
  inAngle: number
  /** Angle de position de la sortie. */
  outAngle: number
}

/**
 * Deux mouvements sont en conflit s'ils convergent sur la même sortie ou si leurs cordes se croisent
 * (test d'entrelacement des extrémités sur le cercle du carrefour). Même approche = jamais en conflit.
 */
export function movementsConflict(a: Movement, b: Movement): boolean {
  if (a.from === b.from) return false
  if (a.to === b.to) return true
  const bInside = inArcCCW(a.inAngle, a.outAngle, b.inAngle)
  const bOutInside = inArcCCW(a.inAngle, a.outAngle, b.outAngle)
  return bInside !== bOutInside
}

/**
 * Mini-giratoire (anneau virtuel parcouru dans le sens trigonométrique) : le mouvement `n` circule-t-il
 * devant l'entrée de `m` ? Si oui, `m` doit lui céder le passage.
 */
export function passesEntry(n: Movement, m: Movement): boolean {
  if (n.from === m.from) return false
  return inArcCCW(n.inAngle, n.outAngle, m.inAngle)
}

/* ----------------------------- Adjacence ----------------------------- */

export interface Adjacency {
  incoming: Map<NodeId, NetEdge[]>
  outgoing: Map<NodeId, NetEdge[]>
}

/** Index d'adjacence en un seul passage. À mémoïser sur l'identité de `network` (nouvelle identité à chaque modification). */
export function buildAdjacency(network: Network): Adjacency {
  const incoming = new Map<NodeId, NetEdge[]>()
  const outgoing = new Map<NodeId, NetEdge[]>()
  for (const e of Object.values(network.edges)) {
    let i = incoming.get(e.to)
    if (!i) incoming.set(e.to, (i = []))
    i.push(e)
    let o = outgoing.get(e.from)
    if (!o) outgoing.set(e.from, (o = []))
    o.push(e)
  }
  return { incoming, outgoing }
}

export function incomingEdges(network: Network, nodeId: NodeId): NetEdge[] {
  const r: NetEdge[] = []
  for (const e of Object.values(network.edges)) if (e.to === nodeId) r.push(e)
  return r
}

export function outgoingEdges(network: Network, nodeId: NodeId): NetEdge[] {
  const r: NetEdge[] = []
  for (const e of Object.values(network.edges)) if (e.from === nodeId) r.push(e)
  return r
}

/**
 * Mouvements possibles à un nœud : produit approches × sorties, hors tronçons fermés,
 * hors demi-tour (sauf impasse intérieure : une seule approche et une seule sortie) et hors interdictions de tourner.
 * Un nœud frontière n'a AUCUN mouvement : on ne traverse pas la frontière (entrée ou sortie seulement).
 * Les paramètres `incoming`/`outgoing` évitent le balayage du réseau (voir `buildAdjacency`).
 */
export function nodeMovements(
  network: Network,
  nodeId: NodeId,
  incoming?: NetEdge[],
  outgoing?: NetEdge[],
): Movement[] {
  const node = network.nodes[nodeId]
  if (!node || node.boundary) return []
  const ins = (incoming ?? incomingEdges(network, nodeId)).filter((e) => !e.closed)
  const outs = (outgoing ?? outgoingEdges(network, nodeId)).filter((e) => !e.closed)
  const deadEnd = ins.length === 1 && outs.length === 1
  const res: Movement[] = []
  for (const i of ins) {
    for (const o of outs) {
      const isUturn = o.id === i.reverseOf || i.id === o.reverseOf
      if (isUturn && !deadEnd) continue
      if (i.bannedTo.includes(o.id)) continue
      res.push({
        key: movementKey(i.id, o.id),
        from: i.id,
        to: o.id,
        turn: isUturn ? 'uturn' : turnType(i, o),
        inAngle: approachAngle(i),
        outAngle: exitAngle(o),
      })
    }
  }
  return res
}
