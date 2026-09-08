/**
 * Automates de feux (§5.4 de docs/ARCHITECTURE.md) : plan fixe, mode adaptatif à détecteur de ligne d'arrêt,
 * clignotant et éteint. L'état est maintenu par mouvement (`state` / `since`) pour que la décharge puisse
 * appliquer le temps perdu au démarrage et la part utilisable de l'orange.
 *
 * Les dossiers de carrefour réels (§14) ajoutent quatre mécanismes, tous inertes tant que le contrôleur ne
 * porte pas les données correspondantes :
 *  - inter-verts par couple de groupes : la durée entre deux phases dépend de la transition (§14.3) ;
 *  - plans horaires : le jeu de durées suit l'heure simulée, et ne change qu'en fin de cycle (§14.4) ;
 *  - groupes piétons : leur vert ferme les mouvements véhicules sécants (§14.5, via `phaseMovements`) ;
 *  - traversées sur bouton poussoir : un groupe piéton hors rappel n'est desservi qu'une partie des cycles,
 *    tirés au sort de façon reproductible (`DEFAULT_PEDESTRIAN_CALL_SHARE`).
 */
import type { ControllerId, Network, NodeId, SignalController, SignalPlan } from '@/model/types'
import type { ControllerState } from './protocol'
import { DEFAULT_SETTINGS } from '@/model/defaults'
import {
  DEFAULT_PEDESTRIAN_CALL_SHARE, activePlan, clockAt, phaseMovements, phaseTransition, planPhaseTiming,
} from '@/model/signals'
import { createRng, streamSeed } from './rng'
import type { EngineGraph } from './routing'

/** Mouvement au rouge. */
export const SIG_RED = 0
/** Vert sans cession (protégé). */
export const SIG_GREEN_PROTECTED = 1
/** Vert avec cession (permis) : le mouvement cède aux mouvements verts en conflit. */
export const SIG_GREEN_PERMITTED = 2
export const SIG_AMBER = 3
/** Mouvement non piloté : carrefour sans feux, approche interne à un regroupement, contrôleur clignotant/éteint. */
export const SIG_FREE = 4

/** État interne d'un contrôleur : vert, orange, rouge intégral. */
const K_GREEN = 0
const K_AMBER = 1
const K_ALLRED = 2

/** Heure simulée à l'instant 0 : ce qui permet de choisir le plan horaire actif. */
export interface SignalClock {
  startTimeOfDayMin: number
  dayOfWeek: number
  /** Graine du tirage des appels piétons ; même graine = même déroulé, comme le reste du moteur. */
  seed?: number
  /**
   * Part des cycles où une traversée sur bouton poussoir est desservie (0 à 1).
   * Par défaut `DEFAULT_PEDESTRIAN_CALL_SHARE` (model/signals.ts), qui porte l'hypothèse retenue.
   */
  pedestrianCallShare?: number
}

/** Informations de trafic dont le mode adaptatif a besoin. */
export interface SignalProbe {
  /** Dernier instant où un véhicule a franchi la ligne d'arrêt ou est arrivé en tête sur ce tronçon. */
  lastActivity(edgeIdx: number): number
  /** Nombre de véhicules arrivés en tête (en attente) sur ce tronçon. */
  queueLength(edgeIdx: number): number
}

interface PhaseRuntime {
  /** Durées du plan actif (s). */
  green: number
  minGreen: number
  maxGreen: number
  gap: number
  /** Durée totale de la phase, inter-vert vers la phase suivante compris (mode fixe). 0 si le plan la saute. */
  total: number
  /** La phase s'ouvre-t-elle dans le plan actif ? */
  runs: boolean
  /** États des mouvements pilotés (alignés sur `ControllerRuntime.allMovs`) pendant le vert. */
  greenStates: Uint8Array
  /** Créneaux (index dans `allMovs`) des mouvements verts de la phase. */
  greenSlots: number[]
  /** Tronçons d'approche distincts des mouvements verts de la phase. */
  approaches: Int32Array
}

/** Inter-vert d'une phase vers une autre : durées de la transition (les états sont dans `VariantStates`). */
interface TransitionRuntime {
  amber: number
  allRed: number
  /** Durée issue de la matrice d'inter-verts (et non de l'orange / rouge intégral du contrôleur). */
  matrixBased: boolean
}

