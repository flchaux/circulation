/**
 * Validation et migration du JSON de projet (§3 et §6 de docs/ARCHITECTURE.md).
 *
 * Principe : les erreurs (en français) portent sur ce qui ne peut pas être réparé sans perdre du sens —
 * enveloppe (`format`/`version`), références croisées (tronçon vers un nœud inconnu, régulation vers un
 * contrôleur inconnu) et coordonnées de la projection. Tout le reste (valeurs numériques absurdes, champs
 * facultatifs manquants, longueurs incohérentes) est normalisé silencieusement : un fichier exporté par une
 * version antérieure ou édité à la main reste chargeable.
 *
 * `validateProject` ne modifie jamais la valeur reçue : elle reconstruit un `Project` neuf.
 */
import type {
  ChangeLogEntry, CommuneInfo, ControlType, ControllerId, Demand, EdgeId, EntryConfig, ExitConfig, GeoMultiPolygon,
  GeoPolygon, GreenKind, HighwayClass, MovementKey, NetEdge, NetNode, Network, NodeControl, NodeId, Project,
  ProjectMeta, ReferenceSnapshot, SignalController, SignalMode, SignalPhase, SimResults, SimSettings,
} from './types'
import { HIGHWAY_CLASSES, PROJECT_FORMAT, PROJECT_VERSION } from './types'
import type { ImportStats } from '@/geo/types'
import { ATTRIBUTION, DEFAULT_SETTINGS } from './defaults'
import { polylineLength } from './geometry'

/* ------------------------------------------------------------------ */
/*  Collecte des erreurs                                               */
/* ------------------------------------------------------------------ */

const MAX_ERRORS = 20

class ErrorList {
  private readonly list: string[] = []
  private hidden = 0

  add(message: string): void {
    if (this.list.length < MAX_ERRORS) this.list.push(message)
    else this.hidden++
  }

  get empty(): boolean {
    return this.list.length === 0
  }

  toArray(): string[] {
    return this.hidden ? [...this.list, `… et ${this.hidden} autre(s) erreur(s).`] : [...this.list]
  }
}

