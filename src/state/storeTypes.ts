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
/**
 * Outil carte : sélection/déplacement, tracé d'onde verte (clic sur deux nœuds), ajout de tronçon
 * (clic sur deux nœuds), pose d'un nœud libre (**un seul clic, n'importe où sur la carte** : c'est le
 * seul outil qui n'attend pas de clic sur un nœud existant, voir `addNode`).
 */
export type MapTool = 'select' | 'greenwave' | 'addEdge' | 'addNode'

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
  /**
   * Plan de feux imposé par contrôleur (`setActivePlan`) : réglage d'affichage et d'étude, hors du projet.
   * Un contrôleur absent suit son calendrier horaire (`schedule`) comme dans la réalité.
   */
  planApercu: Record<ControllerId, string>
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

/** Bilan d'un import de dossiers de carrefour (docs/ARCHITECTURE.md §14). */
export interface DossierImportReport {
  /** Dossiers rattachés à un carrefour du réseau. */
  matches: number
  /** Dossiers lus mais laissés de côté, faute de carrefour reconnu de façon certaine. */
  nonRattaches: number
  /** Compte rendu en français : raison de chaque rattachement manqué, réserves sur les données reprises. */
  avertissements: string[]
}

/**
 * Carrefour du réseau proposé pour un dossier laissé de côté.
 *
 * Il est désigné par ses rues et jamais par son identifiant OpenStreetMap : celui qui exploite le
 * carrefour le connaît par ses voies, pas par un numéro de nœud qui ne figure sur aucun dossier.
 */
export interface CarrefourCandidat {
  nodeId: NodeId
  /** Rues qui se croisent au carrefour (« Avenue de la Libération / Rue de Jourcey »). */
  etiquette: string
  /**
   * Rues du dossier retrouvées à ce carrefour, dans l'écriture du réseau. C'est sur quoi repose la
   * proposition : sans cette liste, l'exploitant arbitrerait entre des libellés sans savoir ce qui
   * les rapproche du dossier.
   */
  ruesRetrouvees: string[]
}

/**
 * Dossier lu par l'importeur mais laissé sans carrefour : plusieurs carrefours du réseau lui
 * correspondent aussi bien, ou aucun (§14.3). L'égalité peut être réelle — OpenStreetMap découpe
 * parfois un carrefour en deux nœuds voisins portant chacun une partie des voies — et aucune
 * heuristique ne la tranchera : seul l'exploitant le peut, via `rattacherDossier`.
 *
 * Vit dans l'état d'interface : ni dans le projet, ni dans l'historique, ni dans la sauvegarde.
 */
export interface DossierNonRattache {
  /** Identifiant du dossier (VE006, « Place de l'Europe »…). */
  dossierId: string
  nom: string
  /**
   * Voies du dossier telles qu'il les écrit en entête (« Avenue de la Libération (D1082) »), à défaut
   * celles de ses groupes : ce sont les rues que l'exploitant reconnaîtra sur le terrain.
   */
  voies: string[]
  /** Pourquoi l'importeur n'a pas tranché, en français. */
  raison: string
  /** Carrefours du réseau qui correspondent aussi bien ; vide si aucun ne porte ces voies. */
  candidats: CarrefourCandidat[]
  /**
   * Contenu brut du dossier, tel qu'il figure dans le fichier importé. `rattacherDossier` le repasse
   * à l'importeur plutôt que de refaire la conversion : les groupes, les phases, les plans, le
   * calendrier et les inter-verts n'ont qu'une seule implémentation (src/geo/dossierFeux.ts).
   */
  brut: unknown
}

/**
 * Invariants du store :
 *  - après toute action annulable, undo/redo et chargement compris, `selection`, `hover`, `ui.toolNodes`,
 *    `ui.planApercu` et les candidats de `dossiersNonRattaches` sont purgés des identifiants qui n'existent
 *    plus ; l'historique est vidé au chargement d'un projet ;
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
  /**
   * Bilan du dernier import de dossiers de carrefour, `null` tant qu'aucun n'a été fait.
   *
   * Il vit dans le store et non dans le panneau : changer d'onglet démonte le panneau Feux, et un bilan
   * perdu au premier coup d'œil sur la carte obligerait à réimporter le fichier pour le relire.
   */
  dossiersRapport: DossierImportReport | null
  /** Dossiers importés qu'aucun carrefour ne revendique seul, en attente d'un rattachement manuel (§14.3). */
  dossiersNonRattaches: DossierNonRattache[]

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
  /**
   * Pose un nœud libre aux coordonnées locales (m) indiquées et le sélectionne, pour qu'il soit
   * immédiatement modifiable. Le nœud naît isolé (`boundary` faux, aucun tronçon) : il ne change rien à
   * la demande ni à la simulation tant qu'un tronçon (`addEdge`) ne l'a pas raccordé au réseau.
   */
  addNode(x: number, y: number, label?: string): void
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
  /**
   * Regénère le plan par défaut à 2 phases et **détache le dossier de carrefour** éventuel : groupes,
   * inter-verts, plans horaires, calendrier et origine repartent avec les phases qu'ils décrivaient.
   * Les garder ferait cohabiter des groupes qui ne commandent plus rien avec des plans renvoyant à des
   * phases disparues, sous une origine annonçant toujours le dossier.
   */
  resetControllerPlan(controllerId: ControllerId): void
  /** Regroupe plusieurs nœuds à feux sous un même contrôleur (ou les sépare). */
  setControllerNodes(controllerId: ControllerId, nodeIds: NodeId[]): void
  /** Calcule les décalages des contrôleurs le long du plus court chemin entre deux nœuds (onde verte). */
  applyGreenWave(fromNode: NodeId, toNode: NodeId): { controllers: number; path: NodeId[] }
  /**
   * Import d'un fichier de dossiers de carrefour (§14) : les contrôleurs et les régulations reconnus
   * remplacent ceux du réseau, dossier par dossier. Annulable ; renvoie le bilan à afficher.
   * Le bilan et les dossiers non rattachés restent lisibles ensuite dans `dossiersRapport` et
   * `dossiersNonRattaches`.
   */
  importDossiersFeux(text: string): DossierImportReport
  /**
   * Rattache à la main un dossier de `dossiersNonRattaches` au carrefour `nodeId` : le contrôleur du
   * dossier (groupes rattachés aux mouvements de ce carrefour, phases, plans, calendrier, matrice
   * d'inter-verts) remplace le plan du nœud, dont la régulation passe en « signals ». Annulable.
   *
   * Sans effet, avec un message d'erreur, si le dossier n'est plus en attente, si le nœud n'existe pas
   * ou si le dossier ne décrit rien d'applicable à ce carrefour. Le dossier appliqué sort de la liste
   * d'attente et son contrôleur devient la sélection.
   */
  rattacherDossier(dossierId: string, nodeId: NodeId): void
  /**
   * Impose un plan de feux à un contrôleur, pour l'affichage **et** pour la simulation ; `null` rend la
   * main au calendrier horaire. Réglage d'étude : il vit dans `ui.planApercu`, jamais dans le projet.
   */
  setActivePlan(controllerId: ControllerId, planId: string | null): void

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
  /** Clic sur un nœud avec un outil à deux clics (onde verte, ajout de tronçon) ; sans effet pour `addNode`. */
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