/**
 * Tables d'états publiées pour un jeu donné de traversées desservies (« variante »).
 *
 * Une traversée sur bouton poussoir non appelée laisse ouverts les mouvements qu'elle aurait fermés : les
 * états dépendent donc du masque du cycle courant, pas seulement de la phase. Les **durées** (verts,
 * inter-verts) n'en dépendent jamais : ne pas raccourcir un dégagement est le choix sûr, et cela garde un
 * temps de cycle constant, dont dépend le repérage du mode fixe.
 */
interface VariantStates {
  /** États pendant le vert, par phase. */
  green: Uint8Array[]
  /** États pendant le jaune de la transition `[i][j]`. */
  amber: Uint8Array[][]
  /** États pendant le rouge intégral de la transition `[i][j]`. */
  allRed: Uint8Array[][]
}

/**
 * Index de la prochaine phase ouverte par le plan actif après `i`. Renvoie `i` si c'est la seule ouverte,
 * ce qui fait tourner le contrôleur sur une phase unique plutôt que de le bloquer.
 */
function nextRunningIndex(c: ControllerRuntime, i: number): number {
  const n = c.phases.length
  for (let k = 1; k <= n; k++) {
    const j = (i + k) % n
    if (c.phases[j].runs) return j
  }
  return i
}

/** Durées d'un plan de feux, indexées par phase. */
interface PlanRuntime {
  offset: number
  green: Float64Array
  minGreen: Float64Array
  maxGreen: Float64Array
  /** Phases réellement ouvertes par ce plan : un dossier déclare des phases propres à un seul plan. */
  runs: Uint8Array
}

interface ControllerRuntime {
  id: ControllerId
  /** Définition d'origine : sert à choisir le plan horaire actif. */
  spec: SignalController
  mode: SignalController['mode']
  /** Décalage du plan actif (celui du contrôleur quand il n'a pas de plan). */
  offset: number
  cycle: number
  skipEmpty: boolean
  phases: PhaseRuntime[]
  /** `transitions[i][j]` : inter-vert de la phase i vers la phase j. */
  transitions: TransitionRuntime[][]
  plans: PlanRuntime[]
  /** Le contrôleur porte des plans horaires : le cycle devient un automate au lieu d'une fonction du temps. */
  planned: boolean
  activePlan: number
  /** Plan en vigueur au démarrage (heure simulée à t = 0), rétabli par `reset()`. */
  initialPlan: number
  /** Début du cycle courant (mode fixe avec plans) ; NaN tant que le contrôleur n'a pas démarré. */
  cycleStart: number
  /** Tous les mouvements pilotés par le contrôleur. */
  allMovs: Int32Array
  phaseIndex: number
  /** Phase visée par la transition en cours : elle détermine l'inter-vert appliqué. */
  nextIndex: number
  kind: number
  stateStart: number
  /** Créneau (index dans `allMovs`) de chaque mouvement piloté, pour reconstruire les variantes. */
  slotOf: Map<number, number>
  /** Groupes piétons sur bouton poussoir cités par une phase ; le bit `i` du masque = groupe non desservi. */
  optionalPeds: string[]
  /** Traversées non desservies pendant le cycle courant. */
  pedMask: number
  /** Numéro du cycle qui a fixé `pedMask` ; NaN tant qu'aucun cycle n'a commencé. */
  pedCycle: number
  /** Tables d'états par masque, construites à la demande (le masque 0 l'est dès la construction). */
  variants: Map<number, VariantStates>
  /** Graine du tirage des appels piétons, propre au contrôleur. */
  seed: number
  /** Signature JSON : un contrôleur inchangé conserve son état lors d'un `updateSignals`. */
  signature: string
}

export class SignalEngine {
  /** État courant par index de mouvement. */
  readonly state: Uint8Array
  /** Début de l'état courant du mouvement (s). */
  readonly since: Float64Array
  /** Nœuds réellement pilotés par des feux (modes `fixed` / `actuated`). */
  readonly signalizedNodes: Set<NodeId> = new Set()
  /** Avertissements de construction, en français. */
  readonly warnings: string[] = []

  private readonly controllers: ControllerRuntime[] = []
  private readonly g: EngineGraph
  private readonly clock: SignalClock
  /** Part des cycles où une traversée sur appel est desservie (1 = toujours, 0 = jamais). */
  private readonly pedestrianCallShare: number
  private planChanges = 0