/* ------------------------------------------------------------------ */
/*  Coercitions élémentaires                                           */
/* ------------------------------------------------------------------ */

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** Nombre ≥ `min` (repli si absent, non fini ou hors borne). */
function numMin(v: unknown, fallback: number, min: number): number {
  const n = num(v, fallback)
  return n >= min ? n : fallback
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function numArray(v: unknown): number[] {
  return Array.isArray(v) ? v.map((x) => num(x, 0)) : []
}

function oneOf<T extends string>(v: unknown, values: readonly T[], fallback: T): T {
  return typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : fallback
}

function isoDate(v: unknown): string {
  const s = typeof v === 'string' ? v : ''
  return s && !Number.isNaN(Date.parse(s)) ? s : new Date().toISOString()
}

const CONTROL_TYPES: ControlType[] = ['signals', 'stop', 'give_way', 'priority_right', 'priority_class', 'roundabout']
const SIGNAL_MODES: SignalMode[] = ['fixed', 'actuated', 'flashing', 'off']

/* ------------------------------------------------------------------ */
/*  Réseau                                                             */
/* ------------------------------------------------------------------ */

function validateNodes(raw: unknown, errors: ErrorList, path: string): Record<NodeId, NetNode> {
  const src = rec(raw)
  const nodes: Record<NodeId, NetNode> = {}
  if (!src) {
    errors.add(`${path} : liste de nœuds manquante ou invalide.`)
    return nodes
  }
  for (const [id, value] of Object.entries(src)) {
    const r = rec(value)
    if (!r) {
      errors.add(`${path}["${id}"] : nœud invalide.`)
      continue
    }
    if (typeof r.x !== 'number' || !Number.isFinite(r.x) || typeof r.y !== 'number' || !Number.isFinite(r.y)) {
      errors.add(`${path}["${id}"] : coordonnées locales (x, y) manquantes ou invalides.`)
      continue
    }
    const node: NetNode = { id, x: r.x, y: r.y, boundary: bool(r.boundary, false) }
    const osmId = num(r.osmId, NaN)
    if (Number.isFinite(osmId)) node.osmId = osmId
    const label = optStr(r.label)
    if (label) node.label = label
    if (r.miniRoundabout === true) node.miniRoundabout = true
    nodes[id] = node
  }
  return nodes
}

function validateEdges(
  raw: unknown,
  nodes: Record<NodeId, NetNode>,
  errors: ErrorList,
  path: string,
): Record<EdgeId, NetEdge> {
  const src = rec(raw)
  const edges: Record<EdgeId, NetEdge> = {}
  if (!src) {
    errors.add(`${path} : liste de tronçons manquante ou invalide.`)
    return edges
  }
  for (const [id, value] of Object.entries(src)) {
    const r = rec(value)
    if (!r) {
      errors.add(`${path}["${id}"] : tronçon invalide.`)
      continue
    }
    const from = str(r.from, '')
    const to = str(r.to, '')
    if (!nodes[from] || !nodes[to]) {
      errors.add(`${path}["${id}"] : le tronçon référence un nœud inconnu ("${from}" → "${to}").`)
      continue
    }
    const highway = oneOf<HighwayClass>(r.highway, HIGHWAY_CLASSES, 'unclassified')
    if (typeof r.highway === 'string' && !(HIGHWAY_CLASSES as string[]).includes(r.highway)) {
      errors.add(`${path}["${id}"] : classe de voie inconnue « ${r.highway} ».`)
      continue
    }
    // Géométrie : points valides uniquement, extrémités recalées sur les nœuds (invariant du modèle),
    // longueur toujours recalculée pour rester cohérente avec la polyligne.
    const rawGeometry = Array.isArray(r.geometry) ? r.geometry : []
    const geometry: [number, number][] = []
    for (const p of rawGeometry) {
      if (Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number'
        && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
        geometry.push([p[0], p[1]])
      }
    }
    if (geometry.length < 2) {
      geometry.length = 0
      geometry.push([nodes[from].x, nodes[from].y], [nodes[to].x, nodes[to].y])
    } else {
      geometry[0] = [nodes[from].x, nodes[from].y]
      geometry[geometry.length - 1] = [nodes[to].x, nodes[to].y]
    }
    const estimated = rec(r.estimated)
    const edge: NetEdge = {
      id,
      from,
      to,
      highway,
      lanes: Math.max(1, Math.round(numMin(r.lanes, 1, 1))),
      maxspeed: numMin(r.maxspeed, 50, 1),
      length: polylineLength(geometry),
      geometry,
      roundabout: bool(r.roundabout, false),
      closed: bool(r.closed, false),
      bannedTo: strArray(r.bannedTo),
      estimated: {
        lanes: bool(estimated?.lanes, false),
        maxspeed: bool(estimated?.maxspeed, false),
      },
    }
    const name = optStr(r.name)
    if (name) edge.name = name
    const osmWayId = num(r.osmWayId, NaN)
    if (Number.isFinite(osmWayId)) edge.osmWayId = osmWayId
    const reverseOf = optStr(r.reverseOf)
    if (reverseOf) edge.reverseOf = reverseOf
    edges[id] = edge
  }
  // Références entre tronçons : nettoyées ici, la symétrie de `reverseOf` est rétablie par `sanitizeNetwork`.
  for (const edge of Object.values(edges)) {
    edge.bannedTo = edge.bannedTo.filter((b) => edges[b])
    if (edge.reverseOf && !edges[edge.reverseOf]) delete edge.reverseOf
  }
  return edges
}

function validatePhase(raw: unknown, index: number, errors: ErrorList, path: string): SignalPhase {
  const r = rec(raw) ?? {}
  if (!rec(raw)) errors.add(`${path} : phase invalide, remplacée par une phase vide.`)
  const movements: Record<MovementKey, GreenKind> = {}
  const mv = rec(r.movements)
  if (mv) {
    for (const [key, kind] of Object.entries(mv)) {
      if (kind === 'protected' || kind === 'permitted') movements[key] = kind
    }
  }
  const phase: SignalPhase = {
    id: str(r.id, `p${index + 1}`),
    name: str(r.name, `Phase ${index + 1}`),
    green: numMin(r.green, 20, 0),
    movements,
    minGreen: numMin(r.minGreen, 7, 0),
    maxGreen: numMin(r.maxGreen, 60, 0),
    gap: numMin(r.gap, 3, 0),
  }
  if (typeof r.amber === 'number' && Number.isFinite(r.amber) && r.amber >= 0) phase.amber = r.amber
  if (typeof r.allRed === 'number' && Number.isFinite(r.allRed) && r.allRed >= 0) phase.allRed = r.allRed
  return phase
}

function validateControllers(
  raw: unknown,
  nodes: Record<NodeId, NetNode>,
  errors: ErrorList,
  path: string,
): Record<ControllerId, SignalController> {
  const src = rec(raw)
  const controllers: Record<ControllerId, SignalController> = {}
  if (!src) return controllers
  for (const [id, value] of Object.entries(src)) {
    const r = rec(value)
    if (!r) {
      errors.add(`${path}["${id}"] : contrôleur de feux invalide.`)
      continue
    }
    const nodeIds = [...new Set(strArray(r.nodeIds).filter((n) => nodes[n]))]
    const phases = (Array.isArray(r.phases) ? r.phases : [])
      .map((p, i) => validatePhase(p, i, errors, `${path}["${id}"].phases[${i}]`))
    const actuated = rec(r.actuated)
    controllers[id] = {
      id,
      name: str(r.name, 'Carrefour à feux'),
      nodeIds,
      mode: oneOf<SignalMode>(r.mode, SIGNAL_MODES, 'fixed'),
      offset: numMin(r.offset, 0, 0),
      amber: numMin(r.amber, 3, 0),
      allRed: numMin(r.allRed, 2, 0),
      phases,
      actuated: { skipEmpty: bool(actuated?.skipEmpty, true) },
    }
  }
  return controllers
}

function validateControls(
  raw: unknown,
  nodes: Record<NodeId, NetNode>,
  edges: Record<EdgeId, NetEdge>,
  controllers: Record<ControllerId, SignalController>,
  errors: ErrorList,
  path: string,
): Record<NodeId, NodeControl> {
  const src = rec(raw)
  const controls: Record<NodeId, NodeControl> = {}
  if (!src) return controls
  for (const [nodeId, value] of Object.entries(src)) {
    const r = rec(value)
    if (!r) {
      errors.add(`${path}["${nodeId}"] : régulation invalide.`)
      continue
    }
    if (!nodes[nodeId]) continue // nœud disparu : régulation sans objet, comme dans sanitizeNetwork
    if (typeof r.type !== 'string' || !(CONTROL_TYPES as string[]).includes(r.type)) {
      errors.add(`${path}["${nodeId}"] : type de régulation inconnu « ${String(r.type)} ».`)
      continue
    }
    const control: NodeControl = { nodeId, type: r.type as ControlType }
    const yieldEdges = strArray(r.yieldEdges).filter((e) => edges[e])
    if (yieldEdges.length) control.yieldEdges = yieldEdges
    if (control.type === 'signals') {
      const controllerId = optStr(r.controllerId)
      if (!controllerId || !controllers[controllerId]) {
        errors.add(`${path}["${nodeId}"] : feux sans contrôleur connu (« ${String(r.controllerId)} »).`)
        continue
      }
      control.controllerId = controllerId
    }
    controls[nodeId] = control
  }
  return controls
}

function validateNetwork(raw: unknown, errors: ErrorList, path: string): Network {
  const src = rec(raw)
  if (!src) {
    errors.add(`${path} : réseau manquant ou invalide.`)
    return { nodes: {}, edges: {}, controls: {}, controllers: {} }
  }
  const nodes = validateNodes(src.nodes, errors, `${path}.nodes`)
  const edges = validateEdges(src.edges, nodes, errors, `${path}.edges`)
  const controllers = validateControllers(src.controllers, nodes, errors, `${path}.controllers`)
  const controls = validateControls(src.controls, nodes, edges, controllers, errors, `${path}.controls`)
  return { nodes, edges, controls, controllers }
}

/* ------------------------------------------------------------------ */
/*  Demande et réglages                                                */
/* ------------------------------------------------------------------ */

function validateDemand(raw: unknown, errors: ErrorList, path: string): Demand {
  const src = rec(raw)
  if (!src) errors.add(`${path} : demande manquante ou invalide.`)
  const r = src ?? {}
  const entries: Record<NodeId, EntryConfig> = {}
  for (const [id, value] of Object.entries(rec(r.entries) ?? {})) {
    const e = rec(value)
    if (!e) continue
    const entry: EntryConfig = {
      flow: numMin(e.flow, 0, 0),
      enabled: bool(e.enabled, true),
      estimated: bool(e.estimated, false),
    }
    const label = optStr(e.label)
    if (label) entry.label = label
    entries[id] = entry
  }
  const exits: Record<NodeId, ExitConfig> = {}
  for (const [id, value] of Object.entries(rec(r.exits) ?? {})) {
    const e = rec(value)
    if (!e) continue
    const exit: ExitConfig = { weight: numMin(e.weight, 0, 0), enabled: bool(e.enabled, true) }
    const label = optStr(e.label)
    if (label) exit.label = label
    exits[id] = exit
  }
  const od: Demand['od'] = {}
  for (const [entryId, row] of Object.entries(rec(r.od) ?? {})) {
    const cells = rec(row)
    if (!cells) continue
    const cleaned: Record<NodeId, number> = {}
    for (const [exitId, share] of Object.entries(cells)) {
      const v = numMin(share, 0, 0)
      if (v > 0) cleaned[exitId] = v
    }
    if (Object.keys(cleaned).length) od[entryId] = cleaned
  }
  const internal = rec(r.internal) ?? {}
  const demand: Demand = {
    seed: Math.round(num(r.seed, 42)),
    globalFactor: numMin(r.globalFactor, 1, 0),
    entries,
    exits,
    destinationMode: oneOf(r.destinationMode, ['weights', 'od'] as const, 'weights'),
    od,
    internal: {
      enabled: bool(internal.enabled, false),
      generationRate: numMin(internal.generationRate, 300, 0),
      internalDestinationShare: Math.min(1, numMin(internal.internalDestinationShare, 0.5, 0)),
      entryInternalShare: Math.min(1, numMin(internal.entryInternalShare, 0.2, 0)),
    },
  }
  const csv = rec(r.csvImport)
  if (csv) {
    demand.csvImport = {
      fileName: str(csv.fileName, 'import.csv'),
      importedAt: isoDate(csv.importedAt),
      rows: Math.max(0, Math.round(num(csv.rows, 0))),
    }
  }
  return demand
}

function validateSettings(raw: unknown): SimSettings {
  const r = rec(raw) ?? {}
  const gap = rec(r.criticalGap) ?? {}
  const D = DEFAULT_SETTINGS
  return {
    durationMin: numMin(r.durationMin, D.durationMin, 1),
    warmupMin: numMin(r.warmupMin, D.warmupMin, 0),
    dt: 1, // le moteur travaille au pas de 1 s (contrat du modèle)
    dynamicRouting: bool(r.dynamicRouting, D.dynamicRouting),
    routingIntervalMin: numMin(r.routingIntervalMin, D.routingIntervalMin, 0.1),
    saturationFlow: numMin(r.saturationFlow, D.saturationFlow, 100),
    vehicleLength: numMin(r.vehicleLength, D.vehicleLength, 1),
    startupLostTime: numMin(r.startupLostTime, D.startupLostTime, 0),
    amberUsable: numMin(r.amberUsable, D.amberUsable, 0),
    criticalGap: {
      stop: numMin(gap.stop, D.criticalGap.stop, 0.1),
      giveWay: numMin(gap.giveWay, D.criticalGap.giveWay, 0.1),
      priorityRight: numMin(gap.priorityRight, D.criticalGap.priorityRight, 0.1),
      roundabout: numMin(gap.roundabout, D.criticalGap.roundabout, 0.1),
      permittedLeft: numMin(gap.permittedLeft, D.criticalGap.permittedLeft, 0.1),
    },
    followUpTime: numMin(r.followUpTime, D.followUpTime, 0.1),
    stopDelay: numMin(r.stopDelay, D.stopDelay, 0),
    statsIntervalMin: numMin(r.statsIntervalMin, D.statsIntervalMin, 0.1),
  }
}

/* ------------------------------------------------------------------ */
/*  Résultats (données dérivées : normalisées, jamais bloquantes)      */
/* ------------------------------------------------------------------ */

function validateResults(raw: unknown, errors: ErrorList, path: string): SimResults | undefined {
  const r = rec(raw)
  if (!r) {
    errors.add(`${path} : résultats de simulation invalides.`)
    return undefined
  }
  const net = rec(r.network) ?? {}
  const edges: SimResults['edges'] = {}
  for (const [id, value] of Object.entries(rec(r.edges) ?? {})) {
    const e = rec(value)
    if (!e) continue
    edges[id] = {
      entered: num(e.entered, 0), exited: num(e.exited, 0), flowVehH: num(e.flowVehH, 0),
      meanSpeedKmh: num(e.meanSpeedKmh, 0), meanTravelTimeS: num(e.meanTravelTimeS, 0),
      // `totalDelayS` est apparu après la version 1 initiale : un fichier antérieur ne le porte pas,
      // on le reconstitue depuis le retard moyen et le nombre de véhicules entrés.
      totalDelayS: num(e.totalDelayS, num(e.meanDelayS, 0) * num(e.entered, 0)),
      meanDelayS: num(e.meanDelayS, 0), maxQueue: num(e.maxQueue, 0), meanQueue: num(e.meanQueue, 0),
      saturation: num(e.saturation, 0),
    }
  }
  const exits: SimResults['exits'] = {}
  for (const [id, value] of Object.entries(rec(r.exits) ?? {})) {
    const e = rec(value)
    if (!e) continue
    exits[id] = {
      count: num(e.count, 0), flowVehH: num(e.flowVehH, 0),
      meanTravelTimeS: num(e.meanTravelTimeS, 0), meanDelayS: num(e.meanDelayS, 0),
    }
  }
  const intersections: SimResults['intersections'] = {}
  for (const [id, value] of Object.entries(rec(r.intersections) ?? {})) {
    const node = rec(value)
    if (!node) continue
    const approaches: Record<EdgeId, { vehicles: number; meanDelayS: number; maxQueue: number }> = {}
    for (const [edgeId, a] of Object.entries(rec(node.approaches) ?? {})) {
      const ap = rec(a)
      if (!ap) continue
      approaches[edgeId] = { vehicles: num(ap.vehicles, 0), meanDelayS: num(ap.meanDelayS, 0), maxQueue: num(ap.maxQueue, 0) }
    }
    intersections[id] = { approaches }
  }
  const s = rec(r.series) ?? {}
  const seriesEdges: SimResults['series']['edges'] = {}
  for (const [id, value] of Object.entries(rec(s.edges) ?? {})) {
    const e = rec(value)
    if (!e) continue
    seriesEdges[id] = { flow: numArray(e.flow), delay: numArray(e.delay), queue: numArray(e.queue) }
  }
  const seriesExits: SimResults['series']['exits'] = {}
  for (const [id, value] of Object.entries(rec(s.exits) ?? {})) {
    const e = rec(value)
    if (!e) continue
    seriesExits[id] = { count: numArray(e.count) }
  }
  const sn = rec(s.network) ?? {}
  return {
    seed: num(r.seed, 0),
    durationS: num(r.durationS, 0),
    warmupS: num(r.warmupS, 0),
    intervalS: num(r.intervalS, 0),
    reachedS: num(r.reachedS, 0),
    completed: bool(r.completed, false),
    network: {
      entered: num(net.entered, 0), exited: num(net.exited, 0), inCirculation: num(net.inCirculation, 0),
      notInjected: num(net.notInjected, 0), totalDelayS: num(net.totalDelayS, 0), meanDelayS: num(net.meanDelayS, 0),
      meanTravelTimeS: num(net.meanTravelTimeS, 0), vehKm: num(net.vehKm, 0),
    },
    edges,
    exits,
    intersections,
    series: {
      times: numArray(s.times),
      edges: seriesEdges,
      exits: seriesExits,
      network: {
        entered: numArray(sn.entered), exited: numArray(sn.exited),
        inCirculation: numArray(sn.inCirculation), meanDelay: numArray(sn.meanDelay),
      },
    },
    warnings: strArray(r.warnings),
  }
}

/* ------------------------------------------------------------------ */
/*  Métadonnées                                                        */
/* ------------------------------------------------------------------ */

function validateMeta(raw: unknown, errors: ErrorList, path: string): ProjectMeta {
  const r = rec(raw) ?? {}
  if (!rec(raw)) errors.add(`${path} : métadonnées manquantes ou invalides.`)
  const centre = rec(r.center)
  if (!centre || typeof centre.lon !== 'number' || typeof centre.lat !== 'number'
    || !Number.isFinite(centre.lon) || !Number.isFinite(centre.lat)) {
    errors.add(`${path}.center : origine de la projection (lon, lat) manquante ou invalide.`)
  }
  const meta: ProjectMeta = {
    id: str(r.id, `p${Date.now().toString(36)}`),
    name: str(r.name, 'Projet sans nom'),
    createdAt: isoDate(r.createdAt),
    updatedAt: isoDate(r.updatedAt),
    center: { lon: num(centre?.lon, 0), lat: num(centre?.lat, 0) },
    attribution: str(r.attribution, ATTRIBUTION),
  }
  const commune = rec(r.commune)
  if (commune) {
    const info: CommuneInfo = {
      nom: str(commune.nom, ''),
      code: str(commune.code, ''),
      codesPostaux: strArray(commune.codesPostaux),
    }
    const population = num(commune.population, NaN)
    if (Number.isFinite(population)) info.population = population
    meta.commune = info
  }
  const contour = rec(r.contour)
  if (contour && (contour.type === 'Polygon' || contour.type === 'MultiPolygon') && Array.isArray(contour.coordinates)) {
    // Les anneaux ne sont pas revalidés point par point : ils ne servent qu'à l'affichage et au découpage OSM.
    meta.contour = contour as unknown as GeoPolygon | GeoMultiPolygon
  }
  const extractedAt = optStr(r.extractedAt)
  if (extractedAt) meta.extractedAt = extractedAt
  const imported = rec(r.import)
  if (imported) {
    const stats = rec(imported.stats) ?? {}
    const keys: (keyof ImportStats)[] = [
      'ways', 'edges', 'nodes', 'entries', 'exits', 'signals', 'controllers', 'stops', 'giveWays', 'restrictions',
      'droppedEdges', 'warnings',
    ]
    const clean = {} as ImportStats
    for (const k of keys) clean[k] = num(stats[k], 0)
    meta.import = { stats: clean, warnings: strArray(imported.warnings) }
  }
  return meta
}

function validateChanges(raw: unknown): ChangeLogEntry[] {
  if (!Array.isArray(raw)) return []
  const out: ChangeLogEntry[] = []
  for (const value of raw) {
    const r = rec(value)
    if (!r) continue
    out.push({ at: isoDate(r.at), label: str(r.label, '') })
  }
  return out
}

function validateReference(raw: unknown, errors: ErrorList, path: string): ReferenceSnapshot | undefined {
  const r = rec(raw)
  if (!r) {
    errors.add(`${path} : scénario de référence invalide.`)
    return undefined
  }
  const snapshot: ReferenceSnapshot = {
    frozenAt: isoDate(r.frozenAt),
    label: str(r.label, 'Référence'),
    network: validateNetwork(r.network, errors, `${path}.network`),
    demand: validateDemand(r.demand, errors, `${path}.demand`),
    settings: validateSettings(r.settings),
  }
  if (r.results !== undefined) {
    const results = validateResults(r.results, errors, `${path}.results`)
    if (results) snapshot.results = results
  }
  return snapshot
}

/* ------------------------------------------------------------------ */
/*  Migrations                                                         */
/* ------------------------------------------------------------------ */

/**
 * Migrations d'une version vers la suivante. La version 1 est le premier format publié : la table est vide
 * aujourd'hui, mais tout ajout d'une version 2 devra y déclarer `1: (raw) => …`.
 */
const MIGRATIONS: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> = {}

/* ------------------------------------------------------------------ */
/*  Entrée publique                                                    */
/* ------------------------------------------------------------------ */

export function validateProject(value: unknown): { ok: true; project: Project } | { ok: false; errors: string[] } {
  const root = rec(value)
  if (!root) return { ok: false, errors: ['Le fichier ne contient pas un objet JSON de projet.'] }
  if (root.format !== PROJECT_FORMAT) {
    return {
      ok: false,
      errors: [`Format inattendu : « ${String(root.format ?? 'absent')} » au lieu de « ${PROJECT_FORMAT} ».`],
    }
  }
  const version = num(root.version, NaN)
  if (!Number.isInteger(version) || version < 1) {
    return { ok: false, errors: [`Version de projet illisible : « ${String(root.version)} ».`] }
  }
  if (version > PROJECT_VERSION) {
    return {
      ok: false,
      errors: [`Ce projet a été enregistré par une version plus récente de l'application (version ${version}, `
        + `maximum pris en charge : ${PROJECT_VERSION}).`],
    }
  }
  let migrated = root
  for (let v = version; v < PROJECT_VERSION; v++) {
    const step = MIGRATIONS[v]
    if (!step) return { ok: false, errors: [`Aucune migration disponible depuis la version ${v}.`] }
    migrated = step(migrated)
  }

  const errors = new ErrorList()
  const meta = validateMeta(migrated.meta, errors, 'meta')
  const network = validateNetwork(migrated.network, errors, 'network')
  const demand = validateDemand(migrated.demand, errors, 'demand')
  const settings = validateSettings(migrated.settings)
  const project: Project = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    meta,
    network,
    demand,
    settings,
    changes: validateChanges(migrated.changes),
  }
  if (migrated.reference !== undefined) {
    const reference = validateReference(migrated.reference, errors, 'reference')
    if (reference) project.reference = reference
  }
  if (migrated.lastResults !== undefined) {
    const results = validateResults(migrated.lastResults, errors, 'lastResults')
    if (results) project.lastResults = results
  }
  if (!errors.empty) return { ok: false, errors: errors.toArray() }
  return { ok: true, project }
}
