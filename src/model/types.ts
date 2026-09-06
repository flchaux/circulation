/**
 * Modèle de données partagé — format JSON du projet (version 1).
 *
 * Conventions :
 *  - Coordonnées locales en mètres (x vers l'est, y vers le nord), projection équirectangulaire
 *    centrée sur `meta.center` (voir src/geo/projection.ts).
 *  - Tous les tronçons (`NetEdge`) sont ORIENTÉS. Une rue à double sens = deux tronçons
 *    liés par `reverseOf`.
 *  - Les identifiants sont des chaînes stables (issues d'OSM ou générées par l'éditeur).
 *  - Les durées sont en secondes, les vitesses en km/h, les débits en véh/h.
 */

import type { ImportStats } from '@/geo/types'

export type NodeId = string
export type EdgeId = string
export type ControllerId = string
/** Mouvement à un carrefour : `${fromEdgeId}>${toEdgeId}` */
export type MovementKey = string

export const PROJECT_FORMAT = 'circulation-project' as const
export const PROJECT_VERSION = 1 as const

export type HighwayClass =
  | 'motorway' | 'trunk' | 'primary' | 'secondary' | 'tertiary'
  | 'unclassified' | 'residential' | 'living_street'
  | 'motorway_link' | 'trunk_link' | 'primary_link' | 'secondary_link' | 'tertiary_link'

export interface NetNode {
  id: NodeId
  x: number
  y: number
  osmId?: number
  /** Nœud situé sur la frontière de la zone : point d'entrée et/ou de sortie du réseau. */
  boundary: boolean
  /** Nom lisible (rues concourantes), calculé à l'import ou saisi. */
  label?: string
  /** Mini-giratoire OSM (highway=mini_roundabout) : priorité à l'anneau simulée sans tronçons circulaires. */
  miniRoundabout?: boolean
}

export interface NetEdge {
  id: EdgeId
  from: NodeId
  to: NodeId
  /** Tronçon de sens opposé sur la même chaussée (rue à double sens). */
  reverseOf?: EdgeId
  osmWayId?: number
  name?: string
  highway: HighwayClass
  /** Nombre de voies dans ce sens (≥ 1). */
  lanes: number
  /** Vitesse libre en km/h. */
  maxspeed: number
  /** Longueur en mètres, recalculée à partir de `geometry` à chaque déplacement de nœud. */
  length: number
  /** Polyligne locale de `from` vers `to`, extrémités égales aux coordonnées des nœuds. */
  geometry: [number, number][]
  /** Fait partie d'un anneau de giratoire (junction=roundabout). */
  roundabout: boolean
  /** Tronçon fermé à la circulation (scénario). */
  closed: boolean
  /** Interdictions de tourner : tronçons sortants interdits au nœud `to`. */
  bannedTo: EdgeId[]
  /** Valeurs estimées (tag OSM absent) — affichées comme telles dans l'interface. */
  estimated: { lanes: boolean; maxspeed: boolean }
}

/**
 * Régulation d'un carrefour.
 *  - signals        : feux, voir `controllerId`
 *  - stop           : les approches `yieldEdges` marquent l'arrêt (toutes si vide)
 *  - give_way       : les approches `yieldEdges` cèdent le passage (toutes si vide)
 *  - priority_right : priorité à droite pure
 *  - priority_class : la voie de classe supérieure est prioritaire, priorité à droite à classe égale (défaut)
 *  - roundabout     : priorité à l'anneau (dérivé des tronçons `roundabout` ou d'un mini-giratoire)
 */
export type ControlType = 'signals' | 'stop' | 'give_way' | 'priority_right' | 'priority_class' | 'roundabout'

export interface NodeControl {
  nodeId: NodeId
  type: ControlType
  yieldEdges?: EdgeId[]
  controllerId?: ControllerId
}

export type SignalMode = 'fixed' | 'actuated' | 'flashing' | 'off'

/** État de vert d'un mouvement dans une phase. Absent de `movements` = rouge. */
export type GreenKind = 'protected' | 'permitted'

export interface SignalPhase {
  id: string
  name: string
  /** Durée de vert (mode fixe). */
  green: number
  /** Orange et rouge intégral propres à la phase (sinon valeurs du contrôleur). */
  amber?: number
  allRed?: number
  /** Mouvements au vert pendant la phase. */
  movements: Record<MovementKey, GreenKind>
  /** Paramètres du mode adaptatif (`actuated`). */
  minGreen: number
  maxGreen: number
  /**
   * Temps de prolongation (détecteur à la ligne d'arrêt) : après `minGreen`, la phase se prolonge tant qu'un véhicule
   * d'une approche verte a franchi la ligne d'arrêt ou est arrivé en tête de file depuis moins de `gap` s, jusqu'à `maxGreen`.
   */
  gap: number
}

