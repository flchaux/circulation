/**
 * Dessin de la carte sur deux canvas superposés (§7 de docs/ARCHITECTURE.md).
 *
 * Ce module ne dépend **pas** de Leaflet : il reçoit une projection « mètres locaux → pixels absolus du
 * zoom courant » et l'origine du canvas dans ce même repère. `MapView.tsx` fait le pont avec Leaflet, ce qui
 * rend le rendu testable hors navigateur.
 *
 * Deux couches :
 *  - statique (`drawStatic`) : tronçons, hachures, chevrons, nœuds, étiquettes, surbrillance de la sélection ;
 *  - dynamique (`drawDynamic`) : véhicules interpolés, points d'état des feux, survol, chemin de l'outil.
 *
 * Le coût du redessin statique est dominé par le nombre de tronçons : les polylignes projetées sont mémoïsées
 * sur l'identité de l'objet `NetEdge` (immuable, cf. src/state/edits.ts) et jetées à chaque changement de zoom.
 */
import type { ControllerId, EdgeId, NetEdge, Network, NodeId, SimResults } from '@/model/types'
import { highwayRank, parseMovementKey } from '@/model/types'
import { buildAdjacency } from '@/model/geometry'
import { controllerApproaches } from '@/model/signals'
import type { ColorMode, DragState, MapTool, Selection } from '@/state/storeTypes'
import type { ControllerState, Frame } from '@/engine/protocol'
import { VEHICLE_STRIDE } from '@/engine/protocol'
import {
  CLOSED_COLOR, DROP_TARGET_COLOR, HOVER_COLOR, SELECTION_COLOR, TOOL_COLOR,
  type ColorScale, edgeColor, edgeValue, formatValue, scaleFor,
} from './colors'

/* ------------------------------------------------------------------ */
/*  Constantes d'affichage                                             */
/* ------------------------------------------------------------------ */

/** En dessous de ce zoom : ni véhicules ni rues résidentielles. */
export const MIN_DETAIL_ZOOM = 14
/** Zoom à partir duquel tous les nœuds sont dessinés. */
export const NODE_ZOOM = 15
/** Zoom à partir duquel les chevrons de sens unique apparaissent. */
export const ARROW_ZOOM = 15
/** Zoom à partir duquel les étiquettes (noms, valeurs) apparaissent. */
export const LABEL_ZOOM = 16
/** Tolérance de sélection au clic (px). */
export const HIT_TOLERANCE_PX = 8
/** Distance (px) sous laquelle un nœud déposé fusionne avec un autre. */
export const MERGE_TOLERANCE_PX = 12
/** Largeur d'une voie (m) pour la largeur de trait à l'échelle. */
export const LANE_WIDTH_M = 3.2
/** Largeur de trait maximale (px). */
const MAX_EDGE_WIDTH_PX = 16
/** Dimensions d'un véhicule (m). */
const VEHICLE_LENGTH_M = 4.6
const VEHICLE_WIDTH_M = 2

const COLOR_VEHICLE = '#12386b'
const COLOR_VEHICLE_QUEUED = '#c01c28'
const COLOR_NODE = '#42505f'
const COLOR_NODE_FILL = '#ffffff'
const COLOR_LABEL = '#1f2933'
const COLOR_LABEL_HALO = 'rgba(255,255,255,0.9)'
const COLOR_HATCH = '#b3261e'
const SIGNAL_COLORS = { green: '#11a53a', amber: '#f0a020', red: '#d92020', off: '#6b7280' }

const FONT_LABEL = '500 11px system-ui, "Segoe UI", Roboto, sans-serif'
const FONT_VALUE = '600 11px system-ui, "Segoe UI", Roboto, sans-serif'

/* ------------------------------------------------------------------ */
/*  Géométrie projetée                                                 */
/* ------------------------------------------------------------------ */

/** Projection « mètres locaux → pixels absolus du zoom courant » (fournie par Leaflet). */
export type Projector = (x: number, y: number) => [number, number]

