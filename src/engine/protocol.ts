/**
 * Protocole entre l'interface et le moteur (Web Worker). Le moteur est aussi utilisable
 * en direct (classe `Simulation` de src/engine/simulation.ts) pour les tests.
 */
import type {
  ControllerId, Demand, EdgeId, Network, NodeControl, NodeId, SignalController, SimResults, SimSettings,
} from '@/model/types'

export interface EngineInit {
  network: Network
  demand: Demand
  settings: SimSettings
}

export type ToWorker =
  /** (Re)construit le moteur au temps 0. Répond `ready` puis `status`. */
  | { type: 'init'; payload: EngineInit }
  /** Cadence : secondes simulées par seconde réelle (1 = temps réel, 60 = ×60). */
  | { type: 'run'; speed: number }
  /** Calcul rapide sans cadence jusqu'à la fin ; frames au plus toutes les 250 ms réelles. */
  | { type: 'runFast' }
  | { type: 'pause' }
  | { type: 'step'; steps: number }
  /** Retour au temps 0 avec la configuration courante. */
  | { type: 'reset' }
  | { type: 'setSpeed'; speed: number }
  /** Modification à chaud des feux et régulations (sans réinitialiser les véhicules). */
  | { type: 'updateSignals'; controllers: Record<ControllerId, SignalController>; controls: Record<NodeId, NodeControl> }
  /** Demande des statistiques courantes (réponse `stats`). */
  | { type: 'requestStats' }

export type ControllerPhaseState = 'green' | 'amber' | 'allred' | 'flashing' | 'off'

export interface ControllerState {
  id: ControllerId
  /** Index de la phase courante ; -1 en mode `flashing` / `off`. */
  phaseIndex: number
  state: ControllerPhaseState
  /** Secondes restantes dans l'état courant (indicatif en mode adaptatif ; 0 en flashing/off). */
  remaining: number
}

/** Nombre de valeurs par véhicule dans `Frame.vehicles`. */
export const VEHICLE_STRIDE = 4

export interface Frame {
  time: number
  /**
   * Véhicules : quadruplets [id (entier stable pendant toute la simulation, < 2^24), indexTronçon (dans `edgeIndex`
   * du message `ready`), position en m depuis l'origine du tronçon, état : 0 = roule, 1 = en file].
   * L'interface interpole par id entre deux frames lorsque le tronçon est identique, sinon prend la dernière position.
   */
  vehicles: Float32Array
  controllers: ControllerState[]
  counts: { inCirculation: number; entered: number; exited: number; waitingAtEntries: number }
}

export type SimStatus = 'idle' | 'running' | 'paused' | 'done'

/**
 * Séquencement : `init` répond `ready`, puis une `frame` et un `status` ; `reset`, `step`, `pause` et `updateSignals`
 * répondent immédiatement par une `frame` puis un `status` (`reset` ne renvoie pas `ready`, `edgeIndex` est inchangé).
 * L'horloge et la progression de l'interface lisent `frame.time` ; `status.time` n'est qu'un repli.
 */
export type FromWorker =
  | { type: 'ready'; edgeIndex: EdgeId[]; endTime: number; warnings: string[] }
  | { type: 'frame'; frame: Frame }
  | { type: 'status'; status: SimStatus; time: number; endTime: number; stepsPerSecond: number }
  /** Statistiques intermédiaires (à chaque intervalle d'agrégation et sur demande). */
  | { type: 'stats'; results: SimResults }
  | { type: 'done'; results: SimResults }
  | { type: 'error'; message: string }

/** Abstraction du client moteur (le store n'instancie le Worker qu'au premier `simStart`, remplaçable en test). */
export interface SimClientLike {
  send(msg: ToWorker): void
  dispose(): void
}

export type SimClientFactory = (onMessage: (msg: FromWorker) => void) => SimClientLike