  /**
   * Nombre de bascules de plan horaire depuis la construction. La simulation s'en sert pour savoir quand
   * réévaluer la part de vert : celle-ci dépend du plan actif, et sert de dénominateur à la saturation.
   */
  get planEpoch(): number { return this.planChanges }

  constructor(graph: EngineGraph, network: Network, clock?: SignalClock) {
    this.g = graph
    this.clock = {
      startTimeOfDayMin: clock?.startTimeOfDayMin ?? DEFAULT_SETTINGS.startTimeOfDayMin,
      dayOfWeek: clock?.dayOfWeek ?? DEFAULT_SETTINGS.dayOfWeek,
      seed: clock?.seed,
    }
    const share = clock?.pedestrianCallShare
    this.pedestrianCallShare = Number.isFinite(share) ? Math.min(1, Math.max(0, share as number)) : DEFAULT_PEDESTRIAN_CALL_SHARE
    const nMov = graph.movements.length
    this.state = new Uint8Array(nMov).fill(SIG_FREE)
    this.since = new Float64Array(nMov).fill(-Infinity)

    for (const id of Object.keys(network.controllers).sort()) {
      const c = network.controllers[id]
      const inside = new Set(c.nodeIds)
      // Un nœud n'est piloté que si sa régulation le déclare : `controls` et `controllers` restent ainsi
      // cohérents avec `effectiveControl` (utilisé par les tables de priorité).
      const piloted = c.nodeIds.filter((id) => network.controls[id]?.type === 'signals')
      // Mouvements pilotés : ceux des nœuds couverts dont l'approche vient de l'extérieur du regroupement.
      const controlled: number[] = []
      for (const nodeId of piloted) {
        const n = graph.nodeOf.get(nodeId)
        if (n === undefined) continue
        for (let k = graph.nodeMovStart[n]; k < graph.nodeMovStart[n + 1]; k++) {
          const mv = graph.nodeMovList[k]
          const fromEdge = graph.movementFrom[mv]
          if (fromEdge < 0) continue
          const fromNode = graph.edgeFromNode[fromEdge]
          if (fromNode >= 0 && inside.has(graph.nodeIds[fromNode])) continue
          controlled.push(mv)
        }
      }
      const active = c.mode === 'fixed' || c.mode === 'actuated'
      if (active) for (const nodeId of piloted) if (graph.nodeOf.has(nodeId)) this.signalizedNodes.add(nodeId)

      const slotOf = new Map<number, number>()
      controlled.forEach((mv, i) => slotOf.set(mv, i))
      const phases: PhaseRuntime[] = []
      for (const p of c.phases) {
        const greenStates = new Uint8Array(controlled.length).fill(SIG_RED)
        const greenSlots: number[] = []
        const approaches = new Set<number>()
        // Les mouvements verts sont dérivés des groupes quand la phase en porte (`phaseMovements`).
        for (const [key, kind] of Object.entries(phaseMovements(c, p))) {
          const mv = graph.movementOf.get(key)
          if (mv === undefined) continue
          const slot = slotOf.get(mv)
          if (slot === undefined) continue // mouvement interne au regroupement : toujours franchissable
          greenStates[slot] = kind === 'permitted' ? SIG_GREEN_PERMITTED : SIG_GREEN_PROTECTED
          greenSlots.push(slot)
          approaches.add(graph.movementFrom[mv])
        }
        phases.push({
          green: 0, minGreen: 0, maxGreen: 0, total: 0, runs: true,
          gap: Math.max(0, p.gap),
          greenStates,
          greenSlots,
          approaches: Int32Array.from([...approaches].sort((a, b) => a - b)),
        })
      }

      const transitions: TransitionRuntime[][] = []
      for (let i = 0; i < c.phases.length; i++) {
        const row: TransitionRuntime[] = []
        for (let j = 0; j < c.phases.length; j++) {
          const tr = phaseTransition(c, c.phases[i], c.phases[j])
          row.push({ amber: Math.max(0, tr.amber), allRed: Math.max(0, tr.allRed), matrixBased: tr.matrixBased })
        }
        transitions.push(row)
      }

      // Traversées sur bouton poussoir : celles qu'une phase cite sans que le dossier les déclare en rappel.
      // L'ordre suit `c.groups` pour que le bit d'un groupe ne dépende pas de l'ordre des phases.
      const cited = new Set<string>()
      for (const p of c.phases) for (const gid of p.groups ?? []) cited.add(gid)
      const optionalPeds = (c.groups ?? [])
        .filter((g) => g.type === 'pieton' && !g.recall && cited.has(g.id))
        .map((g) => g.id)

      // Un contrôleur sans plan est traité comme s'il en avait un seul, bâti sur les durées de ses phases.
      const specPlans: (SignalPlan | null)[] = c.plans?.length ? c.plans : [null]
      const plans: PlanRuntime[] = specPlans.map((plan) => {
        const green = new Float64Array(c.phases.length)
        const minGreen = new Float64Array(c.phases.length)
        const maxGreen = new Float64Array(c.phases.length)
        const runs = new Uint8Array(c.phases.length)
        c.phases.forEach((p, i) => {
          const t = planPhaseTiming(p, plan)
          green[i] = Math.max(0, t.green)
          minGreen[i] = Math.max(0, t.minGreen)
          maxGreen[i] = Math.max(minGreen[i], t.maxGreen)
          runs[i] = t.skipped ? 0 : 1
        })
        // Un plan qui fermerait toutes les phases laisserait le carrefour au rouge : on l'ignore alors.
        if (!runs.some((r) => r === 1)) runs.fill(1)
        const offset = plan && Number.isFinite(plan.offset) ? plan.offset : c.offset
        return { offset: Number.isFinite(offset) ? offset : 0, green, minGreen, maxGreen, runs }
      })

      const runtime: ControllerRuntime = {
        id, spec: c, mode: c.mode, offset: c.offset, cycle: 0, skipEmpty: c.actuated.skipEmpty,
        phases, transitions, plans, planned: !!c.plans?.length, activePlan: 0, initialPlan: 0,
        cycleStart: Number.NaN,
        allMovs: Int32Array.from(controlled),
        phaseIndex: 0, nextIndex: c.phases.length > 1 ? 1 : 0, kind: K_GREEN, stateStart: Number.NaN,
        slotOf, optionalPeds, pedMask: 0, pedCycle: Number.NaN, variants: new Map(),
        seed: streamSeed(this.clock.seed ?? 0, `pietons|${id}`),
        signature: JSON.stringify(c),
      }
      // Variante « toutes traversées desservies » : c'est celle d'un contrôleur sans groupe sur appel, et
      // elle sert de base aux autres. La construire ici garde le cas courant sans allocation en cours de route.
      runtime.variants.set(0, this.buildVariant(runtime, 0))
      // Plan en vigueur à l'instant 0 : il fixe le cycle affiché et la part de vert des statistiques.
      runtime.initialPlan = this.selectPlan(runtime, 0)
      this.applyPlan(runtime, runtime.initialPlan)
      if (active && runtime.cycle <= 0) {
        this.warnings.push(`Contrôleur « ${c.name || id} » : temps de cycle nul, tous les mouvements restent au rouge.`)
      }
      this.controllers.push(runtime)
    }
  }

