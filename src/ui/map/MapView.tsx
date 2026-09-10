/**
 * Carte interactive : fond Leaflet (tuiles OpenStreetMap) surmonté de deux canvas.
 *
 * Répartition des rôles (voir §7 de docs/ARCHITECTURE.md) :
 *  - canvas *statique* : tronçons, nœuds, étiquettes, itinéraires comparés, surbrillance de la sélection, glisser en cours.
 *    Redessiné uniquement quand la scène change d'identité (réseau, mode de couleur, sélection, résultats, glisser)
 *    ou quand le cadrage change (`moveend`, `zoomend`, redimensionnement).
 *  - canvas *dynamique* : véhicules, points d'état des feux, survol, chemin de l'outil en cours.
 *    Redessiné par `requestAnimationFrame` tant que la simulation tourne, sinon à la demande.
 *
 * Le composant ne se re-rend pas à chaque frame : il lit le store hors React
 * (`useAppStore.getState()` / `useAppStore.subscribe`) et ne garde dans l'état React que ce qui
 * pilote la légende et les cases à cocher.
 */
import { useEffect, useMemo, useRef } from 'react'
import type { JSX } from 'react'
import L from 'leaflet'
import { useAppStore } from '@/state/store'
import { createProjection } from '@/geo/projection'
import { shortestPathNodes } from '@/engine/routing'
import type { AppState, MapTool, Selection } from '@/state/storeTypes'
import type { NodeId } from '@/model/types'
import {
  HIT_TOLERANCE_PX, MERGE_TOLERANCE_PX, MapRenderer, VehicleInterpolator,
  type MapScene, type RendererView,
} from './renderer'
import { CLASS_LABELS, HIGHWAY_COLORS, LEGEND_CLASSES, scaleFor } from './colors'
import { S, formatNumber } from '@/ui/strings'

/** Marge (px) dont les canvas débordent du conteneur, pour rester couvrants pendant un déplacement. */
const CANVAS_PADDING = 220

/** Zoom appliqué quand la carte se recentre sur un élément sélectionné depuis un tableau. */
const REVEAL_ZOOM = 17

/** Déplacement (px) au-delà duquel un appui devient un glisser plutôt qu'un clic. */
const DRAG_THRESHOLD_PX = 3

type LatLngLike = { lat: number; lng: number }

/**
 * Effet d'un clic simple sur la carte.
 *  - `select`   : sélectionner l'élément cliqué (ou vider la sélection) ;
 *  - `toolNode` : clic de nœud d'un outil à deux clics (onde verte, itinéraires, ajout de tronçon) ;
 *  - `addNode`  : poser un nœud à l'endroit cliqué ;
 *  - `none`     : clic ignoré (outil à deux clics, hors de tout nœud).
 */
export type MapClickAction =
  | { kind: 'select'; selection: Selection }
  | { kind: 'toolNode'; nodeId: NodeId }
  | { kind: 'addNode' }
  | { kind: 'none' }

/**
 * Décide de l'effet d'un clic selon l'outil actif, à partir du seul résultat du test de sélection.
 *
 * Extraite du gestionnaire d'événements pour être vérifiable sans navigateur : c'est ici que les outils
 * se séparent, l'outil `addNode` agissant sur un clic **n'importe où** là où les deux autres attendent un
 * clic de nœud.
 */
export function mapClickAction(tool: MapTool, hit: Selection): MapClickAction {
  if (tool === 'select') return { kind: 'select', selection: hit }
  // Les nœuds priment sur les tronçons dans `hitTest` : un `hit` de nœud est le nœud cliqué.
  const node = hit?.kind === 'node' ? hit.id : null
  if (tool === 'addNode') {
    // Poser un nœud sur un nœud existant en empilerait deux au même point, impossibles à distinguer
    // ensuite sur la carte. Le clic sélectionne alors celui qui est déjà là : c'est ce que l'on veut
    // pour le raccorder.
    return node ? { kind: 'select', selection: { kind: 'node', id: node } } : { kind: 'addNode' }
  }
  return node ? { kind: 'toolNode', nodeId: node } : { kind: 'none' }
}

