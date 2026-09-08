/**
 * Opérations pures sur le réseau (§6 de docs/ARCHITECTURE.md).
 *
 * Toutes les fonctions renvoient un nouveau `Network` (ou l'objet reçu si rien ne change) et **préservent
 * l'identité des objets non modifiés** : le rendu canvas mémoïse ses caches sur l'identité des `NetEdge`,
 * et le store en tire des patches immer minimaux.
 */
import type { ControllerId, EdgeId, GreenKind, HighwayClass, MovementKey, NetEdge, NetNode, Network, NodeControl, NodeId, SignalController, SignalPhase } from '@/model/types'
import { parseMovementKey } from '@/model/types'
import { polylineLength } from '@/model/geometry'

/** Coordonnées arrondies au centimètre (invariant du modèle). */
export function roundCm(v: number): number {
  return Math.round(v * 100) / 100
}

/* ------------------------------------------------------------------ */
/*  Validité topologique                                               */
/* ------------------------------------------------------------------ */

/**
 * Rétablit la validité topologique après une modification :
 *  - tronçons dont une extrémité a disparu supprimés ;
 *  - `bannedTo[i]` conservé seulement si `edges[bannedTo[i]].from === edge.to` ;
 *  - `reverseOf` non symétrique effacé ;
 *  - clé de phase `a>b` conservée seulement si les deux tronçons existent, s'enchaînent, et si le nœud
 *    de jonction appartient au contrôleur ;
 *  - `controller.nodeIds` purgé des nœuds disparus, contrôleur sans nœud supprimé ;
 *  - `controls` purgé des nœuds disparus, des `yieldEdges` disparus et des feux sans contrôleur.
 */
export function sanitizeNetwork(network: Network): Network {
  let changed = false

  // 1. Tronçons dont une extrémité n'existe plus.
  const edges: Record<EdgeId, NetEdge> = {}
  for (const e of Object.values(network.edges)) {
    if (!network.nodes[e.from] || !network.nodes[e.to]) { changed = true; continue }
    edges[e.id] = e
  }
  // 2. Références entre tronçons (évaluées sur les survivants).
  for (const e of Object.values(edges)) {
    const bannedTo = e.bannedTo.filter((id) => edges[id] !== undefined && edges[id].from === e.to)
    const revOk = e.reverseOf !== undefined && edges[e.reverseOf] !== undefined
      && edges[e.reverseOf].reverseOf === e.id
    if (bannedTo.length === e.bannedTo.length && (e.reverseOf === undefined || revOk)) continue
    const next: NetEdge = { ...e, bannedTo }
    if (!revOk) delete next.reverseOf
    edges[e.id] = next
    changed = true
  }

  // 3. Contrôleurs : nœuds existants, mouvements de phase valides.
  const controllers: Record<ControllerId, SignalController> = {}
  for (const c of Object.values(network.controllers)) {
    const nodeIds = c.nodeIds.filter((n, i) => network.nodes[n] !== undefined && c.nodeIds.indexOf(n) === i)
    if (!nodeIds.length) { changed = true; continue }
    const inside = new Set(nodeIds)
    let dirty = nodeIds.length !== c.nodeIds.length
    const phases: SignalPhase[] = c.phases.map((p) => {
      const movements: Record<MovementKey, GreenKind> = {}
      let dropped = false
      for (const [key, kind] of Object.entries(p.movements)) {
        const { from, to } = parseMovementKey(key)
        const a = edges[from]
        const b = edges[to]
        if (a && b && a.to === b.from && inside.has(a.to)) movements[key] = kind
        else dropped = true
      }
      if (!dropped) return p
      dirty = true
      return { ...p, movements }
    })
    if (!dirty) { controllers[c.id] = c; continue }
    controllers[c.id] = { ...c, nodeIds, phases }
    changed = true
  }

  // 4. Régulations.
  const controls: Record<NodeId, NodeControl> = {}
  for (const [nodeId, ctrl] of Object.entries(network.controls)) {
    if (!network.nodes[nodeId]) { changed = true; continue }
    if (ctrl.type === 'signals' && (!ctrl.controllerId || !controllers[ctrl.controllerId])) { changed = true; continue }
    if (ctrl.yieldEdges) {
      const kept = ctrl.yieldEdges.filter((id) => edges[id] !== undefined)
      if (kept.length !== ctrl.yieldEdges.length) {
        controls[nodeId] = { ...ctrl, yieldEdges: kept }
        changed = true
        continue
      }
    }
    controls[nodeId] = ctrl
  }

  if (!changed) return network
  return { nodes: network.nodes, edges, controls, controllers }
}