export interface EdgeCache {
  /** Polyligne dessinée (déjà décalée sur la voie de droite), pixels absolus, x/y entrelacés. */
  pts: Float64Array
  /** Longueurs cumulées le long de `pts` (px) ; `cum[0] = 0`. */
  cum: Float32Array
  /** Nombre de points. */
  count: number
  /** Longueur totale (px). */
  length: number
  /** Largeur du trait (px). */
  width: number
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface PointOnEdge {
  x: number
  y: number
  /** Vecteur unitaire de la direction de circulation. */
  dx: number
  dy: number
}

/** Largeur de trait d'un tronçon : à l'échelle si possible, avec un minimum selon la classe. */
export function edgeWidth(edge: NetEdge, pxPerMeter: number, zoom: number): number {
  const rank = highwayRank(edge.highway)
  const bonus = rank <= 2 ? 1.6 : rank <= 4.5 ? 0.8 : 0
  const min = (zoom >= NODE_ZOOM ? 1.4 : 1) + bonus
  return Math.max(min, Math.min(MAX_EDGE_WIDTH_PX, edge.lanes * LANE_WIDTH_M * pxPerMeter))
}

/**
 * Décale une polyligne (pixels, y vers le bas) de `offset` px vers la droite du sens de parcours.
 * Les normales des segments adjacents sont moyennées : suffisant pour des décalages de quelques pixels.
 */
export function offsetPolyline(pts: Float64Array, count: number, offset: number): Float64Array {
  if (offset === 0 || count < 2) return pts
  const out = new Float64Array(count * 2)
  const nx = new Float64Array(count - 1)
  const ny = new Float64Array(count - 1)
  for (let i = 0; i < count - 1; i++) {
    const dx = pts[2 * i + 2] - pts[2 * i]
    const dy = pts[2 * i + 3] - pts[2 * i + 1]
    const len = Math.hypot(dx, dy)
    if (len > 0) {
      // Normale droite en repère écran (y vers le bas).
      nx[i] = -dy / len
      ny[i] = dx / len
    }
  }
  for (let i = 0; i < count; i++) {
    let ax = 0
    let ay = 0
    if (i > 0) { ax += nx[i - 1]; ay += ny[i - 1] }
    if (i < count - 1) { ax += nx[i]; ay += ny[i] }
    const len = Math.hypot(ax, ay)
    if (len > 1e-9) { ax /= len; ay /= len } else { ax = 0; ay = 0 }
    out[2 * i] = pts[2 * i] + ax * offset
    out[2 * i + 1] = pts[2 * i + 1] + ay * offset
  }
  return out
}

/** Projette une polyligne locale, la décale et précalcule ses longueurs cumulées et son cadre englobant. */
export function buildEdgeCache(
  geometry: readonly (readonly [number, number])[],
  project: Projector,
  offset: number,
  width: number,
): EdgeCache {
  const raw = new Float64Array(Math.max(2, geometry.length) * 2)
  let count = 0
  for (const [gx, gy] of geometry) {
    const [px, py] = project(gx, gy)
    // Les points projetés confondus (géométrie dégénérée) fausseraient les normales.
    if (count > 0 && Math.abs(px - raw[2 * count - 2]) < 1e-6 && Math.abs(py - raw[2 * count - 1]) < 1e-6) continue
    raw[2 * count] = px
    raw[2 * count + 1] = py
    count++
  }
  if (count === 0) { raw[0] = 0; raw[1] = 0; count = 1 }
  if (count === 1) { raw[2] = raw[0]; raw[3] = raw[1]; count = 2 }

  const pts = offsetPolyline(raw, count, offset)
  const cum = new Float32Array(count)
  let total = 0
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < count; i++) {
    const x = pts[2 * i]
    const y = pts[2 * i + 1]
    if (i > 0) {
      total += Math.hypot(x - pts[2 * i - 2], y - pts[2 * i - 1])
      cum[i] = total
    }
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const half = width / 2 + 1
  return {
    pts, cum, count, length: total, width,
    minX: minX - half, minY: minY - half, maxX: maxX + half, maxY: maxY + half,
  }
}

/** Point situé à `dist` px du début de la polyligne (recherche dichotomique sur les longueurs cumulées). */
export function pointAtPx(cache: EdgeCache, dist: number, out: PointOnEdge): PointOnEdge {
  const { pts, cum, count } = cache
  let lo = 0
  let hi = count - 1
  if (dist > 0 && dist < cache.length) {
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1
      if (cum[mid] <= dist) lo = mid
      else hi = mid
    }
  } else if (dist >= cache.length) {
    lo = count - 2
  }
  hi = lo + 1
  const ax = pts[2 * lo]
  const ay = pts[2 * lo + 1]
  const bx = pts[2 * hi]
  const by = pts[2 * hi + 1]
  const segLen = cum[hi] - cum[lo]
  const t = segLen > 1e-9 ? Math.min(1, Math.max(0, (dist - cum[lo]) / segLen)) : 0
  out.x = ax + (bx - ax) * t
  out.y = ay + (by - ay) * t
  const len = Math.hypot(bx - ax, by - ay)
  out.dx = len > 1e-9 ? (bx - ax) / len : 1
  out.dy = len > 1e-9 ? (by - ay) / len : 0
  return out
}

/** Distance au carré d'un point à un segment. */
export function distanceToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  let t = 0
  if (l2 > 1e-12) t = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / l2))
  const cx = ax + dx * t - px
  const cy = ay + dy * t - py
  return cx * cx + cy * cy
}

/** Distance au carré d'un point à la polyligne d'un tronçon. */
export function distanceToPolylineSq(cache: EdgeCache, px: number, py: number): number {
  let best = Infinity
  const { pts, count } = cache
  for (let i = 0; i < count - 1; i++) {
    const d = distanceToSegmentSq(px, py, pts[2 * i], pts[2 * i + 1], pts[2 * i + 2], pts[2 * i + 3])
    if (d < best) best = d
  }
  return best
}