  /** Reprend l'état courant des contrôleurs identiques (modification de feux à chaud). */
  adoptStateFrom(previous: SignalEngine): void {
    const old = new Map(previous.controllers.map((c) => [c.id, c]))
    for (const c of this.controllers) {
      const p = old.get(c.id)
      if (p && p.signature === c.signature) {
        c.phaseIndex = p.phaseIndex
        c.nextIndex = p.nextIndex
        c.kind = p.kind
        c.stateStart = p.stateStart
        c.cycleStart = p.cycleStart
        // Le cycle piéton en cours est repris tel quel : une modification de feux à chaud ne doit pas
        // rouvrir une traversée au milieu d'un cycle.
        c.pedCycle = p.pedCycle
        c.pedMask = p.pedMask
        this.applyPlan(c, p.activePlan)
      }
    }
  }

  reset(): void {
    this.state.fill(SIG_FREE)
    this.since.fill(-Infinity)
    for (const c of this.controllers) {
      c.phaseIndex = 0
      c.nextIndex = c.phases.length > 1 ? 1 : 0
      c.kind = K_GREEN
      c.stateStart = Number.NaN
      c.cycleStart = Number.NaN
      c.pedCycle = Number.NaN
      c.pedMask = 0
      this.applyPlan(c, c.initialPlan)
    }
  }