export interface SignalController {
  id: ControllerId
  name: string
  /** Nœuds couverts (carrefour regroupé : feux OSM à moins de 30 m). */
  nodeIds: NodeId[]
  mode: SignalMode
  /** Décalage du début de cycle (s) — pour les ondes vertes. */
  offset: number
  amber: number
  allRed: number
  phases: SignalPhase[]
  actuated: {
    /** Sauter les phases sans demande (aucun véhicule en attente ni arrivé sur ses approches). */
    skipEmpty: boolean
  }
}

export interface Network {
  nodes: Record<NodeId, NetNode>
  edges: Record<EdgeId, NetEdge>
  /** Régulation explicite ; un nœud absent utilise `defaultControl()` (src/model/defaults.ts). */
  controls: Record<NodeId, NodeControl>
  controllers: Record<ControllerId, SignalController>
}

/* ----------------------------- Demande ----------------------------- */

export interface EntryConfig {
  /** Débit injecté en véh/h (avant `globalFactor`). */
  flow: number
  enabled: boolean
  /** Valeur par défaut déduite de la classe de voie (pas de comptage). */
  estimated: boolean
  label?: string
}

export interface ExitConfig {
  /** Poids relatif pour le tirage des destinations (mode `weights`). */
  weight: number
  enabled: boolean
  label?: string
}

export interface InternalDemand {
  enabled: boolean
  /** Véhicules générés par heure à l'intérieur de la zone (origine : tronçon interne tiré au sort). */
  generationRate: number
  /** Part (0..1) des trajets d'origine interne qui se terminent aussi dans la zone. */
  internalDestinationShare: number
  /** Part (0..1) du trafic entrant qui se termine dans la zone au lieu d'en sortir. */
  entryInternalShare: number
}

export interface Demand {
  seed: number
  /** Curseur d'intensité global appliqué à tous les débits. */
  globalFactor: number
  entries: Record<NodeId, EntryConfig>
  exits: Record<NodeId, ExitConfig>
  /** `weights` : destinations tirées au prorata des poids de sortie ; `od` : matrice entrée→sortie. */
  destinationMode: 'weights' | 'od'
  /** Matrice origine→destination : parts relatives par ligne (normalisées) ; ligne absente = repli sur les poids. */
  od: Record<NodeId, Record<NodeId, number>>
  internal: InternalDemand
  /** Trace du dernier import CSV. */
  csvImport?: { fileName: string; importedAt: string; rows: number }
}

/* ----------------------------- Réglages ----------------------------- */

export interface SimSettings {
  /** Durée simulée (min) hors chauffe. */
  durationMin: number
  /** Chauffe (min) exclue des statistiques. */
  warmupMin: number
  /** Pas de temps (s), fixe à 1. */
  dt: number
  /** Itinéraires recalculés périodiquement sur les temps de parcours mesurés. */
  dynamicRouting: boolean
  routingIntervalMin: number
  /** Débit de saturation par voie (véh/h). */
  saturationFlow: number
  /** Longueur d'un véhicule à l'arrêt (m), pour la capacité de stockage. */
  vehicleLength: number
  /** Temps perdu au démarrage d'un vert (s). */
  startupLostTime: number
  /** Part de l'orange encore franchissable (s). */
  amberUsable: number
  /** Créneaux critiques (s) par type de cession. */
  criticalGap: { stop: number; giveWay: number; priorityRight: number; roundabout: number; permittedLeft: number }
  /** Temps de suite (s) entre deux véhicules cédant le passage dans un même créneau. */
  followUpTime: number
  /** Arrêt obligatoire au stop (s). */
  stopDelay: number
  /** Intervalle d'agrégation des séries (min). */
  statsIntervalMin: number
}

/* ----------------------------- Résultats ----------------------------- */

export interface EdgeStats {
  entered: number
  exited: number
  flowVehH: number
  meanSpeedKmh: number
  meanTravelTimeS: number
  /**
   * Retard subi sur ce tronçon, en véhicules-secondes, accumulé à chaque pas sur les véhicules en attente.
   * Contrairement à une mesure prise à la sortie du tronçon, il comptabilise aussi les véhicules bloqués
   * qui n'en sortent jamais : un tronçon saturé n'affiche donc plus un retard nul.
   */
  totalDelayS: number
  /** Retard moyen par véhicule entré sur le tronçon pendant la période mesurée ; 0 si aucun n'est entré. */
  meanDelayS: number
  maxQueue: number
  meanQueue: number
  /** Débit sortant / capacité (voies × débit de saturation × part de vert). */
  saturation: number
}

