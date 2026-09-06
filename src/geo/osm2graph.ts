/**
 * Conversion d'un extrait OSM en graphe de simulation (voir docs/ARCHITECTURE.md §4).
 *
 * Le traitement est synchrone et volontairement « index d'abord » : tous les parcours sont linéaires
 * (indexation par nœud OSM, par way, grille pour le regroupement des feux) afin de tenir la cible
 * de moins d'une seconde pour 5 000 ways.
 */
import type {
  EdgeId, GeoMultiPolygon, GeoPolygon, HighwayClass, NetEdge, NetNode, Network, NodeId,
} from '@/model/types'
import { HIGHWAY_CLASSES } from '@/model/types'
import { DEFAULT_LANES, DEFAULT_MAXSPEED, SIGNAL_CLUSTER_DISTANCE_M } from '@/model/defaults'
import { buildAdjacency, polylineLength, turnType } from '@/model/geometry'
import { createDefaultSignalPlan } from '@/model/signals'
import { createProjection } from './projection'
import type { ImportResult, ImportStats, OsmExtract, OsmNode, OsmRelation, OsmWay } from './types'

/* ------------------------------------------------------------------ */
/*  Constantes                                                         */
/* ------------------------------------------------------------------ */

const HIGHWAY_SET = new Set<string>(HIGHWAY_CLASSES)

/** Distance maximale de rattachement d'un stop / cédez-le-passage au carrefour suivant (m). */
const STOP_ATTACH_DISTANCE_M = 40

/** Longueur en deçà de laquelle un segment est considéré dégénéré (m). */
const MIN_EDGE_LENGTH_M = 0.01

/** Un feu sur un nœud de moins de 3 branches est un feu de passage piéton : il n'est pas simulé. */
const MIN_SIGNAL_BRANCHES = 3

const ONEWAY_FORWARD = new Set(['yes', 'true', '1'])
const ONEWAY_BACKWARD = new Set(['-1', 'reverse'])

/* ------------------------------------------------------------------ */
/*  Point dans polygone (contour communal)                             */
/* ------------------------------------------------------------------ */

/**
 * Anneau indexé par tranches de latitude : le lancer de rayon ne teste que les côtés dont
 * l'étendue en latitude recoupe celle du point, ce qui évite un balayage complet du contour
 * pour chacune des dizaines de milliers de nœuds de l'extrait.
 */
class RingIndex {
  private readonly xs: Float64Array
  private readonly ys: Float64Array
  private readonly buckets: Int32Array[]
  private readonly minY: number
  private readonly maxY: number
  private readonly minX: number
  private readonly maxX: number
  private readonly scale: number

  constructor(ring: [number, number][]) {
    const n = ring.length
    this.xs = new Float64Array(n)
    this.ys = new Float64Array(n)
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (let i = 0; i < n; i++) {
      const [x, y] = ring[i]
      this.xs[i] = x
      this.ys[i] = y
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    this.minX = minX
    this.maxX = maxX
    this.minY = minY
    this.maxY = maxY

    const bucketCount = Math.max(1, Math.min(1024, n >> 2))
    this.scale = maxY > minY ? bucketCount / (maxY - minY) : 0
    const lists: number[][] = Array.from({ length: bucketCount }, () => [])
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = this.ys[i]
      const b = this.ys[j]
      const lo = this.bucketOf(Math.min(a, b), bucketCount)
      const hi = this.bucketOf(Math.max(a, b), bucketCount)
      for (let k = lo; k <= hi; k++) lists[k].push(i)
    }
    this.buckets = lists.map((l) => Int32Array.from(l))
  }

  private bucketOf(y: number, count: number): number {
    const k = Math.floor((y - this.minY) * this.scale)
    return k < 0 ? 0 : k >= count ? count - 1 : k
  }