  /** Fait avancer tous les contrôleurs au temps `t` et publie l'état de chaque mouvement piloté. */
  update(t: number, probe: SignalProbe): void {
    for (const c of this.controllers) {
      if (c.mode === 'flashing' || c.mode === 'off') {
        // Le carrefour se comporte comme un `priority_class` : les mouvements redeviennent libres.
        for (let i = 0; i < c.allMovs.length; i++) this.setState(c.allMovs[i], SIG_FREE, t)
        continue
      }
      if (c.phases.length === 0 || (c.cycle <= 0 && !c.planned)) {
        for (let i = 0; i < c.allMovs.length; i++) this.setState(c.allMovs[i], SIG_RED, t)
        continue
      }
      if (c.mode === 'fixed') this.advanceFixed(c, t)
      else this.advanceActuated(c, t, probe)
      // Un plan horaire peut annuler le cycle (durées toutes nulles) : le carrefour reste alors au rouge.
      if (c.cycle <= 0) {
        for (let i = 0; i < c.allMovs.length; i++) this.setState(c.allMovs[i], SIG_RED, t)
        continue
      }
      this.publish(c)
    }
  }

  private setState(mv: number, s: number, since: number): void {
    if (this.state[mv] !== s) {
      this.state[mv] = s
      this.since[mv] = since
    }
  }

  /** Applique les durées d'un plan : verts par phase, inter-verts et temps de cycle. */
  private applyPlan(c: ControllerRuntime, index: number): void {
    const idx = index >= 0 && index < c.plans.length ? index : 0
    const plan = c.plans[idx]
    // Un changement de plan change les durées de vert, donc la part de vert de chaque approche : la
    // simulation doit pouvoir le détecter pour réévaluer le dénominateur de la saturation (§5.7).
    if (idx !== c.activePlan) this.planChanges++
    c.activePlan = idx
    c.offset = plan.offset
    const n = c.phases.length
    let cycle = 0
    for (let i = 0; i < n; i++) {
      const p = c.phases[i]
      p.runs = plan.runs[i] === 1
      if (!p.runs) {
        // Phase propre à un autre plan : elle ne consomme ni vert ni inter-vert dans celui-ci.
        p.total = 0
        continue
      }
      p.green = plan.green[i]
      p.minGreen = plan.minGreen[i]
      p.maxGreen = plan.maxGreen[i]
      // L'inter-vert se calcule vers la prochaine phase RÉELLEMENT ouverte, pas vers la suivante du tableau.
      const tr = c.transitions[i][nextRunningIndex(c, i)]
      p.total = p.green + tr.amber + tr.allRed
      cycle += p.total
    }
    c.cycle = cycle
  }

  /** Index du plan applicable à l'instant simulé `t` (§14.4). */
  private selectPlan(c: ControllerRuntime, t: number): number {
    if (!c.planned) return 0
    const now = clockAt(this.clock.startTimeOfDayMin, this.clock.dayOfWeek, t)
    const plan = activePlan(c.spec, now.minOfDay, now.dayOfWeek)
    const i = plan ? (c.spec.plans?.indexOf(plan) ?? -1) : -1
    return i >= 0 ? i : 0
  }

  private advanceFixed(c: ControllerRuntime, t: number): void {
    if (!c.planned) {
      // Sans plan horaire, le cycle est une simple fonction du temps : robuste aux sauts d'horloge.
      let tau = (t - c.offset) % c.cycle
      if (tau < 0) tau += c.cycle
      // Le numéro de cycle se déduit lui aussi du temps : les appels piétons restent une fonction de `t`.
      this.setPedestrianCycle(c, Math.floor((t - c.offset) / c.cycle))
      this.locatePhase(c, tau, t)
      return
    }
    // Démarrage, ou plan aux durées toutes nulles : aucun cycle en cours à préserver, on prend directement
    // le plan de l'heure simulée et on cale le premier cycle sur son décalage.
    if (!Number.isFinite(c.cycleStart) || c.cycle <= 0) {
      this.applyPlan(c, this.selectPlan(c, t))
      if (c.cycle <= 0) return
      let phi = (t - c.offset) % c.cycle
      if (phi < 0) phi += c.cycle
      c.cycleStart = t - phi
      this.startPedestrianCycle(c)
    }
    // Le plan ne peut changer qu'en fin de cycle : une phase entamée va toujours à son terme, faute de quoi
    // un inter-vert serait raccourci. Le décalage du nouveau plan ne réaligne pas le cycle en cours de route :
    // un contrôleur réel ne peut pas non plus écourter une phase pour se recaler.
    let guard = 1024
    while (c.cycle > 0 && t - c.cycleStart >= c.cycle && guard-- > 0) {
      c.cycleStart += c.cycle
      const next = this.selectPlan(c, c.cycleStart)
      if (next !== c.activePlan) this.applyPlan(c, next)
      this.startPedestrianCycle(c)
    }
    if (c.cycle <= 0) return
    this.locatePhase(c, Math.max(0, t - c.cycleStart), t)
  }