/* ------------------------------------------------------------------ */
/*  Interpolation des véhicules                                        */
/* ------------------------------------------------------------------ */

/**
 * Lisse le déplacement des véhicules entre deux frames du moteur (une frame toutes les ~50 à 250 ms réelles).
 * Un véhicule est suivi par son `id` ; s'il a changé de tronçon entre les deux frames, sa position brute est
 * utilisée (l'interpolation n'aurait pas de sens d'une polyligne à l'autre).
 */
export class VehicleInterpolator {
  private prev: Float32Array | null = null
  private prevIndex = new Map<number, number>()
  private cur: Float32Array | null = null
  private curAt = 0
  private interval = 100

  /** Enregistre une nouvelle frame reçue à l'instant `at` (ms, horloge monotone). */
  push(frame: Frame, at: number): void {
    if (this.cur) {
      this.prev = this.cur
      this.prevIndex.clear()
      for (let i = 0; i + VEHICLE_STRIDE <= this.prev.length; i += VEHICLE_STRIDE) this.prevIndex.set(this.prev[i], i)
      // Cadence réelle observée, bornée pour rester stable si une frame tarde.
      this.interval = Math.min(400, Math.max(30, at - this.curAt))
    }
    this.cur = frame.vehicles
    this.curAt = at
  }

  reset(): void {
    this.prev = null
    this.cur = null
    this.prevIndex.clear()
    this.interval = 100
  }