export interface ExitStats {
  count: number
  flowVehH: number
  meanTravelTimeS: number
  meanDelayS: number
}

export interface ApproachStats {
  /**
   * Véhicules entrés sur l'approche pendant la période mesurée, et non véhicules servis : c'est la demande
   * présentée au carrefour. `meanDelayS × vehicles` donne donc le retard total infligé par cette approche,
   * y compris lorsqu'elle est bloquée et que rien n'en sort.
   */
  vehicles: number
  meanDelayS: number
  maxQueue: number
}

export interface NetworkStats {
  entered: number
  exited: number
  inCirculation: number
  /** Véhicules générés mais jamais injectés (entrée saturée) à la fin. */
  notInjected: number
  totalDelayS: number
  meanDelayS: number
  meanTravelTimeS: number
  vehKm: number
}

export interface SimSeries {
  /** Début de chaque intervalle (s depuis le début de la simulation, chauffe comprise). */
  times: number[]
  edges: Record<EdgeId, { flow: number[]; delay: number[]; queue: number[] }>
  exits: Record<NodeId, { count: number[] }>
  network: { entered: number[]; exited: number[]; inCirculation: number[]; meanDelay: number[] }
}

export interface SimResults {
  seed: number
  durationS: number
  warmupS: number
  intervalS: number
  /** Temps simulé atteint (s) — égal à warmupS + durationS si terminé. */
  reachedS: number
  completed: boolean
  network: NetworkStats
  edges: Record<EdgeId, EdgeStats>
  exits: Record<NodeId, ExitStats>
  intersections: Record<NodeId, { approaches: Record<EdgeId, ApproachStats> }>
  series: SimSeries
  /** Avertissements agrégés de l'exécution (véhicules sans itinéraire, entrées saturées…). */
  warnings: string[]
}

/* ----------------------------- Projet ----------------------------- */

export interface CommuneInfo {
  nom: string
  code: string
  codesPostaux: string[]
  population?: number
}

export interface GeoPolygon { type: 'Polygon'; coordinates: [number, number][][] }
export interface GeoMultiPolygon { type: 'MultiPolygon'; coordinates: [number, number][][][] }

export interface ProjectMeta {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  commune?: CommuneInfo
  /** Origine de la projection locale (lon, lat). */
  center: { lon: number; lat: number }
  /** Contour de la zone en WGS84 (lon, lat). */
  contour?: GeoPolygon | GeoMultiPolygon
  extractedAt?: string
  attribution: string
  /** Bilan de l'import OSM (voir src/geo/types.ts) — persisté avec le projet, affiché par le panneau Ville. */
  import?: { stats: ImportStats; warnings: string[] }
}

export interface ChangeLogEntry {
  at: string
  label: string
}

export interface ReferenceSnapshot {
  frozenAt: string
  label: string
  network: Network
  demand: Demand
  settings: SimSettings
  results?: SimResults
}

export interface Project {
  format: typeof PROJECT_FORMAT
  version: typeof PROJECT_VERSION
  meta: ProjectMeta
  network: Network
  demand: Demand
  settings: SimSettings
  /** Journal lisible des modifications apportées depuis l'import. */
  changes: ChangeLogEntry[]
  /** Scénario de référence figé pour la comparaison. */
  reference?: ReferenceSnapshot
  /** Derniers résultats de la variante courante. */
  lastResults?: SimResults
}

/* ----------------------------- Utilitaires ----------------------------- */

export function movementKey(from: EdgeId, to: EdgeId): MovementKey {
  return `${from}>${to}`
}

export function parseMovementKey(key: MovementKey): { from: EdgeId; to: EdgeId } {
  const i = key.indexOf('>')
  return { from: key.slice(0, i), to: key.slice(i + 1) }
}

export const HIGHWAY_CLASSES: HighwayClass[] = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
]

/**
 * Rang de priorité (0 = plus prioritaire, nombre réel). Une bretelle (*_link) est classée juste après sa classe
 * mère (+0,5) : à l'insertion, la bretelle cède à la voie principale.
 */
export function highwayRank(h: HighwayClass): number {
  switch (h) {
    case 'motorway': return 0
    case 'motorway_link': return 0.5
    case 'trunk': return 1
    case 'trunk_link': return 1.5
    case 'primary': return 2
    case 'primary_link': return 2.5
    case 'secondary': return 3
    case 'secondary_link': return 3.5
    case 'tertiary': return 4
    case 'tertiary_link': return 4.5
    case 'unclassified': return 5
    case 'residential': return 6
    case 'living_street': return 7
  }
}