  /** Ouvre un nouveau cycle pour les traversées sur appel (modes où le cycle est un automate). */
  private startPedestrianCycle(c: ControllerRuntime): void {
    this.setPedestrianCycle(c, Number.isFinite(c.pedCycle) ? c.pedCycle + 1 : 0)
  }

  /** Place le contrôleur dans son cycle : phase courante, vert / jaune / rouge intégral et début de l'état. */
  private locatePhase(c: ControllerRuntime, tau: number, t: number): void {
    const n = c.phases.length
    let acc = 0
    let derniereOuverte = -1
    for (let i = 0; i < n; i++) if (c.phases[i].runs) derniereOuverte = i
    for (let i = 0; i < n; i++) {
      const p = c.phases[i]
      if (!p.runs) continue
      if (tau < acc + p.total || i === derniereOuverte) {
        const local = tau - acc
        const tr = c.transitions[i][nextRunningIndex(c, i)]
        c.phaseIndex = i
        c.nextIndex = nextRunningIndex(c, i)
        if (local < p.green) { c.kind = K_GREEN; c.stateStart = t - local }
        else if (local < p.green + tr.amber) { c.kind = K_AMBER; c.stateStart = t - (local - p.green) }
        else { c.kind = K_ALLRED; c.stateStart = t - (local - p.green - tr.amber) }
        return
      }
      acc += p.total
    }
  }

  private advanceActuated(c: ControllerRuntime, t: number, probe: SignalProbe): void {
    const n = c.phases.length
    if (!Number.isFinite(c.stateStart)) {
      c.phaseIndex = 0
      c.nextIndex = n > 1 ? 1 : 0
      c.kind = K_GREEN
      c.stateStart = t
      this.startPedestrianCycle(c)
      return
    }
    let guard = 8
    while (guard-- > 0) {
      const p = c.phases[c.phaseIndex]
      const tr = c.transitions[c.phaseIndex][c.nextIndex]
      if (c.kind === K_GREEN) {
        const g = t - c.stateStart
        let terminate = g >= p.maxGreen
        if (!terminate && g >= p.minGreen) {
          // Détecteur à la ligne d'arrêt : la file qui se décharge repousse la fin du vert jusqu'à maxGreen.
          let last = -Infinity
          for (let i = 0; i < p.approaches.length; i++) {
            const a = probe.lastActivity(p.approaches[i])
            if (a > last) last = a
          }
          terminate = t - last >= p.gap
        }
        if (!terminate) return
        // La durée de l'inter-vert dépend de la phase visée : il faut donc la choisir avant d'éteindre le vert.
        c.nextIndex = this.nextPhase(c, probe)
        c.kind = K_AMBER
        c.stateStart = t
      } else if (c.kind === K_AMBER) {
        if (t - c.stateStart < tr.amber) return
        c.kind = K_ALLRED
        c.stateStart = t
      } else {
        if (t - c.stateStart < tr.allRed) return
        // Sans matrice, la transition ne dépend pas de la phase visée : on garde la décision tardive
        // d'origine, plus réactive à la demande apparue pendant l'inter-vert.
        const next = tr.matrixBased ? c.nextIndex : this.nextPhase(c, probe)
        // Retour sur (ou avant) la phase courante = nouveau cycle : seul moment où un plan peut changer,
        // et où les traversées sur appel sont retirées au sort.
        if (next <= c.phaseIndex) {
          if (c.planned) {
            const plan = this.selectPlan(c, t)
            if (plan !== c.activePlan) this.applyPlan(c, plan)
          }
          this.startPedestrianCycle(c)
        }
        c.phaseIndex = next
        c.nextIndex = (next + 1) % n
        c.kind = K_GREEN
        c.stateStart = t
        return
      }
    }
  }