  /** Parcourt les véhicules de la dernière frame, positions interpolées à l'instant `now`. */
  each(now: number, visit: (edgeIndex: number, pos: number, queued: boolean) => void): void {
    const cur = this.cur
    if (!cur) return
    const alpha = Math.min(1, Math.max(0, (now - this.curAt) / this.interval))
    const prev = this.prev
    for (let i = 0; i + VEHICLE_STRIDE <= cur.length; i += VEHICLE_STRIDE) {
      const edgeIndex = cur[i + 1]
      let pos = cur[i + 2]
      if (prev && alpha < 1) {
        const j = this.prevIndex.get(cur[i])
        if (j !== undefined && prev[j + 1] === edgeIndex) pos = prev[j + 2] + (pos - prev[j + 2]) * alpha
      }
      visit(edgeIndex, pos, cur[i + 3] !== 0)
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Scène                                                              */
/* ------------------------------------------------------------------ */

/** Cadrage courant : tout est exprimé en pixels absolus du zoom Leaflet courant. */
export interface RendererView {
  zoom: number
  /** Pixel absolu du coin haut-gauche du canvas. */
  originX: number
  originY: number
  /** Position du coin haut-gauche du canvas dans le conteneur (négative : le canvas déborde). */
  offsetX: number
  offsetY: number
  /** Taille du canvas en pixels CSS. */
  width: number
  height: number
  /** Échelle du zoom courant. */
  pxPerMeter: number
  project: Projector
}

/** Données lues dans le store pour un redessin (objet reconstruit à chaque frame, sans copie profonde). */
export interface MapScene {
  network: Network
  colorMode: ColorMode
  results: SimResults | null
  reference: SimResults | null
  selection: Selection
  hover: Selection
  drag: DragState | null
  showLabels: boolean
  showVehicles: boolean
  tool: MapTool
  toolNodes: NodeId[]
  /** Chemin prévisualisé par l'outil en cours (onde verte / ajout de tronçon). */
  toolPath: NodeId[]
  frame: Frame | null
  edgeIndex: EdgeId[]
}

/** Approche pilotée par un contrôleur : le point d'état est dessiné à sa ligne d'arrêt. */
interface ApproachDot {
  edgeId: EdgeId
  /** Pour chaque phase : l'approche a-t-elle au moins un mouvement au vert ? */
  greenByPhase: boolean[]
}

interface NetworkIndex {
  network: Network
  zoom: number
  /** Tronçons triés par importance croissante : les voies principales sont dessinées par-dessus. */
  edges: NetEdge[]
  nodeIds: NodeId[]
  /** Pixels absolus des nœuds, x/y entrelacés. */
  nodePx: Float64Array
  nodeAt: Map<NodeId, number>
  controllers: Map<ControllerId, ApproachDot[]>
}

/* ------------------------------------------------------------------ */
/*  Renderer                                                           */
/* ------------------------------------------------------------------ */

export class MapRenderer {
  private view: RendererView = {
    zoom: 0, originX: 0, originY: 0, offsetX: 0, offsetY: 0, width: 0, height: 0,
    pxPerMeter: 1, project: () => [0, 0],
  }

  private caches = new WeakMap<NetEdge, EdgeCache>()
  private index: NetworkIndex | null = null
  private scale: ColorScale | null = null
  private scaleKey: { mode: ColorMode; results: SimResults | null; reference: SimResults | null } | null = null
  private edgeByIndex: { key: EdgeId[]; network: Network; edges: (NetEdge | undefined)[] } | null = null
  private readonly point: PointOnEdge = { x: 0, y: 0, dx: 1, dy: 0 }

  constructor(
    private readonly staticCtx: CanvasRenderingContext2D,
    private readonly dynamicCtx: CanvasRenderingContext2D,
  ) {}

  /** Met à jour le cadrage ; un changement de zoom invalide toutes les polylignes projetées. */
  setView(view: RendererView): void {
    if (view.zoom !== this.view.zoom) {
      this.caches = new WeakMap()
      this.index = null
    }
    this.view = view
  }

  getView(): RendererView {
    return this.view
  }

  /** Invalide les caches dérivés du réseau (appelé quand `network` change d'identité). */
  invalidate(): void {
    this.index = null
    this.edgeByIndex = null
  }

  /* ---------------- caches ---------------- */

  private cacheFor(edge: NetEdge, drag: DragState | null): EdgeCache {
    const width = edgeWidth(edge, this.view.pxPerMeter, this.view.zoom)
    const offset = edge.reverseOf ? width / 2 + 0.4 : 0
    if (drag && (edge.from === drag.nodeId || edge.to === drag.nodeId)) {
      // Glisser en cours : géométrie transitoire, hors cache (le nœud bouge à chaque mouvement de souris).
      const geometry = edge.geometry.map((p, i) => {
        if (i === 0 && edge.from === drag.nodeId) return [drag.x, drag.y] as [number, number]
        if (i === edge.geometry.length - 1 && edge.to === drag.nodeId) return [drag.x, drag.y] as [number, number]
        return p
      })
      return buildEdgeCache(geometry, this.view.project, offset, width)
    }
    let cache = this.caches.get(edge)
    if (!cache) {
      cache = buildEdgeCache(edge.geometry, this.view.project, offset, width)
      this.caches.set(edge, cache)
    }
    return cache
  }

  private ensureIndex(network: Network): NetworkIndex {
    const current = this.index
    if (current && current.network === network && current.zoom === this.view.zoom) return current

    const edges = Object.values(network.edges)
    edges.sort((a, b) => highwayRank(b.highway) - highwayRank(a.highway))
    const nodeIds = Object.keys(network.nodes)
    const nodePx = new Float64Array(nodeIds.length * 2)
    const nodeAt = new Map<NodeId, number>()
    for (let i = 0; i < nodeIds.length; i++) {
      const node = network.nodes[nodeIds[i]]
      const [px, py] = this.view.project(node.x, node.y)
      nodePx[2 * i] = px
      nodePx[2 * i + 1] = py
      nodeAt.set(nodeIds[i], i)
    }
    const index: NetworkIndex = {
      network, zoom: this.view.zoom, edges, nodeIds, nodePx, nodeAt,
      controllers: buildControllerDots(network),
    }
    this.index = index
    return index
  }

  private scaleOf(scene: MapScene): ColorScale {
    const key = this.scaleKey
    if (!this.scale || !key || key.mode !== scene.colorMode || key.results !== scene.results
      || key.reference !== scene.reference) {
      this.scale = scaleFor(scene.colorMode, scene.results, scene.reference)
      this.scaleKey = { mode: scene.colorMode, results: scene.results, reference: scene.reference }
    }
    return this.scale
  }

  private edgesOfFrame(scene: MapScene): (NetEdge | undefined)[] {
    const memo = this.edgeByIndex
    if (memo && memo.key === scene.edgeIndex && memo.network === scene.network) return memo.edges
    const edges = scene.edgeIndex.map((id) => scene.network.edges[id])
    this.edgeByIndex = { key: scene.edgeIndex, network: scene.network, edges }
    return edges
  }

  /* ---------------- couche statique ---------------- */

  drawStatic(scene: MapScene): void {
    const ctx = this.staticCtx
    const { width, height, zoom } = this.view
    ctx.clearRect(0, 0, width, height)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    const index = this.ensureIndex(scene.network)
    const scale = this.scaleOf(scene)
    const detailed = zoom >= MIN_DETAIL_ZOOM

    // 1. Surbrillance de la sélection, sous les tronçons.
    this.drawHighlight(ctx, scene, scene.selection, SELECTION_COLOR, 0.45)

    // 2. Tronçons.
    const visible: NetEdge[] = []
    for (const edge of index.edges) {
      if (!detailed && (edge.highway === 'residential' || edge.highway === 'living_street')) continue
      const cache = this.cacheFor(edge, scene.drag)
      if (!this.inView(cache)) continue
      visible.push(edge)
      ctx.lineWidth = cache.width
      ctx.strokeStyle = edge.closed ? CLOSED_COLOR : edgeColor(scene.colorMode, edge, scale, scene.results, scene.reference)
      this.strokePolyline(ctx, cache)
    }

    // 3. Hachures des tronçons fermés puis chevrons de sens unique.
    ctx.lineCap = 'butt'
    for (const edge of visible) {
      if (!edge.closed) continue
      this.drawHatching(ctx, this.cacheFor(edge, scene.drag))
    }
    ctx.lineCap = 'round'
    if (zoom >= ARROW_ZOOM) {
      for (const edge of visible) {
        if (edge.reverseOf || edge.closed) continue
        this.drawArrows(ctx, this.cacheFor(edge, scene.drag))
      }
    }

    // 4. Nœuds.
    this.drawNodes(ctx, scene, index)

    // 5. Étiquettes.
    if (scene.showLabels && zoom >= LABEL_ZOOM) this.drawLabels(ctx, scene, visible, scale)

    // 6. Glisser en cours : nœud déplacé et cible de fusion.
    if (scene.drag) this.drawDrag(ctx, scene, index, scene.drag)
  }

  /* ---------------- couche dynamique ---------------- */

  drawDynamic(scene: MapScene, interpolator: VehicleInterpolator, now: number): void {
    const ctx = this.dynamicCtx
    const { width, height } = this.view
    ctx.clearRect(0, 0, width, height)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    const index = this.ensureIndex(scene.network)
    this.drawHighlight(ctx, scene, scene.hover, HOVER_COLOR, 0.35)
    this.drawToolPath(ctx, scene)
    if (scene.frame) this.drawSignalStates(ctx, scene, index, scene.frame.controllers, now)
    if (scene.showVehicles && this.view.zoom >= MIN_DETAIL_ZOOM) this.drawVehicles(ctx, scene, interpolator, now)
  }

  /* ---------------- primitives ---------------- */

  private inView(cache: EdgeCache): boolean {
    const { originX, originY, width, height } = this.view
    return cache.maxX >= originX && cache.minX <= originX + width
      && cache.maxY >= originY && cache.minY <= originY + height
  }

  private inViewPoint(x: number, y: number, margin: number): boolean {
    const { originX, originY, width, height } = this.view
    return x >= originX - margin && x <= originX + width + margin
      && y >= originY - margin && y <= originY + height + margin
  }

  private strokePolyline(ctx: CanvasRenderingContext2D, cache: EdgeCache): void {
    const { originX, originY } = this.view
    const { pts, count } = cache
    ctx.beginPath()
    ctx.moveTo(pts[0] - originX, pts[1] - originY)
    for (let i = 1; i < count; i++) ctx.lineTo(pts[2 * i] - originX, pts[2 * i + 1] - originY)
    ctx.stroke()
  }

  /** Hachures perpendiculaires d'un tronçon fermé à la circulation. */
  private drawHatching(ctx: CanvasRenderingContext2D, cache: EdgeCache): void {
    const { originX, originY } = this.view
    const step = Math.max(6, cache.width * 1.5)
    const half = Math.max(2, cache.width * 0.7)
    ctx.strokeStyle = COLOR_HATCH
    ctx.lineWidth = 1.2
    ctx.beginPath()
    for (let d = step / 2; d < cache.length; d += step) {
      const p = pointAtPx(cache, d, this.point)
      const nx = -p.dy
      const ny = p.dx
      ctx.moveTo(p.x - originX - nx * half, p.y - originY - ny * half)
      ctx.lineTo(p.x - originX + nx * half, p.y - originY + ny * half)
    }
    ctx.stroke()
  }

  /** Chevrons indiquant le sens de circulation d'un tronçon à sens unique. */
  private drawArrows(ctx: CanvasRenderingContext2D, cache: EdgeCache): void {
    if (cache.length < 40) return
    const { originX, originY } = this.view
    const size = Math.max(2.5, Math.min(5, cache.width * 0.8))
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth = Math.max(1, cache.width * 0.28)
    ctx.beginPath()
    for (let d = 30; d < cache.length - 10; d += 60) {
      const p = pointAtPx(cache, d, this.point)
      const x = p.x - originX
      const y = p.y - originY
      const bx = -p.dx * size
      const by = -p.dy * size
      const nx = -p.dy * size * 0.7
      const ny = p.dx * size * 0.7
      ctx.moveTo(x + bx + nx, y + by + ny)
      ctx.lineTo(x, y)
      ctx.lineTo(x + bx - nx, y + by - ny)
    }
    ctx.stroke()
  }

  /** Halo de sélection ou de survol autour d'un tronçon, d'un nœud ou des nœuds d'un contrôleur. */
  private drawHighlight(
    ctx: CanvasRenderingContext2D,
    scene: MapScene,
    target: Selection,
    color: string,
    alpha: number,
  ): void {
    if (!target) return
    const { originX, originY } = this.view
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.strokeStyle = color
    ctx.fillStyle = color
    if (target.kind === 'edge') {
      const edge = scene.network.edges[target.id]
      if (edge) {
        const cache = this.cacheFor(edge, scene.drag)
        ctx.lineWidth = cache.width + 8
        this.strokePolyline(ctx, cache)
      }
    } else {
      const nodeIds = target.kind === 'node'
        ? [target.id]
        : scene.network.controllers[target.id]?.nodeIds ?? []
      for (const id of nodeIds) {
        const node = scene.network.nodes[id]
        if (!node) continue
        const [px, py] = this.nodePosition(scene, id, node.x, node.y)
        ctx.beginPath()
        ctx.arc(px - originX, py - originY, 11, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.restore()
  }

  /** Position projetée d'un nœud, position transitoire comprise pendant un glisser. */
  private nodePosition(scene: MapScene, id: NodeId, x: number, y: number): [number, number] {
    if (scene.drag && scene.drag.nodeId === id) return this.view.project(scene.drag.x, scene.drag.y)
    const index = this.index
    if (index && index.network === scene.network) {
      const i = index.nodeAt.get(id)
      if (i !== undefined) return [index.nodePx[2 * i], index.nodePx[2 * i + 1]]
    }
    return this.view.project(x, y)
  }

  private drawNodes(ctx: CanvasRenderingContext2D, scene: MapScene, index: NetworkIndex): void {
    const { originX, originY, zoom } = this.view
    const network = scene.network
    ctx.lineWidth = 1.2
    for (let i = 0; i < index.nodeIds.length; i++) {
      const id = index.nodeIds[i]
      const node = network.nodes[id]
      if (!node) continue
      if (scene.drag?.nodeId === id) continue // dessiné à sa position transitoire par drawDrag
      const px = index.nodePx[2 * i]
      const py = index.nodePx[2 * i + 1]
      if (!this.inViewPoint(px, py, 12)) continue
      const control = network.controls[id]
      const x = px - originX
      const y = py - originY
      if (control?.type === 'signals') {
        ctx.fillStyle = '#2b3440'
        ctx.strokeStyle = COLOR_NODE_FILL
        ctx.beginPath()
        ctx.arc(x, y, 5, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
        if (zoom >= LABEL_ZOOM) {
          ctx.fillStyle = SIGNAL_COLORS.amber
          ctx.beginPath()
          ctx.arc(x, y, 1.8, 0, Math.PI * 2)
          ctx.fill()
        }
      } else if (node.boundary) {
        ctx.fillStyle = COLOR_NODE_FILL
        ctx.strokeStyle = COLOR_NODE
        ctx.beginPath()
        ctx.rect(x - 4, y - 4, 8, 8)
        ctx.fill()
        ctx.stroke()
      } else if (control?.type === 'stop' || control?.type === 'give_way') {
        ctx.fillStyle = control.type === 'stop' ? '#d92020' : COLOR_NODE_FILL
        ctx.strokeStyle = '#d92020'
        ctx.beginPath()
        ctx.moveTo(x, y + 4)
        ctx.lineTo(x - 4, y - 3)
        ctx.lineTo(x + 4, y - 3)
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
      } else if (zoom >= NODE_ZOOM) {
        ctx.fillStyle = COLOR_NODE_FILL
        ctx.strokeStyle = COLOR_NODE
        ctx.beginPath()
        ctx.arc(x, y, node.miniRoundabout ? 4 : 2.4, 0, Math.PI * 2)
        ctx.fill()
        if (node.miniRoundabout) ctx.stroke()
      }
    }
  }

  private drawDrag(ctx: CanvasRenderingContext2D, scene: MapScene, index: NetworkIndex, drag: DragState): void {
    const { originX, originY } = this.view
    if (drag.dropOn) {
      const target = scene.network.nodes[drag.dropOn]
      if (target) {
        const [tx, ty] = this.nodePosition(scene, drag.dropOn, target.x, target.y)
        ctx.strokeStyle = DROP_TARGET_COLOR
        ctx.lineWidth = 2.5
        ctx.beginPath()
        ctx.arc(tx - originX, ty - originY, MERGE_TOLERANCE_PX, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
    const [px, py] = this.view.project(drag.x, drag.y)
    ctx.fillStyle = SELECTION_COLOR
    ctx.strokeStyle = COLOR_NODE_FILL
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(px - originX, py - originY, 5.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }

  /**
   * Étiquettes : nom de rue le long du tronçon et valeur du mode de couleur.
   * Une grille d'occupation évite les chevauchements et un nom n'est écrit qu'une fois par redessin.
   */
  private drawLabels(
    ctx: CanvasRenderingContext2D,
    scene: MapScene,
    edges: NetEdge[],
    scale: ColorScale,
  ): void {
    const { originX, originY } = this.view
    const used = new Set<number>()
    const names = new Set<string>()
    const cell = 44
    const occupy = (x: number, y: number): boolean => {
      const key = ((x / cell) | 0) * 4096 + ((y / cell) | 0)
      if (used.has(key)) return false
      used.add(key)
      return true
    }
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'
    for (let i = edges.length - 1; i >= 0; i--) {
      const edge = edges[i]
      const cache = this.cacheFor(edge, scene.drag)
      if (cache.length < 45) continue
      const value = edgeValue(scene.colorMode, edge, scene.results, scene.reference)
      const p = pointAtPx(cache, cache.length / 2, this.point)
      const x = p.x - originX
      const y = p.y - originY
      if (x < 0 || y < 0 || x > this.view.width || y > this.view.height) continue
      if (value !== null) {
        if (!occupy(x, y)) continue
        ctx.font = FONT_VALUE
        const text = formatValue(scene.colorMode, value)
        const w = ctx.measureText(text).width
        ctx.fillStyle = 'rgba(255,255,255,0.85)'
        ctx.fillRect(x - w / 2 - 3, y - 8, w + 6, 15)
        ctx.fillStyle = scale.color(value)
        ctx.fillRect(x - w / 2 - 3, y + 6, w + 6, 2)
        ctx.fillStyle = COLOR_LABEL
        ctx.fillText(text, x, y)
        continue
      }
      if (!edge.name || names.has(edge.name)) continue
      if (!occupy(x, y)) continue
      names.add(edge.name)
      ctx.font = FONT_LABEL
      // Texte orienté le long de la voie, toujours lisible de gauche à droite.
      let angle = Math.atan2(p.dy, p.dx)
      if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(angle)
      ctx.lineWidth = 3
      ctx.strokeStyle = COLOR_LABEL_HALO
      ctx.strokeText(edge.name, 0, -cache.width / 2 - 7)
      ctx.fillStyle = COLOR_LABEL
      ctx.fillText(edge.name, 0, -cache.width / 2 - 7)
      ctx.restore()
    }
  }

  /** Chemin prévisualisé et nœuds déjà cliqués par l'outil à deux clics. */
  private drawToolPath(ctx: CanvasRenderingContext2D, scene: MapScene): void {
    if (scene.tool === 'select') return
    const { originX, originY } = this.view
    const path = scene.toolPath
    if (path.length > 1) {
      ctx.save()
      ctx.strokeStyle = TOOL_COLOR
      ctx.globalAlpha = 0.6
      ctx.lineWidth = 6
      ctx.setLineDash(scene.tool === 'addEdge' ? [8, 6] : [])
      ctx.beginPath()
      for (let i = 0; i < path.length; i++) {
        const node = scene.network.nodes[path[i]]
        if (!node) continue
        const [px, py] = this.nodePosition(scene, path[i], node.x, node.y)
        if (i === 0) ctx.moveTo(px - originX, py - originY)
        else ctx.lineTo(px - originX, py - originY)
      }
      ctx.stroke()
      ctx.restore()
    }
    ctx.strokeStyle = TOOL_COLOR
    ctx.fillStyle = COLOR_NODE_FILL
    ctx.lineWidth = 2.5
    for (const id of scene.toolNodes) {
      const node = scene.network.nodes[id]
      if (!node) continue
      const [px, py] = this.nodePosition(scene, id, node.x, node.y)
      ctx.beginPath()
      ctx.arc(px - originX, py - originY, 7, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
  }

  /** Point vert / orange / rouge à la ligne d'arrêt de chaque approche pilotée. */
  private drawSignalStates(
    ctx: CanvasRenderingContext2D,
    scene: MapScene,
    index: NetworkIndex,
    states: ControllerState[],
    now: number,
  ): void {
    if (this.view.zoom < NODE_ZOOM) return
    const { originX, originY } = this.view
    const blinkOn = Math.floor(now / 500) % 2 === 0
    ctx.lineWidth = 1
    ctx.strokeStyle = COLOR_NODE_FILL
    for (const state of states) {
      const approaches = index.controllers.get(state.id)
      if (!approaches) continue
      for (const approach of approaches) {
        const edge = scene.network.edges[approach.edgeId]
        if (!edge) continue
        const cache = this.cacheFor(edge, scene.drag)
        const p = pointAtPx(cache, Math.max(0, cache.length - 7), this.point)
        if (!this.inViewPoint(p.x, p.y, 8)) continue
        const green = state.phaseIndex >= 0 && approach.greenByPhase[state.phaseIndex] === true
        let color: string
        switch (state.state) {
          case 'green': color = green ? SIGNAL_COLORS.green : SIGNAL_COLORS.red; break
          case 'amber': color = green ? SIGNAL_COLORS.amber : SIGNAL_COLORS.red; break
          case 'allred': color = SIGNAL_COLORS.red; break
          case 'flashing': color = blinkOn ? SIGNAL_COLORS.amber : SIGNAL_COLORS.off; break
          case 'off': color = SIGNAL_COLORS.off; break
        }
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(p.x - originX, p.y - originY, 3.4, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
      }
    }
  }

  private drawVehicles(
    ctx: CanvasRenderingContext2D,
    scene: MapScene,
    interpolator: VehicleInterpolator,
    now: number,
  ): void {
    const { originX, originY, pxPerMeter } = this.view
    const edges = this.edgesOfFrame(scene)
    const len = Math.max(2.5, VEHICLE_LENGTH_M * pxPerMeter)
    const halfWidth = Math.max(0.8, (VEHICLE_WIDTH_M * pxPerMeter) / 2)
    const point = this.point
    // Deux passes de remplissage (roule / en file) : un seul changement d'état du contexte.
    const rolling: number[] = []
    const queued: number[] = []
    interpolator.each(now, (edgeIndex, pos, isQueued) => {
      const edge = edges[edgeIndex]
      if (!edge || edge.length <= 0) return
      const cache = this.cacheFor(edge, scene.drag)
      if (!this.inView(cache)) return
      // Les positions du moteur sont en mètres : le rapport pixels/mètres est constant le long du tronçon.
      const d = Math.min(cache.length, Math.max(0, (pos / edge.length) * cache.length))
      pointAtPx(cache, Math.max(0, d - len / 2), point)
      if (!this.inViewPoint(point.x, point.y, 8)) return
      const target = isQueued ? queued : rolling
      target.push(point.x - originX, point.y - originY, point.dx, point.dy)
    })
    for (const [list, color] of [[rolling, COLOR_VEHICLE], [queued, COLOR_VEHICLE_QUEUED]] as const) {
      if (!list.length) continue
      ctx.fillStyle = color
      ctx.beginPath()
      for (let i = 0; i < list.length; i += 4) {
        const x = list[i]
        const y = list[i + 1]
        const dx = list[i + 2]
        const dy = list[i + 3]
        const hx = (dx * len) / 2
        const hy = (dy * len) / 2
        const wx = -dy * halfWidth
        const wy = dx * halfWidth
        ctx.moveTo(x - hx - wx, y - hy - wy)
        ctx.lineTo(x + hx - wx, y + hy - wy)
        ctx.lineTo(x + hx + wx, y + hy + wy)
        ctx.lineTo(x - hx + wx, y - hy + wy)
        ctx.closePath()
      }
      ctx.fill()
    }
  }

  /* ---------------- interactions ---------------- */

  /** Nœud le plus proche d'un point du conteneur, dans la tolérance donnée. */
  hitTestNode(
    network: Network,
    containerX: number,
    containerY: number,
    tolerance = HIT_TOLERANCE_PX,
    exclude?: NodeId,
  ): NodeId | null {
    const index = this.ensureIndex(network)
    const x = containerX - this.view.offsetX + this.view.originX
    const y = containerY - this.view.offsetY + this.view.originY
    const max = tolerance * tolerance
    let best: NodeId | null = null
    let bestDist = Infinity
    for (let i = 0; i < index.nodeIds.length; i++) {
      const id = index.nodeIds[i]
      if (id === exclude) continue
      const dx = index.nodePx[2 * i] - x
      const dy = index.nodePx[2 * i + 1] - y
      const d = dx * dx + dy * dy
      if (d <= max && d < bestDist) { bestDist = d; best = id }
    }
    return best
  }

  /** Élément sous le curseur : les nœuds sont prioritaires sur les tronçons (§7). */
  hitTest(
    network: Network,
    containerX: number,
    containerY: number,
    tolerance = HIT_TOLERANCE_PX,
  ): Selection {
    const node = this.hitTestNode(network, containerX, containerY, tolerance)
    if (node) return { kind: 'node', id: node }
    const index = this.ensureIndex(network)
    const x = containerX - this.view.offsetX + this.view.originX
    const y = containerY - this.view.offsetY + this.view.originY
    const detailed = this.view.zoom >= MIN_DETAIL_ZOOM
    let best: EdgeId | null = null
    let bestDist = Infinity
    for (const edge of index.edges) {
      if (!detailed && (edge.highway === 'residential' || edge.highway === 'living_street')) continue
      const cache = this.cacheFor(edge, null)
      if (x < cache.minX - tolerance || x > cache.maxX + tolerance
        || y < cache.minY - tolerance || y > cache.maxY + tolerance) continue
      const max = (tolerance + cache.width / 2) ** 2
      const d = distanceToPolylineSq(cache, x, y)
      if (d <= max && d < bestDist) { bestDist = d; best = edge.id }
    }
    return best ? { kind: 'edge', id: best } : null
  }
}

/* ------------------------------------------------------------------ */
/*  Feux : approches et phases vertes                                  */
/* ------------------------------------------------------------------ */

/**
 * Pour chaque contrôleur, la liste de ses approches externes et, pour chaque phase, le fait qu'au moins un
 * de leurs mouvements soit au vert. Calculé une fois par identité de réseau.
 */
export function buildControllerDots(network: Network): Map<ControllerId, ApproachDot[]> {
  const controllers = Object.values(network.controllers)
  const result = new Map<ControllerId, ApproachDot[]>()
  if (!controllers.length) return result
  const adjacency = buildAdjacency(network)
  for (const controller of controllers) {
    const approaches = controllerApproaches(network, controller, adjacency)
    const greenEdges = controller.phases.map((phase) => {
      const set = new Set<EdgeId>()
      for (const key of Object.keys(phase.movements)) set.add(parseMovementKey(key).from)
      return set
    })
    result.set(controller.id, approaches.map((edge) => ({
      edgeId: edge.id,
      greenByPhase: greenEdges.map((set) => set.has(edge.id)),
    })))
  }
  return result
}