  contains(x: number, y: number): boolean {
    if (x < this.minX || x > this.maxX || y < this.minY || y > this.maxY) return false
    const bucket = this.buckets[this.bucketOf(y, this.buckets.length)]
    const { xs, ys } = this
    const n = xs.length
    let inside = false
    for (let b = 0; b < bucket.length; b++) {
      const i = bucket[b]
      const j = i === 0 ? n - 1 : i - 1
      const yi = ys[i]
      const yj = ys[j]
      if (yi > y !== yj > y) {
        const xi = xs[i]
        if (x < ((xs[j] - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
      }
    }
    return inside
  }
}

/** Test « le point (lon, lat) est-il dans le contour ? », trous respectés. */
export function createContourTest(contour: GeoPolygon | GeoMultiPolygon | undefined): (lon: number, lat: number) => boolean {
  if (!contour?.coordinates?.length) return () => true
  const polygons: { outer: RingIndex; holes: RingIndex[] }[] = []
  const rawPolygons: [number, number][][][] =
    contour.type === 'MultiPolygon' ? contour.coordinates : [contour.coordinates]
  for (const rings of rawPolygons) {
    if (!rings?.length || rings[0].length < 3) continue
    polygons.push({ outer: new RingIndex(rings[0]), holes: rings.slice(1).filter((r) => r.length >= 3).map((r) => new RingIndex(r)) })
  }
  if (!polygons.length) return () => true
  return (lon: number, lat: number) => {
    for (const poly of polygons) {
      if (!poly.outer.contains(lon, lat)) continue
      let inHole = false
      for (const hole of poly.holes) {
        if (hole.contains(lon, lat)) {
          inHole = true
          break
        }
      }
      if (!inHole) return true
    }
    return false
  }
}

/* ------------------------------------------------------------------ */
/*  Lecture des tags                                                   */
/* ------------------------------------------------------------------ */

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const m = /^\s*(\d+)\s*$/.exec(value)
  if (!m) return undefined
  const n = Number(m[1])
  return n > 0 ? n : undefined
}

/** Vitesses implicites françaises (valeurs de `maxspeed`, `source:maxspeed`, `zone:maxspeed`, `maxspeed:type`). */
const IMPLICIT_MAXSPEED: Record<string, number> = {
  'fr:urban': 50,
  'fr:rural': 80,
  'fr:zone30': 30,
  'fr:motorway': 130,
  'fr:trunk': 110,
  'fr:living_street': 20,
  walk: 5,
  none: 130,
}

/** Interprète une valeur de vitesse OSM ; renvoie des km/h entiers, ou `undefined` si illisible. */
export function parseMaxspeed(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const v = raw.trim().toLowerCase()
  if (!v) return undefined
  const implicit = IMPLICIT_MAXSPEED[v]
  if (implicit) return implicit
  let m = /^(\d+(?:[.,]\d+)?)\s*mph$/.exec(v)
  if (m) return Math.round(Number(m[1].replace(',', '.')) * 1.609)
  m = /^(\d+(?:[.,]\d+)?)(?:\s*(?:km\/h|kmh|kph))?$/.exec(v)
  if (m) {
    const n = Math.round(Number(m[1].replace(',', '.')))
    return n > 0 ? n : undefined
  }
  m = /^fr:zone:?(\d+)$/.exec(v)
  if (m) return Number(m[1])
  m = /^fr:(\d+)$/.exec(v)
  if (m) return Number(m[1])
  return undefined
}

interface DirectionAttributes {
  lanes: number
  lanesEstimated: boolean
  maxspeed: number
  maxspeedEstimated: boolean
}

/** Tags secondaires portant une vitesse implicite (`FR:zone30`, `FR:urban`…). */
const MAXSPEED_HINT_TAGS = ['zone:maxspeed', 'source:maxspeed', 'maxspeed:type']

function directionAttributes(
  tags: Record<string, string>,
  dir: 'forward' | 'backward',
  twoWay: boolean,
  highway: HighwayClass,
): DirectionAttributes {
  // --- voies
  const own = positiveInt(tags[`lanes:${dir}`])
  const other = positiveInt(tags[dir === 'forward' ? 'lanes:backward' : 'lanes:forward'])
  const total = positiveInt(tags.lanes)
  let lanes: number
  let lanesEstimated = false
  if (own !== undefined) lanes = own
  else if (total !== undefined && !twoWay) lanes = total
  else if (total !== undefined && other !== undefined) lanes = Math.max(1, total - other)
  else if (total !== undefined) lanes = Math.max(1, dir === 'forward' ? Math.ceil(total / 2) : Math.floor(total / 2))
  else {
    lanes = DEFAULT_LANES[highway]
    lanesEstimated = true
  }

  // --- vitesse
  let maxspeed = parseMaxspeed(tags[`maxspeed:${dir}`]) ?? parseMaxspeed(tags.maxspeed)
  let maxspeedEstimated = false
  if (maxspeed === undefined) {
    for (const key of MAXSPEED_HINT_TAGS) {
      maxspeed = parseMaxspeed(tags[`${key}:${dir}`]) ?? parseMaxspeed(tags[key])
      if (maxspeed !== undefined) break
    }
  }
  if (maxspeed === undefined) {
    maxspeed = DEFAULT_MAXSPEED[highway]
    maxspeedEstimated = true
  }
  return { lanes: Math.max(1, lanes), lanesEstimated, maxspeed, maxspeedEstimated }
}

/** Manœuvre attendue par une relation de restriction, pour lever une ambiguïté d'appariement. */
function expectedTurn(kind: string): 'left' | 'right' | 'through' | 'uturn' | undefined {
  if (kind.endsWith('_left_turn')) return 'left'
  if (kind.endsWith('_right_turn')) return 'right'
  if (kind.endsWith('_straight_on')) return 'through'
  if (kind.endsWith('_u_turn')) return 'uturn'
  return undefined
}

/* ------------------------------------------------------------------ */
/*  Structures internes                                                */
/* ------------------------------------------------------------------ */

/** Segment d'une suite entre deux nœuds topologiques consécutifs. */
interface Segment {
  /** Indices dans `Run.nodes`. */
  a: number
  b: number
  forward?: NetEdge
  backward?: NetEdge
}

/** Suite de nœuds intérieurs d'un way (bornée le cas échéant par un nœud frontière). */
interface Run {
  way: OsmWay
  /** Identifiants de nœuds OSM. */
  nodes: number[]
  /** Indices des nœuds topologiques, calculés après le marquage global. */
  topoIdx: number[]
  segments: Segment[]
}

/** Occurrence d'un nœud « intéressant » (feu, stop, cédez-le-passage) dans une suite. */
interface Occurrence {
  run: Run
  idx: number
}

/* ------------------------------------------------------------------ */
/*  Union-find                                                         */
/* ------------------------------------------------------------------ */

class UnionFind<T> {
  private readonly parent = new Map<T, T>()

  find(a: T): T {
    let root = this.parent.get(a)
    if (root === undefined) {
      this.parent.set(a, a)
      return a
    }
    while (root !== this.parent.get(root)) root = this.parent.get(root) as T
    // compression de chemin
    let cur = a
    while (cur !== root) {
      const next = this.parent.get(cur) as T
      this.parent.set(cur, root)
      cur = next
    }
    return root
  }

  union(a: T, b: T): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
}

/* ------------------------------------------------------------------ */
/*  Conversion                                                         */
/* ------------------------------------------------------------------ */

export function osm2graph(extract: OsmExtract): ImportResult {
  const warnings: string[] = []
  const commune = extract.commune
  const centre = commune?.centre?.coordinates
  const projection = createProjection({ lon: centre?.[0] ?? 0, lat: centre?.[1] ?? 0 })

  /* --- 0. Indexation des éléments OSM --------------------------------- */
  const osmNodes = new Map<number, OsmNode>()
  const osmWays: OsmWay[] = []
  const relations: OsmRelation[] = []
  /** Nœuds porteurs d'une signalisation ponctuelle : on suit leur position dans les suites. */
  const markers: OsmNode[] = []
  for (const el of extract.osm?.elements ?? []) {
    if (el.type === 'node') {
      osmNodes.set(el.id, el)
      const h = el.tags?.highway
      if (h === 'traffic_signals' || h === 'stop' || h === 'give_way') markers.push(el)
    } else if (el.type === 'way') osmWays.push(el)
    else if (el.type === 'relation') relations.push(el)
  }
  const markerIds = new Set(markers.map((n) => n.id))

  /* --- 1. Projection (mémoïsée) --------------------------------------- */
  const local = new Map<number, [number, number]>()
  // Les nœuds interrogés proviennent tous de ways dont la complétude a été vérifiée : ils existent.
  const localOf = (id: number): [number, number] => {
    let p = local.get(id)
    if (!p) {
      const n = osmNodes.get(id) as OsmNode
      p = projection.toLocal(n.lon, n.lat)
      local.set(id, p)
    }
    return p
  }

  /* --- 2 & 3. Filtrage des ways et découpage au contour ---------------- */
  const inContour = createContourTest(commune?.contour)
  const insideCache = new Map<number, boolean>()
  const isInside = (id: number): boolean => {
    let v = insideCache.get(id)
    if (v === undefined) {
      const n = osmNodes.get(id) as OsmNode
      v = inContour(n.lon, n.lat)
      insideCache.set(id, v)
    }
    return v
  }

  const runs: Run[] = []
  const boundaryNodes = new Set<number>()
  const occurrences = new Map<number, number>()
  const markerPositions = new Map<number, Occurrence[]>()
  let waysRead = 0
  let waysTruncated = 0

  for (const way of osmWays) {
    const tags = way.tags
    const highway = tags?.highway
    if (!highway || !HIGHWAY_SET.has(highway)) continue
    if (tags.area === 'yes') continue
    if ((tags.access === 'no' || tags.access === 'private') && tags.motor_vehicle !== 'yes') continue
    if (!way.nodes || way.nodes.length < 2) continue
    let complete = true
    for (const id of way.nodes) {
      if (!osmNodes.has(id)) {
        complete = false
        break
      }
    }
    if (!complete) {
      waysTruncated++
      continue
    }
    waysRead++

    const count = way.nodes.length
    let i = 0
    while (i < count) {
      if (!isInside(way.nodes[i])) {
        i++
        continue
      }
      let j = i
      while (j + 1 < count && isInside(way.nodes[j + 1])) j++
      // On prolonge la suite d'un nœud extérieur de chaque côté : ce sont les nœuds frontières.
      const start = i > 0 ? i - 1 : i
      const end = j < count - 1 ? j + 1 : j
      if (end > start) {
        if (i > 0) boundaryNodes.add(way.nodes[start])
        if (j < count - 1) boundaryNodes.add(way.nodes[end])
        const run: Run = { way, nodes: way.nodes.slice(start, end + 1), topoIdx: [], segments: [] }
        runs.push(run)
        for (let k = 0; k < run.nodes.length; k++) {
          const id = run.nodes[k]
          occurrences.set(id, (occurrences.get(id) ?? 0) + 1)
          if (markerIds.has(id)) {
            let list = markerPositions.get(id)
            if (!list) markerPositions.set(id, (list = []))
            list.push({ run, idx: k })
          }
        }
      }
      i = j + 1
    }
  }
  if (waysTruncated) {
    warnings.push(`${waysTruncated} way(s) ignoré(s) : certains de leurs nœuds sont absents de l'extrait.`)
  }

  /* --- 4. Nœuds topologiques ------------------------------------------ */
  const topo = new Set<number>()
  for (const run of runs) {
    topo.add(run.nodes[0])
    topo.add(run.nodes[run.nodes.length - 1])
  }
  for (const [id, n] of occurrences) if (n >= 2) topo.add(id)
  for (const id of boundaryNodes) topo.add(id)

  const computeTopoIdx = (run: Run): number[] => {
    const idx: number[] = []
    for (let k = 0; k < run.nodes.length; k++) if (topo.has(run.nodes[k])) idx.push(k)
    return idx
  }
  for (const run of runs) run.topoIdx = computeTopoIdx(run)

  // Aucun segment ne doit boucler sur lui-même (anneau fermé dont seul le point de raccord est partagé) :
  // on le coupe en promouvant son nœud médian.
  for (let pass = 0; pass < 4; pass++) {
    let changed = false
    for (const run of runs) {
      const idx = run.topoIdx
      for (let k = 0; k + 1 < idx.length; k++) {
        const a = idx[k]
        const b = idx[k + 1]
        if (run.nodes[a] !== run.nodes[b]) continue
        const mid = a + ((b - a) >> 1)
        if (mid > a && mid < b) {
          topo.add(run.nodes[mid])
          changed = true
        }
      }
    }
    if (!changed) break
    for (const run of runs) run.topoIdx = computeTopoIdx(run)
  }

  /* --- 5. Tronçons ----------------------------------------------------- */
  const nodes: Record<NodeId, NetNode> = {}
  const edges: Record<EdgeId, NetEdge> = {}
  const edgesByWay = new Map<number, NetEdge[]>()
  const segmentCounter = new Map<number, number>()
  let degenerate = 0

  const ensureNode = (osmId: number): NetNode => {
    const id = `n${osmId}`
    let node = nodes[id]
    if (!node) {
      const [x, y] = localOf(osmId)
      node = { id, x, y, osmId, boundary: boundaryNodes.has(osmId) }
      if (osmNodes.get(osmId)?.tags?.highway === 'mini_roundabout') node.miniRoundabout = true
      nodes[id] = node
    }
    return node
  }

  const registerEdge = (wayId: number, edge: NetEdge): void => {
    edges[edge.id] = edge
    let list = edgesByWay.get(wayId)
    if (!list) edgesByWay.set(wayId, (list = []))
    list.push(edge)
  }

  for (const run of runs) {
    const tags = run.way.tags ?? {}
    const highway = tags.highway as HighwayClass
    const roundabout = tags.junction === 'roundabout' || tags.junction === 'circular'
    const oneway = (tags.oneway ?? '').trim().toLowerCase()
    let forward = true
    let backward = true
    if (ONEWAY_FORWARD.has(oneway)) backward = false
    else if (ONEWAY_BACKWARD.has(oneway)) forward = false
    else if (roundabout || highway === 'motorway' || highway === 'motorway_link') backward = false
    const twoWay = forward && backward
    const fwAttr = directionAttributes(tags, 'forward', twoWay, highway)
    const bwAttr = directionAttributes(tags, 'backward', twoWay, highway)
    const name = tags.name ?? tags.ref

    const build = (
      id: EdgeId,
      from: NodeId,
      to: NodeId,
      geometry: [number, number][],
      length: number,
      attr: DirectionAttributes,
    ): NetEdge => {
      const edge: NetEdge = {
        id,
        from,
        to,
        osmWayId: run.way.id,
        highway,
        lanes: attr.lanes,
        maxspeed: attr.maxspeed,
        length,
        geometry,
        roundabout,
        closed: false,
        bannedTo: [],
        estimated: { lanes: attr.lanesEstimated, maxspeed: attr.maxspeedEstimated },
      }
      if (name) edge.name = name
      return edge
    }

    const idx = run.topoIdx
    for (let k = 0; k + 1 < idx.length; k++) {
      const a = idx[k]
      const b = idx[k + 1]
      const startOsm = run.nodes[a]
      const endOsm = run.nodes[b]
      // Géométrie du segment, doublons consécutifs supprimés (les extrémités restent les nœuds).
      const points: [number, number][] = []
      for (let p = a; p <= b; p++) {
        const [x, y] = localOf(run.nodes[p])
        const last = points[points.length - 1]
        if (last && last[0] === x && last[1] === y) continue
        points.push([x, y])
      }
      const length = polylineLength(points)
      if (startOsm === endOsm || points.length < 2 || length < MIN_EDGE_LENGTH_M) {
        degenerate++
        continue
      }
      const n = segmentCounter.get(run.way.id) ?? 0
      segmentCounter.set(run.way.id, n + 1)
      const baseId = `e${run.way.id}_${n}`
      const nodeA = ensureNode(startOsm)
      const nodeB = ensureNode(endOsm)
      const segment: Segment = { a, b }

      if (forward) {
        segment.forward = build(baseId, nodeA.id, nodeB.id, points, length, fwAttr)
        registerEdge(run.way.id, segment.forward)
      }
      if (backward) {
        const reversed = [...points].reverse() as [number, number][]
        segment.backward = build(forward ? `${baseId}r` : baseId, nodeB.id, nodeA.id, reversed, length, bwAttr)
        registerEdge(run.way.id, segment.backward)
      }
      if (segment.forward && segment.backward) {
        segment.forward.reverseOf = segment.backward.id
        segment.backward.reverseOf = segment.forward.id
      }
      run.segments.push(segment)
    }
  }
  if (degenerate) {
    warnings.push(`${degenerate} segment(s) de longueur nulle ignoré(s) (nœuds OSM confondus).`)
  }

  /* --- 6. Composantes connexes ---------------------------------------- */
  let droppedEdges = 0
  const components = new UnionFind<NodeId>()
  for (const id of Object.keys(nodes)) components.find(id)
  for (const edge of Object.values(edges)) components.union(edge.from, edge.to)
  const keptRoots = new Set<NodeId>()
  for (const node of Object.values(nodes)) if (node.boundary) keptRoots.add(components.find(node.id))
  if (!keptRoots.size) {
    // Extrait sans nœud frontière (contour absent ou réseau entièrement intérieur) : on ne supprime rien.
    if (Object.keys(nodes).length) {
      warnings.push(
        "Aucun nœud frontière détecté : le réseau est conservé intégralement, mais il n'a ni entrée ni sortie.",
      )
    }
  } else {
    for (const edge of Object.values(edges)) {
      if (!keptRoots.has(components.find(edge.from))) {
        delete edges[edge.id]
        droppedEdges++
      }
    }
    for (const node of Object.values(nodes)) {
      if (!keptRoots.has(components.find(node.id))) delete nodes[node.id]
    }
    if (droppedEdges) {
      warnings.push(`${droppedEdges} tronçon(s) isolé(s) supprimé(s) : aucune liaison avec un point d'entrée du réseau.`)
    }
  }
  const alive = (edge: NetEdge | undefined): NetEdge | undefined => (edge && edges[edge.id] ? edge : undefined)

  const network: Network = { nodes, edges, controls: {}, controllers: {} }
  const adjacency = buildAdjacency(network)

  /* --- 7. Interdictions de tourner ------------------------------------ */
  /** Relations d'interdiction traitées (lues et comprises), appliquées ou non. */
  let restrictions = 0
  let restrictionsUnresolved = 0
  let viaWays = 0
  for (const rel of relations) {
    const tags = rel.tags
    if (tags?.type !== 'restriction') continue
    const kind = (tags.restriction ?? tags['restriction:motorcar'] ?? '').trim().toLowerCase()
    if (!kind) continue
    const only = kind.startsWith('only_')
    if (!only && !kind.startsWith('no_')) continue
    const fromMember = rel.members?.find((m) => m.role === 'from')
    const viaMember = rel.members?.find((m) => m.role === 'via')
    const toMember = rel.members?.find((m) => m.role === 'to')
    if (!fromMember || !viaMember || !toMember) continue
    if (viaMember.type === 'way') {
      viaWays++
      continue
    }
    if (viaMember.type !== 'node' || fromMember.type !== 'way' || toMember.type !== 'way') continue
    restrictions++
    const viaId: NodeId = `n${viaMember.ref}`
    const fromCandidates = network.nodes[viaId]
      ? (edgesByWay.get(fromMember.ref) ?? []).filter((e) => edges[e.id] && e.to === viaId)
      : []
    const toCandidates = network.nodes[viaId]
      ? (edgesByWay.get(toMember.ref) ?? []).filter((e) => edges[e.id] && e.from === viaId)
      : []
    if (!fromCandidates.length || !toCandidates.length) {
      // Cas courant : le way « from » ou le carrefour « via » se trouve hors de la commune.
      restrictionsUnresolved++
      continue
    }
    // Le way « from » peut traverser le nœud via : deux approches portent alors le même identifiant OSM.
    // On tranche avec la manœuvre annoncée par la relation.
    let fromEdge = fromCandidates[0]
    let toEdge = toCandidates[0]
    if (fromCandidates.length > 1 || toCandidates.length > 1) {
      const wanted = expectedTurn(kind)
      let bestScore = -1
      for (const f of fromCandidates) {
        for (const t of toCandidates) {
          if (t.id === f.id) continue
          const turn = f.reverseOf === t.id ? 'uturn' : turnType(f, t)
          const score = wanted && turn === wanted ? 2 : 1
          if (score > bestScore) {
            bestScore = score
            fromEdge = f
            toEdge = t
          }
        }
      }
    }
    const ban = (target: EdgeId): void => {
      if (!fromEdge.bannedTo.includes(target)) fromEdge.bannedTo.push(target)
    }
    if (only) {
      // Toutes les autres sorties du nœud via sont interdites depuis cette approche.
      // Le demi-tour reste hors sujet : `nodeMovements()` l'exclut déjà (sauf impasse).
      for (const out of adjacency.outgoing.get(viaId) ?? []) {
        if (out.id === toEdge.id || out.id === fromEdge.reverseOf) continue
        ban(out.id)
      }
    } else {
      ban(toEdge.id)
    }
  }
  if (viaWays) warnings.push(`${viaWays} interdiction(s) de tourner ignorée(s) : le rôle « via » porte sur un way.`)
  if (restrictionsUnresolved) {
    warnings.push(
      `${restrictionsUnresolved} interdiction(s) de tourner non appliquée(s) : carrefour ou voie situé hors de la commune.`,
    )
  }

  /* --- Rattachement d'un nœud OSM à une approche ----------------------- */

  interface Approach {
    controlNode: NodeId
    edge: NetEdge
    distance: number
  }

  /** Distance le long de la suite entre deux indices. */
  const runDistance = (run: Run, from: number, to: number): number => {
    let d = 0
    for (let k = from; k < to; k++) {
      const p = localOf(run.nodes[k])
      const q = localOf(run.nodes[k + 1])
      d += Math.hypot(q[0] - p[0], q[1] - p[1])
    }
    return d
  }

  /**
   * Approches concernées par un nœud de signalisation : le tronçon qui contient ce nœud et le nœud
   * topologique atteint ensuite dans le sens considéré. Sans sens imposé, le carrefour le plus proche
   * l'emporte si l'autre est plus loin ; à égalité, les deux sens sont retenus.
   * `maxDistance` borne le rattachement (toujours pour les feux, seulement en l'absence de sens pour les stops).
   */
  const approachesOf = (osmId: number, direction: 'forward' | 'backward' | undefined, maxDistance: number): Approach[] => {
    const result: Approach[] = []
    for (const { run, idx } of markerPositions.get(osmId) ?? []) {
      const fwSeg = run.segments.find((s) => s.a <= idx && idx < s.b)
      const bwSeg = run.segments.find((s) => s.a < idx && idx <= s.b)
      const fwEdge = alive(fwSeg?.forward)
      const bwEdge = alive(bwSeg?.backward)
      const dF = fwSeg ? runDistance(run, idx, fwSeg.b) : Infinity
      const dB = bwSeg ? runDistance(run, bwSeg.a, idx) : Infinity

      let useForward: boolean
      let useBackward: boolean
      if (direction === 'forward') {
        useForward = true
        useBackward = false
      } else if (direction === 'backward') {
        useForward = false
        useBackward = true
      } else if (dF <= maxDistance && dF < dB) {
        useForward = true
        useBackward = false
      } else if (dB <= maxDistance && dB < dF) {
        useForward = false
        useBackward = true
      } else {
        useForward = true
        useBackward = true
      }

      if (useForward && fwSeg && fwEdge && dF <= maxDistance) {
        result.push({ controlNode: `n${run.nodes[fwSeg.b]}`, edge: fwEdge, distance: dF })
      }
      if (useBackward && bwSeg && bwEdge && dB <= maxDistance) {
        result.push({ controlNode: `n${run.nodes[bwSeg.a]}`, edge: bwEdge, distance: dB })
      }
    }
    return result
  }

  /* --- 8. Stops et cédez-le-passage ------------------------------------ */
  const mergeControl = (nodeId: NodeId, type: 'stop' | 'give_way', yieldEdges: EdgeId[]): void => {
    const existing = network.controls[nodeId]
    if (!existing) {
      network.controls[nodeId] = { nodeId, type, yieldEdges: [...new Set(yieldEdges)] }
      return
    }
    const merged = new Set([...(existing.yieldEdges ?? []), ...yieldEdges])
    // Le régime le plus contraignant l'emporte si le carrefour porte les deux panneaux.
    existing.type = existing.type === 'stop' || type === 'stop' ? 'stop' : 'give_way'
    existing.yieldEdges = [...merged]
  }

  for (const marker of markers) {
    const tags = marker.tags ?? {}
    if (tags.highway !== 'stop' && tags.highway !== 'give_way') continue
    const type = tags.highway === 'stop' ? 'stop' : 'give_way'
    const dir = tags.direction === 'forward' ? 'forward' : tags.direction === 'backward' ? 'backward' : undefined
    const all = tags.stop === 'all'
    // Le sens explicite désigne l'approche sans ambiguïté : la limite des 40 m ne sert qu'au choix automatique.
    for (const approach of approachesOf(marker.id, dir, dir ? Infinity : STOP_ATTACH_DISTANCE_M)) {
      const yieldEdges = all
        ? (adjacency.incoming.get(approach.controlNode) ?? []).map((e) => e.id)
        : [approach.edge.id]
      if (yieldEdges.length) mergeControl(approach.controlNode, type, yieldEdges)
    }
  }

  /* --- 10. Étiquettes de nœud (avant les feux : le plan par défaut les reprend) --- */
  for (const node of Object.values(network.nodes)) {
    const names: string[] = []
    const push = (edge: NetEdge): void => {
      if (edge.name && !names.includes(edge.name)) names.push(edge.name)
    }
    for (const e of adjacency.incoming.get(node.id) ?? []) push(e)
    for (const e of adjacency.outgoing.get(node.id) ?? []) push(e)
    if (names.length) node.label = names.slice(0, 2).join(' / ')
  }

  /* --- 9. Feux : rattachement puis regroupement ------------------------ */
  const signalNodes: NodeId[] = []
  /** Nœuds déjà examinés : plusieurs nœuds OSM à feux peuvent se rattacher au même carrefour. */
  const examinedSignal = new Set<NodeId>()
  let crossingSignals = 0
  for (const marker of markers) {
    const tags = marker.tags ?? {}
    if (tags.highway !== 'traffic_signals') continue
    let nodeId: NodeId | undefined
    if (network.nodes[`n${marker.id}`]) nodeId = `n${marker.id}`
    else {
      const raw = tags['traffic_signals:direction']
      const dir = raw === 'forward' ? 'forward' : raw === 'backward' ? 'backward' : undefined
      const found = approachesOf(marker.id, dir, SIGNAL_CLUSTER_DISTANCE_M)
      found.sort((a, b) => a.distance - b.distance)
      nodeId = found[0]?.controlNode
    }
    if (!nodeId || examinedSignal.has(nodeId)) continue
    examinedSignal.add(nodeId)
    // Un feu qui ne dessert que deux branches est un feu de passage piéton : il n'a aucun mouvement en conflit.
    const branches = new Set<NodeId>()
    for (const e of adjacency.incoming.get(nodeId) ?? []) branches.add(e.from)
    for (const e of adjacency.outgoing.get(nodeId) ?? []) branches.add(e.to)
    if (branches.size < MIN_SIGNAL_BRANCHES) {
      crossingSignals++
      continue
    }
    signalNodes.push(nodeId)
  }
  if (crossingSignals) {
    warnings.push(`${crossingSignals} feu(x) de passage piéton ignoré(s) (hors carrefour).`)
  }

  // Regroupement des feux distants de moins de SIGNAL_CLUSTER_DISTANCE_M via une grille (pas de balayage O(n²)).
  if (signalNodes.length) {
    const cellSize = SIGNAL_CLUSTER_DISTANCE_M
    const grid = new Map<string, NodeId[]>()
    const cellKey = (x: number, y: number): string => `${Math.floor(x / cellSize)}|${Math.floor(y / cellSize)}`
    for (const id of signalNodes) {
      const n = network.nodes[id]
      const key = cellKey(n.x, n.y)
      let list = grid.get(key)
      if (!list) grid.set(key, (list = []))
      list.push(id)
    }
    const groups = new UnionFind<NodeId>()
    for (const id of signalNodes) groups.find(id)
    for (const id of signalNodes) {
      const n = network.nodes[id]
      const cx = Math.floor(n.x / cellSize)
      const cy = Math.floor(n.y / cellSize)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const other of grid.get(`${cx + dx}|${cy + dy}`) ?? []) {
            if (other === id) continue
            const m = network.nodes[other]
            if (Math.hypot(m.x - n.x, m.y - n.y) <= SIGNAL_CLUSTER_DISTANCE_M) groups.union(id, other)
          }
        }
      }
    }
    const byRoot = new Map<NodeId, NodeId[]>()
    for (const id of signalNodes) {
      const root = groups.find(id)
      let list = byRoot.get(root)
      if (!list) byRoot.set(root, (list = []))
      list.push(id)
    }
    for (const group of byRoot.values()) {
      let smallest = Infinity
      for (const id of group) {
        const osmId = network.nodes[id].osmId
        if (osmId !== undefined && osmId < smallest) smallest = osmId
      }
      const controllerId = `c${Number.isFinite(smallest) ? smallest : group[0]}`
      const plan = createDefaultSignalPlan(network, group, undefined, adjacency)
      network.controllers[controllerId] = { id: controllerId, ...plan }
      for (const id of group) network.controls[id] = { nodeId: id, type: 'signals', controllerId }
    }
  }

  /* --- 11. Statistiques ------------------------------------------------ */
  let entries = 0
  let exits = 0
  for (const node of Object.values(network.nodes)) {
    if (!node.boundary) continue
    if ((adjacency.outgoing.get(node.id) ?? []).length) entries++
    if ((adjacency.incoming.get(node.id) ?? []).length) exits++
  }
  let stops = 0
  let giveWays = 0
  let signals = 0
  for (const control of Object.values(network.controls)) {
    if (control.type === 'stop') stops++
    else if (control.type === 'give_way') giveWays++
    else if (control.type === 'signals') signals++
  }

  const stats: ImportStats = {
    ways: waysRead,
    edges: Object.keys(network.edges).length,
    nodes: Object.keys(network.nodes).length,
    entries,
    exits,
    signals,
    controllers: Object.keys(network.controllers).length,
    stops,
    giveWays,
    restrictions,
    droppedEdges,
    warnings: warnings.length,
  }
  return { network, warnings, stats }
}