  /** Phase suivante ; en `skipEmpty`, première phase suivante ayant de la demande (sinon on reste sur place). */
  private nextPhase(c: ControllerRuntime, probe: SignalProbe): number {
    const n = c.phases.length
    if (!c.skipEmpty) return nextRunningIndex(c, c.phaseIndex)
    for (let k = 1; k <= n; k++) {
      const idx = (c.phaseIndex + k) % n
      const p = c.phases[idx]
      if (!p.runs) continue
      for (let i = 0; i < p.approaches.length; i++) {
        if (probe.queueLength(p.approaches[i]) > 0) return idx
      }
    }
    return c.phaseIndex
  }

  /**
   * Publie l'état de chaque mouvement piloté. `setState` ne rafraîchit `since` que sur changement :
   * un mouvement vert dans deux phases consécutives conserve donc son début de vert (pas de temps perdu
   * au démarrage réappliqué).
   */
  private publish(c: ControllerRuntime): void {
    const since = c.stateStart
    const v = this.variantOf(c, c.pedMask)
    const i = c.phaseIndex
    const j = c.nextIndex
    const table = c.kind === K_GREEN ? v.green[i] : c.kind === K_AMBER ? v.amber[i][j] : v.allRed[i][j]
    for (let k = 0; k < c.allMovs.length; k++) {
      this.setState(c.allMovs[k], table[k], since)
    }
  }

  /* ----------------------------- Traversées sur bouton poussoir ----------------------------- */

  /**
   * Fixe, pour le cycle `cycleNo`, les traversées sur appel qui ne seront pas desservies.
   *
   * `SignalGroup.recall` distingue une traversée en rappel (verte à chaque cycle) d'une traversée sur bouton
   * poussoir. Faute de donnée de demande piétonne dans les dossiers, on retient qu'une traversée sur appel
   * est demandée une fraction `pedestrianCallShare` des cycles (voir `DEFAULT_PEDESTRIAN_CALL_SHARE`) ; les
   * cycles où elle ne l'est pas, les mouvements véhicules qu'elle ferme restent ouverts et le carrefour
   * écoule davantage. Le tirage est une fonction pure de (graine, contrôleur, groupe, numéro de cycle) : le
   * mode fixe situe son cycle par le temps et peut être interrogé deux fois au même instant, un flux
   * séquentiel rendrait alors le résultat dépendant de l'ordre des appels.
   */
  private setPedestrianCycle(c: ControllerRuntime, cycleNo: number): void {
    if (!c.optionalPeds.length || c.pedCycle === cycleNo) return
    c.pedCycle = cycleNo
    let mask = 0
    for (let i = 0; i < c.optionalPeds.length; i++) {
      const tirage = createRng(streamSeed(c.seed, `${c.optionalPeds[i]}|${cycleNo}`))()
      if (tirage >= this.pedestrianCallShare) mask |= 1 << i
    }
    c.pedMask = mask
  }

  /** Tables d'états d'un masque de traversées non desservies, construites à la demande et mémorisées. */
  private variantOf(c: ControllerRuntime, mask: number): VariantStates {
    const known = c.variants.get(mask)
    if (known) return known
    // 2^n masques sont possibles : on borne le cache plutôt que de laisser la mémoire enfler sur un
    // carrefour à nombreuses traversées. Le masque 0 est conservé, c'est lui qui sert de référence.
    if (c.variants.size > 32) {
      const base = c.variants.get(0)
      c.variants.clear()
      if (base) c.variants.set(0, base)
    }
    const built = this.buildVariant(c, mask)
    c.variants.set(mask, built)
    return built
  }