/** Libellé du bandeau rappelant l'outil actif (et permettant d'en sortir). */
const OUTIL_ACTIF: Record<Exclude<MapTool, 'select'>, string> = {
  greenwave: S.carte.outilOndeVerteActif,
  itineraires: S.carte.outilItinerairesActif,
  passage: S.carte.outilPassageActif,
  addEdge: S.carte.outilAjoutTronconActif,
  addNode: S.carte.outilPoseNoeudActif,
}

/** Leaflet n'expose pas d'API publique pour suivre l'animation de zoom ; c'est la méthode qu'utilise son propre renderer. */
interface ZoomAnimMap extends L.Map {
  _latLngToNewLayerPoint?(latlng: LatLngLike, zoom: number, center: LatLngLike): L.Point
}

export function MapView(): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const colorMode = useAppStore((s) => s.ui.colorMode)
  const showBaseMap = useAppStore((s) => s.ui.showBaseMap)
  const baseMapOpacity = useAppStore((s) => s.ui.baseMapOpacity)
  const showVehicles = useAppStore((s) => s.ui.showVehicles)
  const showLabels = useAppStore((s) => s.ui.showLabels)
  const tool = useAppStore((s) => s.ui.tool)
  const results = useAppStore((s) => s.sim.results)
  const reference = useAppStore((s) => s.project?.reference?.results ?? null)
  const setUi = useAppStore((s) => s.setUi)
  const setTool = useAppStore((s) => s.setTool)

  const legend = useMemo(() => scaleFor(colorMode, results, reference), [colorMode, results, reference])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    /* ---------------------------------------------------------------- */
    /*  Carte, calques                                                   */
    /* ---------------------------------------------------------------- */

    const map = L.map(container, {
      zoomControl: true,
      attributionControl: true,
      preferCanvas: true,
      // La molette zoome ; le glisser de la carte est suspendu pendant le déplacement d'un nœud.
      zoomSnap: 0.5,
      wheelPxPerZoomLevel: 90,
    })
    const store = useAppStore
    const initial = store.getState().project
    const center = initial?.meta.center ?? { lon: 4.29, lat: 45.5616 }
    map.setView([center.lat, center.lon], 14)

    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">les contributeurs OpenStreetMap</a>',
    })
    tiles.addTo(map)

    const pane = map.getPanes().overlayPane
    const staticCanvas = document.createElement('canvas')
    const dynamicCanvas = document.createElement('canvas')
    staticCanvas.className = 'carte-canvas carte-canvas--statique'
    dynamicCanvas.className = 'carte-canvas carte-canvas--dynamique'
    pane.appendChild(staticCanvas)
    pane.appendChild(dynamicCanvas)

    const staticCtx = staticCanvas.getContext('2d')
    const dynamicCtx = dynamicCanvas.getContext('2d')
    if (staticCtx === null || dynamicCtx === null) {
      map.remove()
      return
    }
    const ctxStatic: CanvasRenderingContext2D = staticCtx
    const ctxDynamic: CanvasRenderingContext2D = dynamicCtx
    const renderer = new MapRenderer(ctxStatic, ctxDynamic)
    const interpolator = new VehicleInterpolator()

    /* ---------------------------------------------------------------- */
    /*  Cadrage : conversion mètres locaux → pixels absolus Leaflet       */
    /* ---------------------------------------------------------------- */

    let projection = createProjection(center)
    /** Coin haut-gauche des canvas, en coordonnées du conteneur. */
    const canvasCorner = L.point(-CANVAS_PADDING, -CANVAS_PADDING)
    /** LatLng de ce coin au dernier cadrage : sert à replacer les canvas pendant l'animation de zoom. */
    let cornerLatLng = map.containerPointToLatLng(canvasCorner)
    let dpr = 1

    function currentView(): RendererView {
      const zoom = map.getZoom()
      const size = map.getSize()
      const width = size.x + CANVAS_PADDING * 2
      const height = size.y + CANVAS_PADDING * 2
      // Pixel absolu (dans le référentiel du zoom courant) du coin haut-gauche des canvas.
      const originPoint = map.project(cornerLatLng, zoom)
      const project = (x: number, y: number): [number, number] => {
        const { lon, lat } = projection.toLonLat(x, y)
        const p = map.project(L.latLng(lat, lon), zoom)
        return [p.x, p.y]
      }
      const [ax] = project(0, 0)
      const [bx] = project(1000, 0)
      return {
        zoom,
        originX: originPoint.x,
        originY: originPoint.y,
        offsetX: canvasCorner.x,
        offsetY: canvasCorner.y,
        width,
        height,
        pxPerMeter: Math.abs(bx - ax) / 1000,
        project,
      }
    }

    /** Replace et redimensionne les canvas, puis met à jour le cadrage du renderer. */
    function syncCanvas(): void {
      const size = map.getSize()
      const width = size.x + CANVAS_PADDING * 2
      const height = size.y + CANVAS_PADDING * 2
      dpr = Math.min(2, window.devicePixelRatio || 1)
      for (const canvas of [staticCanvas, dynamicCanvas]) {
        if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
          canvas.width = Math.round(width * dpr)
          canvas.height = Math.round(height * dpr)
          canvas.style.width = `${width}px`
          canvas.style.height = `${height}px`
        }
        canvas.style.transform = ''
        L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint(canvasCorner))
      }
      ctxStatic.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctxDynamic.setTransform(dpr, 0, 0, dpr, 0, 0)
      renderer.setView(currentView())
    }

    /* ---------------------------------------------------------------- */
    /*  Scène                                                            */
    /* ---------------------------------------------------------------- */

    /** Nœuds du chemin prévisualisé par l'outil en cours (onde verte, ajout de tronçon). */
    let toolPath: NodeId[] = []
    let toolPathKey = ''

    function buildScene(state: AppState): MapScene | null {
      const project = state.project
      if (!project) return null
      return {
        network: project.network,
        colorMode: state.ui.colorMode,
        results: state.sim.results,
        reference: project.reference?.results ?? null,
        selection: state.selection,
        hover: state.hover,
        drag: state.drag,
        showLabels: state.ui.showLabels,
        showVehicles: state.ui.showVehicles,
        tool: state.ui.tool,
        // Périmés (le réseau a changé depuis le calcul), les itinéraires ne sont plus dessinés : le
        // panneau propose alors de les recalculer.
        itineraires: state.ui.itineraires?.perime ? null : state.ui.itineraires,
        toolNodes: state.ui.toolNodes,
        toolPath,
        frame: state.sim.frame,
        edgeIndex: state.sim.edgeIndex,
      }
    }

    /**
     * Met à jour la prévisualisation du chemin entre le premier nœud choisi et le nœud survolé.
     * Le calcul (Dijkstra sur temps libre) n'est refait que si le couple change.
     */
    function updateToolPath(state: AppState): void {
      const project = state.project
      const from = state.ui.toolNodes[0]
      const hover = state.hover?.kind === 'node' ? state.hover.id : null
      if (!project || !from || !hover || from === hover) {
        if (toolPath.length) { toolPath = []; toolPathKey = '' }
        return
      }
      const key = `${state.ui.tool}:${from}>${hover}`
      if (key === toolPathKey) return
      toolPathKey = key
      toolPath = state.ui.tool === 'greenwave' || state.ui.tool === 'itineraires'
        ? shortestPathNodes(project.network, from, hover)
        : [from, hover]
    }

    let staticDirty = true
    let dynamicDirty = true
    let lastFrameRef: MapScene['frame'] = null

    function requestStatic(): void {
      staticDirty = true
      dynamicDirty = true
      schedule()
    }

    function requestDynamic(): void {
      dynamicDirty = true
      schedule()
    }

    let rafId = 0
    function schedule(): void {
      if (rafId) return
      rafId = requestAnimationFrame(tick)
    }

    function tick(now: number): void {
      rafId = 0
      const state = store.getState()
      const scene = buildScene(state)
      if (!scene) {
        ctxStatic.clearRect(0, 0, staticCanvas.width, staticCanvas.height)
        ctxDynamic.clearRect(0, 0, dynamicCanvas.width, dynamicCanvas.height)
        staticDirty = false
        dynamicDirty = false
        return
      }
      if (staticDirty) {
        renderer.drawStatic(scene)
        staticDirty = false
      }
      if (dynamicDirty || state.sim.status === 'running') {
        renderer.drawDynamic(scene, interpolator, now)
        dynamicDirty = false
      }
      // Tant que la simulation tourne, les véhicules sont réanimés à chaque frame.
      if (state.sim.status === 'running') schedule()
    }

    /* ---------------------------------------------------------------- */
    /*  Cadrage initial et recentrages                                   */
    /* ---------------------------------------------------------------- */

    /** Ajuste la vue sur l'emprise du réseau (au chargement d'une commune). */
    function fitNetwork(state: AppState): void {
      const project = state.project
      if (!project) return
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const node of Object.values(project.network.nodes)) {
        if (node.x < minX) minX = node.x
        if (node.x > maxX) maxX = node.x
        if (node.y < minY) minY = node.y
        if (node.y > maxY) maxY = node.y
      }
      if (!Number.isFinite(minX)) {
        map.setView([project.meta.center.lat, project.meta.center.lon], 14)
        return
      }
      const a = projection.toLonLat(minX, minY)
      const b = projection.toLonLat(maxX, maxY)
      map.fitBounds(L.latLngBounds([a.lat, a.lon], [b.lat, b.lon]), { padding: [24, 24] })
    }

    /** Recentre sur l'élément sélectionné (clic dans un tableau de résultats). */
    function revealSelection(state: AppState): void {
      const project = state.project
      const selection = state.selection
      if (!project || !selection) return
      let x: number | null = null
      let y: number | null = null
      if (selection.kind === 'node') {
        const node = project.network.nodes[selection.id]
        if (node) { x = node.x; y = node.y }
      } else if (selection.kind === 'edge') {
        const edge = project.network.edges[selection.id]
        if (edge) {
          const mid = edge.geometry[Math.floor(edge.geometry.length / 2)]
          if (mid) { x = mid[0]; y = mid[1] }
        }
      } else if (selection.kind === 'controller') {
        const controller = project.network.controllers[selection.id]
        const node = controller && project.network.nodes[controller.nodeIds[0]]
        if (node) { x = node.x; y = node.y }
      }
      if (x === null || y === null) return
      const { lon, lat } = projection.toLonLat(x, y)
      map.setView([lat, lon], Math.max(map.getZoom(), REVEAL_ZOOM))
    }

    /* ---------------------------------------------------------------- */
    /*  Abonnement au store                                              */
    /* ---------------------------------------------------------------- */

    let lastNetwork = initial?.network ?? null
    let lastProjectId = initial?.meta.id ?? null
    let lastCenterKey = initial ? `${initial.meta.center.lon},${initial.meta.center.lat}` : ''
    let lastReveal = store.getState().ui.revealCounter

    const unsubscribe = store.subscribe((state) => {
      const project = state.project
      const centerKey = project ? `${project.meta.center.lon},${project.meta.center.lat}` : ''
      if (centerKey !== lastCenterKey) {
        lastCenterKey = centerKey
        if (project) projection = createProjection(project.meta.center)
        if (typeof window !== 'undefined' && window.__circulation) window.__circulation.projection = projection
        renderer.invalidate()
        syncCanvas()
      }
      if (project && project.meta.id !== lastProjectId) {
        lastProjectId = project.meta.id
        interpolator.reset()
        renderer.invalidate()
        fitNetwork(state)
      }
      if (project?.network !== lastNetwork) {
        lastNetwork = project?.network ?? null
        renderer.invalidate()
      }
      if (state.ui.revealCounter !== lastReveal) {
        lastReveal = state.ui.revealCounter
        revealSelection(state)
      }
      if (state.sim.frame && state.sim.frame !== lastFrameRef) {
        lastFrameRef = state.sim.frame
        interpolator.push(state.sim.frame, performance.now())
      }
      if (!state.sim.frame && lastFrameRef) {
        lastFrameRef = null
        interpolator.reset()
      }
      updateToolPath(state)
      requestStatic()
    })

    /* ---------------------------------------------------------------- */
    /*  Événements Leaflet                                               */
    /* ---------------------------------------------------------------- */

    function refreshCorner(): void {
      cornerLatLng = map.containerPointToLatLng(canvasCorner)
    }

    function onViewChanged(): void {
      refreshCorner()
      syncCanvas()
      requestStatic()
    }

    map.on('moveend', onViewChanged)
    map.on('zoomend', onViewChanged)
    map.on('resize', onViewChanged)

    // Pendant l'animation de zoom, les canvas sont transformés comme le fait le renderer de Leaflet,
    // ce qui évite le décalage visible entre le réseau et les tuiles.
    map.on('zoomanim', (event: L.ZoomAnimEvent) => {
      const anim = map as ZoomAnimMap
      if (typeof anim._latLngToNewLayerPoint !== 'function') return
      const scale = map.getZoomScale(event.zoom, map.getZoom())
      const offset = anim._latLngToNewLayerPoint(cornerLatLng, event.zoom, event.center)
      for (const canvas of [staticCanvas, dynamicCanvas]) L.DomUtil.setTransform(canvas, offset, scale)
    })

    /* ---------------------------------------------------------------- */
    /*  Interactions souris et clavier                                   */
    /* ---------------------------------------------------------------- */

    /** Point du conteneur → coordonnées locales en mètres. */
    function toLocal(point: L.Point): [number, number] {
      const latlng = map.containerPointToLatLng(point)
      return projection.toLocal(latlng.lng, latlng.lat)
    }

    let pressPoint: L.Point | null = null
    let pressNode: NodeId | null = null
    let dragging = false

    function onMouseDown(event: MouseEvent): void {
      if (event.button !== 0) return
      const state = store.getState()
      if (!state.project) return
      const point = map.mouseEventToContainerPoint(event)
      pressPoint = point
      dragging = false
      pressNode = state.ui.tool === 'select'
        ? renderer.hitTestNode(state.project.network, point.x, point.y)
        : null
    }

    function onMouseMove(event: MouseEvent): void {
      const state = store.getState()
      if (!state.project) return
      const point = map.mouseEventToContainerPoint(event)

      if (pressNode && pressPoint && !dragging && point.distanceTo(pressPoint) > DRAG_THRESHOLD_PX) {
        dragging = true
        map.dragging.disable()
        state.beginNodeDrag(pressNode)
      }

      if (dragging && pressNode) {
        const [x, y] = toLocal(point)
        const dropOn = renderer.hitTestNode(state.project.network, point.x, point.y, MERGE_TOLERANCE_PX, pressNode)
        state.dragNode(pressNode, x, y, dropOn)
        return
      }

      const hit = renderer.hitTest(state.project.network, point.x, point.y, HIT_TOLERANCE_PX)
      if (!sameSelection(hit, state.hover)) state.setHover(hit)
      // Outil de pose : le curseur en croix annonce que le clic vise un emplacement et non un objet —
      // sauf au-dessus d'un nœud, que ce clic sélectionnerait au lieu d'en empiler un second.
      const viseUnEmplacement = state.ui.tool === 'addNode' && hit?.kind !== 'node'
      container!.style.cursor = viseUnEmplacement ? 'crosshair' : hit ? 'pointer' : ''
    }

    function onMouseUp(event: MouseEvent): void {
      if (event.button !== 0) return
      const state = store.getState()
      const point = map.mouseEventToContainerPoint(event)
      if (dragging && pressNode) {
        const dropOn = state.project
          ? renderer.hitTestNode(state.project.network, point.x, point.y, MERGE_TOLERANCE_PX, pressNode)
          : null
        state.endNodeDrag(pressNode, dropOn ?? undefined)
        map.dragging.enable()
      } else if (pressPoint && point.distanceTo(pressPoint) <= DRAG_THRESHOLD_PX && state.project) {
        const hit = renderer.hitTest(state.project.network, point.x, point.y, HIT_TOLERANCE_PX)
        const action = mapClickAction(state.ui.tool, hit)
        if (action.kind === 'select') state.select(action.selection)
        else if (action.kind === 'toolNode') state.toolClickNode(action.nodeId)
        else if (action.kind === 'addNode') {
          const [x, y] = toLocal(point)
          state.addNode(x, y)
        }
      }
      pressPoint = null
      pressNode = null
      dragging = false
    }

    function onMouseLeave(): void {
      const state = store.getState()
      if (state.hover) state.setHover(null)
    }

    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      const state = store.getState()
      if (event.key === 'Escape') {
        if (state.ui.tool !== 'select') state.setTool('select')
        else state.select(null)
        return
      }
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      const selection = state.selection
      if (!selection) return
      event.preventDefault()
      if (selection.kind === 'node') state.deleteNode(selection.id)
      else if (selection.kind === 'edge') state.deleteEdge(selection.id)
    }

    container.addEventListener('mousedown', onMouseDown)
    container.addEventListener('mousemove', onMouseMove)
    container.addEventListener('mouseleave', onMouseLeave)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('keydown', onKeyDown)

    /* ---------------------------------------------------------------- */
    /*  Démarrage                                                        */
    /* ---------------------------------------------------------------- */

    // Accès à la carte et à la projection depuis la console et les tests de bout en bout.
    if (typeof window !== 'undefined') {
      window.__circulation = { ...(window.__circulation ?? { store }), store, map, projection }
    }

    syncCanvas()
    if (initial) {
      projection = createProjection(initial.meta.center)
      if (window.__circulation) window.__circulation.projection = projection
      renderer.invalidate()
      syncCanvas()
      fitNetwork(store.getState())
    }
    requestStatic()

    const observer = new ResizeObserver(() => {
      map.invalidateSize({ animate: false })
      onViewChanged()
    })
    observer.observe(container)

    return () => {
      if (typeof window !== 'undefined' && window.__circulation) {
        window.__circulation = { store: window.__circulation.store }
      }
      observer.disconnect()
      unsubscribe()
      if (rafId) cancelAnimationFrame(rafId)
      container.removeEventListener('mousedown', onMouseDown)
      container.removeEventListener('mousemove', onMouseMove)
      container.removeEventListener('mouseleave', onMouseLeave)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('keydown', onKeyDown)
      staticCanvas.remove()
      dynamicCanvas.remove()
      map.remove()
    }
  }, [])

  // Opacité et visibilité du fond de carte : appliquées au pane des tuiles sans recréer la carte.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const pane = container.querySelector<HTMLElement>('.leaflet-tile-pane')
    if (pane) {
      pane.style.opacity = showBaseMap ? String(baseMapOpacity) : '0'
    }
  }, [showBaseMap, baseMapOpacity])

  return (
    <div className="carte">
      <div className="carte-conteneur" ref={containerRef} />

      <div className="carte-controles">
        <label className="carte-bascule">
          <input
            type="checkbox"
            checked={showBaseMap}
            onChange={(e) => setUi({ showBaseMap: e.target.checked })}
          />
          {S.carte.fond}
        </label>
        <label className="carte-bascule">
          <input
            type="checkbox"
            checked={showVehicles}
            onChange={(e) => setUi({ showVehicles: e.target.checked })}
          />
          {S.carte.vehicules}
        </label>
        <label className="carte-bascule">
          <input
            type="checkbox"
            checked={showLabels}
            onChange={(e) => setUi({ showLabels: e.target.checked })}
          />
          {S.carte.etiquettes}
        </label>
        {tool !== 'select' && (
          <button type="button" className="carte-outil-actif" onClick={() => setTool('select')}>
            {OUTIL_ACTIF[tool]}
          </button>
        )}
      </div>

      <div className="carte-legende">
        <div className="carte-legende-titre">{legend.label}</div>
        {colorMode === 'class' ? (
          // Échelle qualitative : une pastille par classe de voie, de la plus structurante à la plus locale.
          <div className="carte-legende-classes">
            {LEGEND_CLASSES.map((classe) => (
              <div className="carte-legende-classe" key={classe}>
                <span className="carte-legende-pastille" style={{ background: HIGHWAY_COLORS[classe] }} />
                <span className="carte-legende-nom">{CLASS_LABELS[classe]}</span>
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="carte-legende-bandes">
              {legend.stops.map((stop) => (
                <div className="carte-legende-item" key={`${stop.value}-${stop.color}`}>
                  <span className="carte-legende-pastille" style={{ background: stop.color }} />
                  <span className="carte-legende-valeur">
                    {Number.isFinite(stop.value)
                      ? formatNumber(stop.value, stop.value !== 0 && Math.abs(stop.value) < 10 ? 1 : 0)
                      : ''}
                  </span>
                </div>
              ))}
            </div>
            {legend.unit && <div className="carte-legende-unite">{legend.unit}</div>}
            {!legend.stops.length && <div className="carte-legende-vide">{S.carte.aucuneDonnee}</div>}
          </>
        )}
      </div>
    </div>
  )
}

function sameSelection(a: Selection, b: Selection): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.kind === b.kind && a.id === b.id
}