/* ------------------------------------------------------------------ */
/*  Nœuds                                                              */
/* ------------------------------------------------------------------ */

/**
 * Prochain identifiant de nœud créé par l'éditeur : `x{max + 1}`, même convention que `nextEdgeId`.
 *
 * Le préfixe `x` ne peut pas entrer en collision avec les nœuds venus d'OpenStreetMap, tous nommés
 * `n{osmId}` : un nœud posé à la main reste donc reconnaissable, et un réimport ne le recouvre pas.
 */
export function nextNodeId(network: Network): NodeId {
  let max = 0
  for (const id of Object.keys(network.nodes)) {
    const m = /^x(\d+)$/.exec(id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `x${max + 1}`
}

/**
 * Pose un nœud isolé aux coordonnées locales indiquées (en mètres, arrondies au centimètre).
 *
 * Il naît sans tronçon : il ne sert à rien tant qu'une voie n'y aboutit pas, mais il survit à
 * `sanitizeNetwork` et n'est ni une entrée ni une sortie (`boundary` faux), donc il ne pèse ni sur la
 * demande ni sur la simulation. C'est l'unique moyen de raccorder une voie nouvelle ailleurs qu'aux
 * points fournis par OpenStreetMap.
 */
export function addNode(network: Network, x: number, y: number, label?: string): Network {
  // Une coordonnée non finie produirait un nœud indessinable et refusé au rechargement du projet.
  if (!Number.isFinite(x) || !Number.isFinite(y)) return network
  const id = nextNodeId(network)
  const node: NetNode = { id, x: roundCm(x), y: roundCm(y), boundary: false }
  const trimmed = label?.trim()
  if (trimmed) node.label = trimmed
  return { ...network, nodes: { ...network.nodes, [id]: node } }
}

/** Déplace un nœud : coordonnées arrondies au centimètre, extrémités et longueurs des tronçons incidents mises à jour. */
export function moveNode(network: Network, id: NodeId, x: number, y: number): Network {
  const node = network.nodes[id]
  if (!node) return network
  const nx = roundCm(x)
  const ny = roundCm(y)
  if (node.x === nx && node.y === ny) return network
  const nodes = { ...network.nodes, [id]: { ...node, x: nx, y: ny } }
  const edges = { ...network.edges }
  for (const e of Object.values(network.edges)) {
    if (e.from !== id && e.to !== id) continue
    const geometry = e.geometry.map((p) => [p[0], p[1]] as [number, number])
    if (e.from === id) geometry[0] = [nx, ny]
    if (e.to === id) geometry[geometry.length - 1] = [nx, ny]
    edges[e.id] = { ...e, geometry, length: polylineLength(geometry) }
  }
  return { ...network, nodes, edges }
}

/**
 * Fusionne `sourceId` dans `targetId` : les tronçons de la source sont rebranchés sur la cible, les tronçons
 * devenus des boucles sont supprimés, les doublons `from/to` fusionnés (le plus court est conservé).
 * La cible conserve ses propres attributs (position, `boundary`, mini-giratoire).
 */
export function mergeNodes(network: Network, sourceId: NodeId, targetId: NodeId): Network {
  const source = network.nodes[sourceId]
  const target = network.nodes[targetId]
  if (!source || !target || sourceId === targetId) return network

  const nodes = { ...network.nodes }
  delete nodes[sourceId]

  // Rebranchement.
  const rebranched: NetEdge[] = []
  for (const e of Object.values(network.edges)) {
    const from = e.from === sourceId ? targetId : e.from
    const to = e.to === sourceId ? targetId : e.to
    if (from === e.from && to === e.to) { rebranched.push(e); continue }
    if (from === to && e.from !== e.to) continue // tronçon replié sur lui-même par la fusion
    const geometry = e.geometry.map((p) => [p[0], p[1]] as [number, number])
    if (from !== e.from) geometry[0] = [target.x, target.y]
    if (to !== e.to) geometry[geometry.length - 1] = [target.x, target.y]
    rebranched.push({ ...e, from, to, geometry, length: polylineLength(geometry) })
  }

  // Doublons : un seul tronçon par couple (from, to), le plus court.
  const byPair = new Map<string, NetEdge>()
  for (const e of rebranched) {
    const key = `${e.from}>${e.to}`
    const kept = byPair.get(key)
    if (!kept || e.length < kept.length) byPair.set(key, e)
  }
  const edges: Record<EdgeId, NetEdge> = {}
  for (const e of byPair.values()) edges[e.id] = e

  // Régulations : la cible garde la sienne ; sinon celle de la source la suit (approches cumulées si même type).
  const controls = { ...network.controls }
  const sourceControl = controls[sourceId]
  delete controls[sourceId]
  if (sourceControl) {
    const existing = controls[targetId]
    if (!existing) {
      controls[targetId] = { ...sourceControl, nodeId: targetId }
    } else if (existing.type === sourceControl.type && (existing.yieldEdges || sourceControl.yieldEdges)) {
      controls[targetId] = {
        ...existing,
        yieldEdges: [...new Set([...(existing.yieldEdges ?? []), ...(sourceControl.yieldEdges ?? [])])],
      }
    }
  }

  // Contrôleurs de feux : la source cède sa place à la cible.
  const controllers: Record<ControllerId, SignalController> = {}
  for (const c of Object.values(network.controllers)) {
    if (!c.nodeIds.includes(sourceId)) { controllers[c.id] = c; continue }
    controllers[c.id] = { ...c, nodeIds: [...new Set(c.nodeIds.map((n) => (n === sourceId ? targetId : n)))] }
  }

  return sanitizeNetwork({ nodes, edges, controls, controllers })
}

/** Supprime un nœud et tous les tronçons qui y aboutissent. */
export function deleteNode(network: Network, id: NodeId): Network {
  if (!network.nodes[id]) return network
  const nodes = { ...network.nodes }
  delete nodes[id]
  const edges: Record<EdgeId, NetEdge> = {}
  for (const e of Object.values(network.edges)) if (e.from !== id && e.to !== id) edges[e.id] = e
  return sanitizeNetwork({ ...network, nodes, edges })
}

/* ------------------------------------------------------------------ */
/*  Tronçons                                                           */
/* ------------------------------------------------------------------ */

/** Supprime un tronçon (le sens opposé, s'il existe, subsiste en sens unique). */
export function deleteEdge(network: Network, id: EdgeId): Network {
  if (!network.edges[id]) return network
  const edges = { ...network.edges }
  delete edges[id]
  return sanitizeNetwork({ ...network, edges })
}

/** Prochain identifiant de tronçon créé par l'éditeur : `x{max + 1}`. */
export function nextEdgeId(network: Network): EdgeId {
  let max = 0
  for (const id of Object.keys(network.edges)) {
    const m = /^x(\d+)$/.exec(id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `x${max + 1}`
}

export interface AddEdgeOptions {
  twoWay: boolean
  highway: HighwayClass
  lanes: number
  maxspeed: number
  name?: string
}

function straightEdge(
  network: Network, id: EdgeId, from: NodeId, to: NodeId, opts: AddEdgeOptions,
): NetEdge {
  const a = network.nodes[from]
  const b = network.nodes[to]
  const geometry: [number, number][] = [[a.x, a.y], [b.x, b.y]]
  const edge: NetEdge = {
    id,
    from,
    to,
    highway: opts.highway,
    lanes: Math.max(1, Math.round(opts.lanes)),
    maxspeed: Math.max(1, opts.maxspeed),
    length: polylineLength(geometry),
    geometry,
    roundabout: false,
    closed: false,
    bannedTo: [],
    estimated: { lanes: false, maxspeed: false },
  }
  if (opts.name) edge.name = opts.name
  return edge
}

/** Ajoute un tronçon rectiligne entre deux nœuds existants (et son opposé si `twoWay`). */
export function addEdge(network: Network, from: NodeId, to: NodeId, opts: AddEdgeOptions): Network {
  if (!network.nodes[from] || !network.nodes[to] || from === to) return network
  const id = nextEdgeId(network)
  const forward = straightEdge(network, id, from, to, opts)
  const edges = { ...network.edges, [id]: forward }
  if (opts.twoWay) {
    const backId = edges[`${id}r`] ? nextEdgeId({ ...network, edges }) : `${id}r`
    const back = straightEdge(network, backId, to, from, opts)
    back.reverseOf = id
    forward.reverseOf = backId
    edges[backId] = back
  }
  return { ...network, edges }
}

/**
 * Change le sens d'un tronçon :
 *  - `oneway` : supprime le tronçon opposé ;
 *  - `reverse` : échange `from`/`to`, inverse la géométrie, supprime l'opposé et vide les interdictions de tourner ;
 *  - `twoway` : crée le tronçon opposé (`{id}r` si libre, sinon `x{k}`).
 */
export function setEdgeDirection(network: Network, id: EdgeId, mode: 'oneway' | 'reverse' | 'twoway'): Network {
  const edge = network.edges[id]
  if (!edge) return network
  const edges = { ...network.edges }

  if (mode === 'twoway') {
    if (edge.reverseOf && edges[edge.reverseOf]) return network
    const backId = edges[`${id}r`] ? nextEdgeId(network) : `${id}r`
    const geometry = [...edge.geometry].reverse().map((p) => [p[0], p[1]] as [number, number])
    edges[backId] = {
      ...edge,
      id: backId,
      from: edge.to,
      to: edge.from,
      geometry,
      length: polylineLength(geometry),
      bannedTo: [],
      reverseOf: id,
    }
    edges[id] = { ...edge, reverseOf: backId }
    return sanitizeNetwork({ ...network, edges })
  }

  if (edge.reverseOf && edges[edge.reverseOf]) delete edges[edge.reverseOf]

  if (mode === 'oneway') {
    const next: NetEdge = { ...edge }
    delete next.reverseOf
    edges[id] = next
  } else {
    const geometry = [...edge.geometry].reverse().map((p) => [p[0], p[1]] as [number, number])
    const next: NetEdge = {
      ...edge,
      from: edge.to,
      to: edge.from,
      geometry,
      length: polylineLength(geometry),
      // Les interdictions de tourner portaient sur l'ancien nœud aval : elles n'ont plus de sens.
      bannedTo: [],
    }
    delete next.reverseOf
    edges[id] = next
  }
  return sanitizeNetwork({ ...network, edges })
}

/** Interdit (ou rétablit) le mouvement `from` → `to` au nœud aval de `from`. */
export function setBannedTurn(network: Network, from: EdgeId, to: EdgeId, banned: boolean): Network {
  const edge = network.edges[from]
  if (!edge) return network
  const has = edge.bannedTo.includes(to)
  if (has === banned) return network
  const bannedTo = banned ? [...edge.bannedTo, to] : edge.bannedTo.filter((e) => e !== to)
  return sanitizeNetwork({ ...network, edges: { ...network.edges, [from]: { ...edge, bannedTo } } })
}