  private buildVariant(c: ControllerRuntime, mask: number): VariantStates {
    const skipped = new Set<string>()
    for (let i = 0; i < c.optionalPeds.length; i++) if (mask & (1 << i)) skipped.add(c.optionalPeds[i])
    const n = c.phases.length
    const width = c.allMovs.length
    const green: Uint8Array[] = []
    const slots: number[][] = []
    for (let i = 0; i < n; i++) {
      // Masque nul : on réutilise les tables de la phase, calculées à la construction (mêmes valeurs).
      if (!mask) {
        green.push(c.phases[i].greenStates)
        slots.push(c.phases[i].greenSlots)
        continue
      }
      const states = new Uint8Array(width).fill(SIG_RED)
      const list: number[] = []
      for (const [key, kind] of Object.entries(phaseMovements(c.spec, c.spec.phases[i], skipped))) {
        const mv = this.g.movementOf.get(key)
        if (mv === undefined) continue
        const slot = c.slotOf.get(mv)
        if (slot === undefined) continue // mouvement interne au regroupement : toujours franchissable
        states[slot] = kind === 'permitted' ? SIG_GREEN_PERMITTED : SIG_GREEN_PROTECTED
        list.push(slot)
      }
      green.push(states)
      slots.push(list)
    }
    const amber: Uint8Array[][] = []
    const allRed: Uint8Array[][] = []
    for (let i = 0; i < n; i++) {
      const rowA: Uint8Array[] = []
      const rowR: Uint8Array[] = []
      for (let j = 0; j < n; j++) {
        const a = new Uint8Array(width).fill(SIG_RED)
        const r = new Uint8Array(width).fill(SIG_RED)
        for (const slot of slots[i]) {
          // Avec une matrice d'inter-verts, un groupe vert dans les deux phases ne s'éteint pas entre elles :
          // c'est ce qui distingue une transition réelle d'un « tout au jaune ». Sans matrice, on conserve le
          // comportement historique (tout ce qui était vert passe au jaune puis au rouge).
          const maintained = c.transitions[i][j].matrixBased && green[j][slot] !== SIG_RED
          a[slot] = maintained ? green[i][slot] : SIG_AMBER
          if (maintained) r[slot] = green[i][slot]
        }
        rowA.push(a)
        rowR.push(r)
      }
      amber.push(rowA)
      allRed.push(rowR)
    }
    return { green, amber, allRed }
  }

  /** États publiés dans les frames. */
  states(t: number): ControllerState[] {
    const out: ControllerState[] = []
    for (const c of this.controllers) {
      if (c.mode === 'flashing' || c.mode === 'off') {
        out.push({ id: c.id, phaseIndex: -1, state: c.mode === 'flashing' ? 'flashing' : 'off', remaining: 0 })
        continue
      }
      if (c.phases.length === 0 || c.cycle <= 0) {
        out.push({ id: c.id, phaseIndex: 0, state: 'allred', remaining: 0 })
        continue
      }
      const p = c.phases[c.phaseIndex]
      const tr = c.transitions[c.phaseIndex][c.nextIndex]
      const elapsed = Number.isFinite(c.stateStart) ? t - c.stateStart : 0
      const total = c.kind === K_GREEN
        ? (c.mode === 'actuated' ? p.maxGreen : p.green)
        : c.kind === K_AMBER ? tr.amber : tr.allRed
      out.push({
        id: c.id,
        phaseIndex: c.phaseIndex,
        state: c.kind === K_GREEN ? 'green' : c.kind === K_AMBER ? 'amber' : 'allred',
        remaining: Math.max(0, total - elapsed),
      })
    }
    return out
  }

  /**
   * Part du cycle pendant laquelle au moins un mouvement du tronçon est vert (1 hors feux) —
   * dénominateur de la saturation (§5.7).
   *
   * Elle est calculée sur le **plan en vigueur à l'appel** : une bascule de plan la change, et la simulation
   * la réévalue alors (voir `planEpoch`). Les traversées sur bouton poussoir sont comptées desservies, cas
   * le plus défavorable : la capacité annoncée est un minorant, stable d'un cycle à l'autre.
   */
  greenShareByEdge(): Float64Array {
    const share = new Float64Array(this.g.edgeIds.length).fill(1)
    for (const c of this.controllers) {
      if (c.mode !== 'fixed' && c.mode !== 'actuated') continue
      if (c.cycle <= 0) continue
      const green = new Map<number, number>()
      const controlledEdges = new Set<number>()
      for (let i = 0; i < c.allMovs.length; i++) {
        const from = this.g.movementFrom[c.allMovs[i]]
        if (from >= 0) controlledEdges.add(from)
      }
      for (const p of c.phases) {
        for (let i = 0; i < p.approaches.length; i++) {
          const e = p.approaches[i]
          green.set(e, (green.get(e) ?? 0) + p.green)
        }
      }
      for (const e of controlledEdges) share[e] = (green.get(e) ?? 0) / c.cycle
    }
    return share
  }
}
