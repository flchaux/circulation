/**
 * Contrat du store applicatif (Zustand).
 *
 * `src/state/store.ts` exporte `useAppStore` (créé par `create<AppState>()(...)`, API Zustand v5) et
 * `createAppStore(opts?: AppStoreOptions)` pour les tests. Les composants React utilisent `useAppStore(selector)` ;
 * le renderer canvas utilise `useAppStore.getState()` et `useAppStore.subscribe(listener)` pour éviter un rendu React
 * à chaque frame. Les composants d'interface ne dépendent que de ce fichier.
 * Toutes les actions d'édition marquées « annulable » créent une entrée d'historique (undo/redo).
 */
import type {
  ControllerId, Demand, EdgeId, EntryConfig, ExitConfig, GreenKind, HighwayClass, InternalDemand, MovementKey, NetEdge,
  NetNode, NodeControl, NodeId, Project, SignalController, SignalPhase, SimResults, SimSettings,
} from '@/model/types'
import type { Frame, SimClientFactory, SimStatus } from '@/engine/protocol'
import type { CommuneSummary, OsmExtract } from '@/geo/types'

export type Selection =
  | { kind: 'node'; id: NodeId }
  | { kind: 'edge'; id: EdgeId }
  | { kind: 'controller'; id: ControllerId }
  | null

export type ColorMode = 'class' | 'flow' | 'delay' | 'saturation' | 'speed' | 'queue' | 'deltaDelay' | 'deltaFlow'
export type SidebarTab = 'ville' | 'reseau' | 'feux' | 'trafic' | 'resultats' | 'comparer'
/** Outil carte : sélection/déplacement, tracé d'onde verte (clic sur deux nœuds), ajout de tronçon (clic sur deux nœuds). */
export type MapTool = 'select' | 'greenwave' | 'addEdge'

export interface UiState {
  tab: SidebarTab
  colorMode: ColorMode
  showVehicles: boolean
  showLabels: boolean
  showBaseMap: boolean
  baseMapOpacity: number
  tool: MapTool
  /** Nœuds déjà cliqués avec l'outil courant (onde verte / ajout de tronçon). */
  toolNodes: NodeId[]
  /** Options du prochain tronçon créé avec l'outil `addEdge` (modifiées via `setUi`). */
  addEdgeOptions: { twoWay: boolean; highway: HighwayClass; lanes: number; maxspeed: number }
  /** Sélection à recentrer sur la carte (incrémenté par `select(…, { reveal: true })`). */
  revealCounter: number
}

/** Glisser en cours : hors du projet (pas d'immer, pas d'historique) ; le renderer superpose la position transitoire. */
export interface DragState {
  nodeId: NodeId
  x: number
  y: number
  /** Nœud cible surligné pour une fusion au dépôt. */
  dropOn: NodeId | null
}

export interface SimState {
  status: SimStatus
  time: number
  endTime: number
  speed: number
  fast: boolean
  stepsPerSecond: number
  frame: Frame | null
  /** Ordre des tronçons dans `frame.vehicles` (message `ready`). */
  edgeIndex: EdgeId[]
  results: SimResults | null
  warnings: string[]
  /** Le réseau a changé depuis le dernier `init` : il faut réinitialiser. */
  stale: boolean
}

export interface LibraryEntry {
  id: string
  name: string
  commune?: string
  updatedAt: string
  edgeCount: number
}

export interface CsvImportReport {
  entries: number
  exits: number
  odCells: number
  unknown: string[]
}

/**
 * Invariants du store :
 *  - après toute action annulable, undo/redo et chargement compris, `selection`, `hover` et `ui.toolNodes` sont purgés
 *    des identifiants qui n'existent plus ; l'historique est vidé au chargement d'un projet ;
 *  - `sim.frame` et `sim.results` (messages `frame`/`stats`) sont écrits hors immer et ne déclenchent ni `dirty` ni autosauvegarde ;
 *    `project.lastResults` n'est écrit qu'à `done` ;
 *  - toute modification de topologie appelle `reconcileDemand` puis `sanitizeNetwork` et marque `sim.stale`.
 */
export interface AppState {
  project: Project | null
  selection: Selection
  hover: Selection
  drag: DragState | null
  ui: UiState
  sim: SimState
  canUndo: boolean
  canRedo: boolean
  /** `cancellable` : un chargement long est en cours et peut être interrompu par `cancelLoad`. */
  busy: { active: boolean; message: string; cancellable: boolean }
  error: string | null
  library: LibraryEntry[]
  /** Modifications non enregistrées dans la bibliothèque. */
  dirty: boolean

  /* --------- Projet --------- */
  /**
   * Démarrage : rafraîchit la bibliothèque, charge `project:current` s'il existe, sinon la démo `veauche`.
   * Idempotent ; appelé une seule fois par main.tsx.
   */
  bootstrap(): Promise<void>
  /** Charge une commune : contour, extraction Overpass (avec cache), construction du graphe. */
  loadCommune(commune: CommuneSummary, opts?: { refresh?: boolean }): Promise<void>
  /** Interrompt le chargement de commune en cours (extraction OpenStreetMap). Sans effet sinon. */
  cancelLoad(): void
  /** Charge un extrait déjà téléchargé (démo embarquée ou cache). */
  loadExtract(extract: OsmExtract): Promise<void>
  loadDemo(slug: string): Promise<void>
  loadProject(project: Project): void
  setProjectName(name: string): void
  exportProjectJson(): string
  importProjectJson(text: string): void
  saveToLibrary(): Promise<void>
  refreshLibrary(): Promise<void>
  loadFromLibrary(id: string): Promise<void>
  deleteFromLibrary(id: string): Promise<void>

