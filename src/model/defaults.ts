/**
 * Valeurs par défaut françaises et constructeurs de configuration.
 * Tout ce qui est « estimé » (tag OSM absent) est marqué comme tel dans le modèle.
 */
import type {
  Demand, EntryConfig, ExitConfig, HighwayClass, NetEdge, Network, NodeControl, NodeId, SimSettings,
} from './types'

/** Vitesse libre par défaut (km/h) quand `maxspeed` est absent — hypothèse : agglomération. */
export const DEFAULT_MAXSPEED: Record<HighwayClass, number> = {
  motorway: 130, motorway_link: 90,
  trunk: 110, trunk_link: 70,
  primary: 50, primary_link: 50,
  secondary: 50, secondary_link: 50,
  tertiary: 50, tertiary_link: 50,
  unclassified: 50,
  residential: 50,
  living_street: 20,
}

/** Voies par sens par défaut quand `lanes` est absent. */
export const DEFAULT_LANES: Record<HighwayClass, number> = {
  motorway: 2, motorway_link: 1,
  trunk: 2, trunk_link: 1,
  primary: 1, primary_link: 1,
  secondary: 1, secondary_link: 1,
  tertiary: 1, tertiary_link: 1,
  unclassified: 1,
  residential: 1,
  living_street: 1,
}

/** Débit entrant par défaut (véh/h et par voie) selon la classe du premier tronçon. */
export const DEFAULT_ENTRY_FLOW_PER_LANE: Record<HighwayClass, number> = {
  motorway: 1500, motorway_link: 800,
  trunk: 1000, trunk_link: 600,
  primary: 600, primary_link: 400,
  secondary: 400, secondary_link: 300,
  tertiary: 200, tertiary_link: 150,
  unclassified: 100,
  residential: 50,
  living_street: 20,
}

/** Poids de sortie par défaut (importance relative) selon la classe du dernier tronçon. */
export const DEFAULT_EXIT_WEIGHT: Record<HighwayClass, number> = DEFAULT_ENTRY_FLOW_PER_LANE

/** Poids de tirage des origines/destinations internes par classe (× longueur du tronçon). */
export const INTERNAL_TRIP_WEIGHT: Record<HighwayClass, number> = {
  motorway: 0, motorway_link: 0,
  trunk: 0, trunk_link: 0,
  primary: 0.1, primary_link: 0,
  secondary: 0.2, secondary_link: 0,
  tertiary: 0.5, tertiary_link: 0,
  unclassified: 0.7,
  residential: 1,
  living_street: 1,
}

/** Distance (m) sous laquelle des nœuds de feux OSM sont regroupés en un seul contrôleur. */
export const SIGNAL_CLUSTER_DISTANCE_M = 30

export const DEFAULT_SETTINGS: SimSettings = {
  durationMin: 60,
  warmupMin: 10,
  dt: 1,
  dynamicRouting: true,
  routingIntervalMin: 5,
  saturationFlow: 1800,
  vehicleLength: 7.5,
  startupLostTime: 2,
  amberUsable: 2,
  criticalGap: { stop: 6, giveWay: 5, priorityRight: 5, roundabout: 4.5, permittedLeft: 4.5 },
  followUpTime: 3,
  stopDelay: 2,
  statsIntervalMin: 5,
}

/** Plan de feux par défaut généré sur un carrefour converti en feux. */
export const DEFAULT_SIGNAL_TIMING = {
  cycle: 90,
  amber: 3,
  /** Orange porté à 5 s si une approche dépasse 50 km/h. */
  amberFast: 5,
  allRed: 2,
  minGreen: 7,
  maxGreen: 60,
  gap: 3,
}

export const ATTRIBUTION = '© les contributeurs OpenStreetMap (ODbL) ; communes et contours : geo.api.gouv.fr (Etalab)'

/**
 * Régulation implicite d'un nœud sans entrée dans `network.controls`.
 * `incoming` (tronçons entrants pré-indexés, voir `buildAdjacency`) évite le balayage du réseau.
 */
export function defaultControl(network: Network, nodeId: NodeId, incoming?: NetEdge[]): NodeControl {
  const node = network.nodes[nodeId]
  if (node?.miniRoundabout) return { nodeId, type: 'roundabout' }
  const ins = incoming ?? Object.values(network.edges).filter((e) => e.to === nodeId)
  for (const e of ins) if (e.roundabout) return { nodeId, type: 'roundabout' }
  return { nodeId, type: 'priority_class' }
}

/** Régulation effective (explicite ou implicite). */
export function effectiveControl(network: Network, nodeId: NodeId, incoming?: NetEdge[]): NodeControl {
  return network.controls[nodeId] ?? defaultControl(network, nodeId, incoming)
}

export function defaultEntryConfig(highway: HighwayClass, lanes: number, label?: string): EntryConfig {
  return { flow: DEFAULT_ENTRY_FLOW_PER_LANE[highway] * Math.max(1, lanes), enabled: true, estimated: true, label }
}

export function defaultExitConfig(highway: HighwayClass, lanes: number, label?: string): ExitConfig {
  return { weight: DEFAULT_EXIT_WEIGHT[highway] * Math.max(1, lanes), enabled: true, label }
}

/**
 * Demande par défaut : une entrée pour chaque nœud frontière ayant un tronçon sortant vers le réseau,
 * une sortie pour chaque nœud frontière ayant un tronçon entrant.
 */
export function defaultDemand(network: Network, seed = 42): Demand {
  const entries: Record<NodeId, EntryConfig> = {}
  const exits: Record<NodeId, ExitConfig> = {}
  for (const e of Object.values(network.edges)) {
    const from = network.nodes[e.from]
    const to = network.nodes[e.to]
    if (from?.boundary && !entries[e.from]) entries[e.from] = defaultEntryConfig(e.highway, e.lanes, from.label ?? e.name)
    if (to?.boundary && !exits[e.to]) exits[e.to] = defaultExitConfig(e.highway, e.lanes, to.label ?? e.name)
  }
  return {
    seed,
    globalFactor: 1,
    entries,
    exits,
    destinationMode: 'weights',
    od: {},
    internal: { enabled: false, generationRate: 300, internalDestinationShare: 0.5, entryInternalShare: 0.2 },
  }
}

/** Ajoute les entrées/sorties manquantes après une modification du réseau, sans écraser l'existant. */
export function reconcileDemand(network: Network, demand: Demand): Demand {
  const fresh = defaultDemand(network, demand.seed)
  const entries = { ...demand.entries }
  const exits = { ...demand.exits }
  for (const id of Object.keys(fresh.entries)) if (!entries[id]) entries[id] = fresh.entries[id]
  for (const id of Object.keys(fresh.exits)) if (!exits[id]) exits[id] = fresh.exits[id]
  for (const id of Object.keys(entries)) if (!fresh.entries[id]) delete entries[id]
  for (const id of Object.keys(exits)) if (!fresh.exits[id]) delete exits[id]
  // Matrice OD : lignes d'entrées disparues et colonnes de sorties disparues supprimées.
  const od: Demand['od'] = {}
  for (const [entryId, row] of Object.entries(demand.od)) {
    if (!entries[entryId]) continue
    const cleaned: Record<NodeId, number> = {}
    for (const [exitId, share] of Object.entries(row)) if (exits[exitId]) cleaned[exitId] = share
    if (Object.keys(cleaned).length) od[entryId] = cleaned
  }
  return { ...demand, entries, exits, od }
}