  /* --------- Édition du réseau (annulable) --------- */
  beginNodeDrag(id: NodeId): void
  /** Déplacement transitoire : ne modifie que `drag` (pas le projet). */
  dragNode(id: NodeId, x: number, y: number, dropOn?: NodeId | null): void
  /** Fin du glisser : une seule entrée d'historique (aucune si la position est inchangée) ; `dropOn` fusionne le nœud dans la cible. */
  endNodeDrag(id: NodeId, dropOn?: NodeId): void
  cancelNodeDrag(): void
  updateNode(id: NodeId, patch: Partial<Pick<NetNode, 'label' | 'miniRoundabout'>>): void
  mergeNodes(sourceId: NodeId, targetId: NodeId): void
  deleteNode(id: NodeId): void
  deleteEdge(id: EdgeId): void
  addEdge(from: NodeId, to: NodeId, opts: { twoWay: boolean; highway: NetEdge['highway']; lanes: number; maxspeed: number; name?: string }): void
  /** Toute valeur fournie pour `lanes`/`maxspeed` met le drapeau `estimated` correspondant à false. */
  updateEdge(id: EdgeId, patch: Partial<Pick<NetEdge, 'name' | 'highway' | 'lanes' | 'maxspeed' | 'closed'>>, applyToReverse?: boolean): void
  /** `oneway` : garde ce tronçon seul ; `reverse` : inverse le sens unique ; `twoway` : crée le tronçon opposé. */
  setEdgeDirection(id: EdgeId, mode: 'oneway' | 'reverse' | 'twoway'): void
  setBannedTurn(from: EdgeId, to: EdgeId, banned: boolean): void
  /** Change la régulation ; `signals` crée un contrôleur avec plan par défaut si le nœud n'en a pas. */
  setNodeControl(nodeId: NodeId, control: Omit<NodeControl, 'nodeId'>): void
  updateController(id: ControllerId, patch: Partial<Omit<SignalController, 'id' | 'phases'>>): void
  updatePhase(controllerId: ControllerId, phaseId: string, patch: Partial<Omit<SignalPhase, 'id' | 'movements'>>): void
  /** `kind` null = rouge. */
  setPhaseMovement(controllerId: ControllerId, phaseId: string, key: MovementKey, kind: GreenKind | null): void
  addPhase(controllerId: ControllerId): void
  removePhase(controllerId: ControllerId, phaseId: string): void
  movePhase(controllerId: ControllerId, phaseId: string, direction: -1 | 1): void
  /** Regénère le plan par défaut à 2 phases. */
  resetControllerPlan(controllerId: ControllerId): void
  /** Regroupe plusieurs nœuds à feux sous un même contrôleur (ou les sépare). */
  setControllerNodes(controllerId: ControllerId, nodeIds: NodeId[]): void
  /** Calcule les décalages des contrôleurs le long du plus court chemin entre deux nœuds (onde verte). */
  applyGreenWave(fromNode: NodeId, toNode: NodeId): { controllers: number; path: NodeId[] }

  /* --------- Demande (annulable) --------- */
  updateEntry(nodeId: NodeId, patch: Partial<EntryConfig>): void
  updateExit(nodeId: NodeId, patch: Partial<ExitConfig>): void
  setGlobalFactor(factor: number): void
  setSeed(seed: number): void
  setDestinationMode(mode: Demand['destinationMode']): void
  setOdShare(entryId: NodeId, exitId: NodeId, share: number): void
  clearOd(): void
  updateInternal(patch: Partial<InternalDemand>): void
  /** CSV « entree;debit » ou « entree;sortie;part » (voir docs/ARCHITECTURE.md). */
  importDemandCsv(text: string, fileName: string): CsvImportReport
  exportDemandCsv(): string

  /* --------- Réglages (annulable) --------- */
  updateSettings(patch: Partial<SimSettings>): void

  /* --------- Référence / comparaison --------- */
  freezeReference(label?: string): void
  clearReference(): void

  /* --------- Simulation --------- */
  simStart(): void
  simPause(): void
  simReset(): void
  simStep(steps: number): void
  simSetSpeed(speed: number): void
  simRunFast(): void

  /* --------- Historique / interface --------- */
  undo(): void
  redo(): void
  /** `reveal` : la carte se recentre sur l'élément (incrémente `ui.revealCounter`). */
  select(selection: Selection, opts?: { reveal?: boolean }): void
  setHover(selection: Selection): void
  setTab(tab: SidebarTab): void
  setColorMode(mode: ColorMode): void
  setUi(patch: Partial<UiState>): void
  setTool(tool: MapTool): void
  /** Clic sur un nœud avec un outil à deux clics (onde verte, ajout de tronçon). */
  toolClickNode(nodeId: NodeId): void
  clearError(): void
  setError(message: string): void
}

/** Options de création du store (src/state/store.ts : `createAppStore(opts?)` et `useAppStore` = instance par défaut). */
export interface AppStoreOptions {
  /** Fabrique du client moteur ; par défaut `new SimClient(onMessage)` (Worker), instancié au premier `simStart`. */
  createClient?: SimClientFactory
  /** Désactive l'autosauvegarde IndexedDB (tests). */
  persist?: boolean
}
