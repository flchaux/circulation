/**
 * Moteur mésoscopique à files d'attente (§5.1 et §5.2 de docs/ARCHITECTURE.md).
 *
 * Chaque tronçon porte une file FIFO ; à chaque pas de 1 s, les `lanes` premiers véhicules arrivés en tête
 * sont examinés et transférés au tronçon suivant s'ils disposent du budget de leur place, si le mouvement
 * est franchissable (feux, priorités) et si l'aval n'est pas plein. Les véhicules restent individuels :
 * leur identifiant est stable et leur position interpolable côté interface.
 */
import type {
  ControllerId, Demand, EdgeId, NetEdge, Network, NodeControl, NodeId, SignalController, SimResults, SimSettings,
} from '@/model/types'
import type { EngineInit, Frame } from './protocol'
import { VEHICLE_STRIDE } from './protocol'
import type { Arrival } from './demand'
import { generateArrivals } from './demand'
import type { EngineGraph, RouteResult } from './routing'
import { Router, buildGraph } from './routing'
import { SIG_AMBER, SIG_FREE, SIG_GREEN_PERMITTED, SIG_GREEN_PROTECTED, SIG_RED, SignalEngine } from './signals'
import type { SignalClock, SignalProbe } from './signals'
import type { PriorityTables } from './priority'
import { buildPriorityTables, yieldCapacity } from './priority'
import { StatsCollector } from './stats'
import { createRng, shuffleInPlace, streamSeed } from './rng'

/** Constante de temps (s) de l'EMA des flux de mouvement servant aux capacités de cession. */
const FLOW_EMA_TAU = 60
/** Constante de temps (s) de l'EMA des temps de parcours (routage dynamique). */
const TRAVEL_EMA_TAU = 300

interface Vehicle {
  id: number
  route: Int32Array
  moves: Int32Array
  routeIdx: number
  edgeEnterTime: number
  /** Instant où le véhicule atteint le bout du tronçon en écoulement libre. */
  arrivalTime: number
  departTime: number
  /** Nœud frontière de sortie visé (null pour une destination interne). */
  exitNode: NodeId | null
  /** Retard cumulé sur les tronçons déjà parcourus (s). */
  delay: number
  /** Instant où le véhicule a été examiné en tête pour la première fois (arrêt au stop). */
  headSince: number
}

interface Pending {
  id: number
  arrival: Arrival
  route: RouteResult | null
  resolved: boolean
  /** La destination a déjà été redirigée une fois : ne pas retenter indéfiniment. */
  reassigned?: boolean
}

/** Sorties atteignables depuis une entrée, avec leurs poids cumulés pour le tirage. */
interface ReachableExits {
  ids: NodeId[]
  cumul: Float64Array
  total: number
}

export class Simulation {
  readonly edgeIndex: EdgeId[]
  readonly warnings: string[] = []

  private net: Network
  private readonly demand: Demand
  private readonly settings: SimSettings
  private readonly dt: number
  private readonly warmupS: number
  private readonly endT: number

  private graph: EngineGraph
  private router: Router
  private signals: SignalEngine
  private prio: PriorityTables
  private stats: StatsCollector
  private arrivals: Arrival[] = []

  /* --- état par tronçon --- */
  private queues: (Vehicle | undefined)[][] = []
  private qHead!: Int32Array
  /** Nombre de véhicules en tête de file (arrivés) — la longueur de file au sens des statistiques. */
  private arrived!: Int32Array
  private count!: Int32Array
  private capacity!: Int32Array
  private laneOffset!: Int32Array
  private budgetLane!: Float64Array
  private budgetTime!: Float64Array
  private lastActivity!: Float64Array
  private travelEma!: Float64Array
  private travelEmaTime!: Float64Array

  /* --- état par mouvement --- */
  private budgetM!: Float64Array
  private budgetMStep!: Int32Array
  private flowEma!: Float64Array
  private flowEmaTime!: Float64Array

  /* --- horloge et véhicules --- */
  private t = 0
  private stepNo = 0
  private _done = false
  private prepared = -1
  private nextArrival = 0
  private pending: Pending[] = []
  private vehiclesOnNetwork = 0
  private noRouteCount = 0
  private noRouteWarned = false
  private reassignedCount = 0
  /** Sorties atteignables par entrée, calculées à la première impasse puis mémorisées. */
  private reachableExits = new Map<NodeId, ReachableExits>()
  /** Flux aléatoire de redirection par entrée : la redirection reste déterministe et reproductible. */
  private reassignRng = new Map<NodeId, () => number>()
  private lastRoutingUpdate = 0

  private active: number[] = []
  private inActive!: Uint8Array
  private dischargeList!: Int32Array
  private shuffleRng: () => number = () => 0
  private readonly probe: SignalProbe
  /** Heure simulée et réglages du moteur de feux (graine des appels piétons comprise). */
  private readonly signalClock: SignalClock
  /** Dernière bascule de plan horaire prise en compte dans la part de vert des statistiques. */
  private planEpoch = 0

  constructor(init: EngineInit) {
    this.net = init.network
    this.demand = init.demand
    this.settings = init.settings
    this.dt = init.settings.dt > 0 ? init.settings.dt : 1
    this.warmupS = Math.max(0, init.settings.warmupMin * 60)
    this.endT = this.warmupS + Math.max(0, init.settings.durationMin * 60)

    this.graph = buildGraph(this.net)
    this.edgeIndex = this.graph.edgeIds
    this.router = new Router(this.graph)
    this.signalClock = {
      startTimeOfDayMin: this.settings.startTimeOfDayMin,
      dayOfWeek: this.settings.dayOfWeek,
      // Les appels piétons sont tirés au sort : ils suivent la graine de la simulation, comme le reste.
      seed: this.demand.seed,
      // Part des cycles où une traversée sur bouton poussoir est appelée. `SimSettings` ne porte pas encore
      // ce réglage : tant qu'il est absent, l'hypothèse par défaut du modèle s'applique.
      pedestrianCallShare: (this.settings as SimSettings & { pedestrianCallShare?: number }).pedestrianCallShare,
    }
    this.signals = new SignalEngine(this.graph, this.net, this.signalClock)
    this.prio = buildPriorityTables(this.graph, this.net, this.settings, this.signals.signalizedNodes)
    this.stats = new StatsCollector(this.graph, this.net, this.settings, this.signals.greenShareByEdge())
    this.planEpoch = this.signals.planEpoch
    this.probe = {
      lastActivity: (e: number) => this.lastActivity[e],
      queueLength: (e: number) => this.arrived[e],
    }
    this.warnings.push(...this.signals.warnings)
    this.allocate()
    this.reset()
  }

  get time(): number { return this.t }
  get endTime(): number { return this.endT }
  get done(): boolean { return this._done }
  /** Nombre d'intervalles de statistiques clos (le Worker émet un message `stats` à chaque incrément). */
  get intervalsClosed(): number { return this.stats.intervalsClosed }

  /* ----------------------------- Initialisation ----------------------------- */

  private allocate(): void {
    const g = this.graph
    const n = g.edgeIds.length
    this.qHead = new Int32Array(n)
    this.arrived = new Int32Array(n)
    this.count = new Int32Array(n)
    this.capacity = new Int32Array(n)
    this.laneOffset = new Int32Array(n)
    this.budgetTime = new Float64Array(n)
    this.lastActivity = new Float64Array(n)
    this.travelEma = new Float64Array(n)
    this.travelEmaTime = new Float64Array(n)
    this.inActive = new Uint8Array(n)
    this.dischargeList = new Int32Array(n)
    let lanes = 0
    const vehLen = Math.max(1, this.settings.vehicleLength)
    for (let e = 0; e < n; e++) {
      this.laneOffset[e] = lanes
      lanes += g.lanes[e]
      this.capacity[e] = Math.max(g.lanes[e], Math.floor(g.length[e] / vehLen) * g.lanes[e])
    }
    this.budgetLane = new Float64Array(lanes)
    const m = g.movements.length
    this.budgetM = new Float64Array(m)
    this.budgetMStep = new Int32Array(m)
    this.flowEma = new Float64Array(m)
    this.flowEmaTime = new Float64Array(m)
  }

  reset(): void {
    const g = this.graph
    const n = g.edgeIds.length
    this.queues = new Array<(Vehicle | undefined)[]>(n)
    for (let e = 0; e < n; e++) this.queues[e] = []
    this.qHead.fill(0)
    this.arrived.fill(0)
    this.count.fill(0)
    this.budgetLane.fill(1)
    this.budgetTime.fill(0)
    this.lastActivity.fill(-Infinity)
    this.travelEma.set(g.freeTime)
    this.travelEmaTime.fill(0)
    this.budgetM.fill(0)
    this.budgetMStep.fill(-2)
    this.flowEma.fill(0)
    this.flowEmaTime.fill(0)
    this.inActive.fill(0)
    this.active = []
    this.t = 0
    this.stepNo = 0
    this._done = this.endT <= 0
    this.prepared = -1
    this.nextArrival = 0
    this.pending = []
    this.vehiclesOnNetwork = 0
    this.noRouteCount = 0
    this.noRouteWarned = false
    this.reassignedCount = 0
    this.reachableExits.clear()
    this.reassignRng.clear()
    this.lastRoutingUpdate = 0
    this.shuffleRng = createRng(streamSeed(this.demand.seed, 'discharge-order'))
    this.signals.reset()
    this.router = new Router(this.graph)
    this.stats = new StatsCollector(this.graph, this.net, this.settings, this.signals.greenShareByEdge())
    this.planEpoch = this.signals.planEpoch
    this.arrivals = generateArrivals(this.net, this.demand, this.settings)
    if (this.arrivals.length === 0) this.pushWarningOnce('Aucun véhicule à injecter : vérifiez les débits d’entrée.')
    this.prepare(0)
  }

  private pushWarningOnce(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message)
  }

  /* ----------------------------- Boucle ----------------------------- */

  step(steps = 1): void {
    for (let i = 0; i < steps && !this._done; i++) this.stepOnce()
  }

  private stepOnce(): void {
    const t = this.t
    this.prepare(t)
    if (this.settings.dynamicRouting && t - this.lastRoutingUpdate >= this.settings.routingIntervalMin * 60) {
      this.router.setCosts(this.travelEma.slice())
      this.lastRoutingUpdate = t
    }
    this.injectArrivals(t)
    this.discharge(t)
    this.sample(t)
    this.stepNo++
    this.t = t + this.dt
    this.stats.closeIntervals(this.t, this.vehiclesOnNetwork)
    if (this.t >= this.endT) {
      this.t = this.endT
      this._done = true
      this.prepare(this.t)
      this.stats.flush(this.t, this.vehiclesOnNetwork)
    }
  }

  /**
   * Amène l'état dépendant du temps (têtes de file, feux) au temps `t`. Idempotent : `frame()` peut
   * l'appeler pour publier des états cohérents avec l'horloge courante.
   */
  private prepare(t: number): void {
    if (this.prepared === t) return
    this.prepared = t
    this.advanceHeads(t)
    this.signals.update(t, this.probe)
    // Une bascule de plan horaire change les durées de vert, donc la capacité des approches : le
    // dénominateur de la saturation suit le plan appliqué et non celui du démarrage (§14.4).
    if (this.signals.planEpoch !== this.planEpoch) {
      this.planEpoch = this.signals.planEpoch
      this.stats.setGreenShare(this.signals.greenShareByEdge(), t)
    }
  }

  /** Fait entrer en tête de file les véhicules ayant atteint le bout de leur tronçon, et compacte la liste active. */
  private advanceHeads(t: number): void {
    const active = this.active
    let w = 0
    for (let i = 0; i < active.length; i++) {
      const e = active[i]
      if (this.count[e] === 0) { this.inActive[e] = 0; continue }
      active[w++] = e
      const q = this.queues[e]
      let a = this.arrived[e]
      const head = this.qHead[e]
      // Les places au-delà de `qHead` sont toujours occupées : les trous sont derrière la tête.
      for (let j = head + a; j < q.length; j++) {
        const v = q[j]
        if (!v || v.arrivalTime > t) break
        a++
        this.lastActivity[e] = t // détecteur de ligne d'arrêt : arrivée en tête de file
      }
      this.arrived[e] = a
    }
    active.length = w
  }

  private markActive(e: number): void {
    if (!this.inActive[e]) {
      this.inActive[e] = 1
      this.active.push(e)
    }
  }

  /* ----------------------------- Injection ----------------------------- */

  private injectArrivals(t: number): void {
    while (this.nextArrival < this.arrivals.length && this.arrivals[this.nextArrival].time <= t) {
      this.pending.push({ id: this.nextArrival, arrival: this.arrivals[this.nextArrival], route: null, resolved: false })
      this.nextArrival++
    }
    if (this.pending.length === 0) return
    // Un tronçon de départ saturé bloque la file virtuelle qui le vise, sans bloquer les autres entrées.
    const blocked = new Set<number>()
    let w = 0
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i]
      if (!p.resolved) {
        p.route = this.computeRoute(p.arrival)
        // Destination inatteignable depuis cette entrée (sens uniques, coupure) : on redirige le véhicule
        // vers une sortie réellement accessible plutôt que de le perdre, ce qui fausserait les débits.
        if (!p.route && !p.reassigned && p.arrival.entryId !== null) {
          p.reassigned = true
          p.route = this.reassignDestination(p.arrival)
          if (p.route) this.reassignedCount++
        }
        p.resolved = true
        if (!p.route) {
          this.noRouteCount++
          if (!this.noRouteWarned) {
            this.noRouteWarned = true
            this.pushWarningOnce('Certains véhicules n’ont aucun itinéraire vers leur destination : ils ne sont pas injectés.')
          }
          continue
        }
      }
      const first = p.route!.route[0]
      if (blocked.has(first) || this.count[first] >= this.capacity[first]) {
        blocked.add(first)
        this.pending[w++] = p
        continue
      }
      this.injectVehicle(p, t)
    }
    this.pending.length = w
  }

  /** Libellé lisible d'une entrée : son étiquette, sinon le nom de la voie qui en part. */
  private describeEntry(entryId: NodeId): string {
    const label = this.net.nodes[entryId]?.label
    if (label) return `« ${label} »`
    for (const e of Object.values(this.net.edges)) {
      if (e.from === entryId && e.name) return `« ${e.name} »`
    }
    return `« ${entryId} »`
  }

  /**
   * Sorties atteignables depuis une entrée. Le calcul s'appuie sur les tables de coût par sortie du routeur,
   * déjà mémorisées, et n'est fait qu'une fois par entrée et par exécution.
   */
  private reachableExitsFrom(entryId: NodeId, node: number): ReachableExits {
    const memo = this.reachableExits.get(entryId)
    if (memo) return memo
    const ids: NodeId[] = []
    const poids: number[] = []
    for (const exitId of Object.keys(this.demand.exits).sort()) {
      const config = this.demand.exits[exitId]
      if (!config.enabled || config.weight <= 0) continue
      if (exitId === entryId) continue
      if (!this.router.routeFromNodeToExit(node, exitId)) continue
      ids.push(exitId)
      poids.push(config.weight)
    }
    const cumul = new Float64Array(ids.length)
    let total = 0
    for (let i = 0; i < ids.length; i++) {
      total += poids[i]
      cumul[i] = total
    }
    const res: ReachableExits = { ids, cumul, total }
    this.reachableExits.set(entryId, res)
    return res
  }

  /**
   * Redirige une arrivée dont la destination est inatteignable vers une sortie accessible, tirée au prorata
   * des poids de sortie. Renvoie `null` si l'entrée ne dessert aucune sortie (elle est alors signalée).
   */
  private reassignDestination(a: Arrival): RouteResult | null {
    const entryId = a.entryId
    if (entryId === null) return null
    const node = this.graph.nodeOf.get(entryId)
    if (node === undefined) return null
    const reachable = this.reachableExitsFrom(entryId, node)
    if (reachable.total <= 0) {
      this.pushWarningOnce(
        `Aucune sortie n’est atteignable depuis l’entrée ${this.describeEntry(entryId)} : `
        + 'ses véhicules ne sont pas injectés. Désactivez cette entrée dans l’onglet Trafic ou vérifiez les sens uniques.',
      )
      return null
    }
    let rng = this.reassignRng.get(entryId)
    if (!rng) {
      rng = createRng(streamSeed(this.demand.seed, `reassign:${entryId}`))
      this.reassignRng.set(entryId, rng)
    }
    const cible = rng() * reachable.total
    let lo = 0
    let hi = reachable.ids.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (reachable.cumul[mid] < cible) lo = mid + 1
      else hi = mid
    }
    a.exitId = reachable.ids[lo]
    a.destEdgeId = null
    return this.router.routeFromNodeToExit(node, a.exitId)
  }

  private computeRoute(a: Arrival): RouteResult | null {
    const g = this.graph
    if (a.entryId !== null) {
      const node = g.nodeOf.get(a.entryId)
      if (node === undefined) return null
      if (a.destEdgeId !== null) {
        const d = g.edgeOf.get(a.destEdgeId)
        return d === undefined || g.closed[d] ? null : this.router.routeFromNodeToEdge(node, d)
      }
      return a.exitId === null ? null : this.router.routeFromNodeToExit(node, a.exitId)
    }
    if (a.originEdgeId === null) return null
    const s = g.edgeOf.get(a.originEdgeId)
    if (s === undefined || g.closed[s]) return null
    if (a.destEdgeId !== null) {
      const d = g.edgeOf.get(a.destEdgeId)
      return d === undefined || g.closed[d] ? null : this.router.routeToEdge(s, d)
    }
    return a.exitId === null ? null : this.router.routeToExit(s, a.exitId)
  }

  private injectVehicle(p: Pending, t: number): void {
    const route = p.route!
    const first = route.route[0]
    const a = p.arrival
    const v: Vehicle = {
      id: p.id,
      route: route.route,
      moves: route.moves,
      routeIdx: 0,
      edgeEnterTime: t,
      arrivalTime: t + this.graph.freeTime[first],
      departTime: t,
      exitNode: a.exitId,
      delay: 0,
      headSince: -1,
    }
    this.queues[first].push(v)
    this.count[first]++
    this.markActive(first)
    this.vehiclesOnNetwork++
    this.stats.onInject()
    this.stats.onEdgeEnter(first, t)
  }

  /* ----------------------------- Décharge ----------------------------- */

  private discharge(t: number): void {
    const list = this.dischargeList
    let n = 0
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i]
      if (this.arrived[e] > 0) list[n++] = e
    }
    if (n === 0) return
    // Ordre mélangé à chaque pas : aucune approche n'est systématiquement servie en premier.
    shuffleInPlace(list, n, this.shuffleRng)
    for (let i = 0; i < n; i++) this.dischargeEdge(list[i], t)
  }

  private dischargeEdge(e: number, t: number): void {
    this.topUpBudget(e, t)
    const lanes = this.graph.lanes[e]
    const places = Math.min(lanes, this.arrived[e])
    let removed = 0
    for (let k = 0; k < places; k++) {
      const idx = this.qHead[e] + k - removed
      const v = this.queues[e][idx]
      if (!v) break
      if (this.tryMove(v, e, k, idx, t)) removed++
    }
  }

  /** Recharge paresseuse du budget de chaque place depuis le dernier pas où le tronçon a été traité. */
  private topUpBudget(e: number, t: number): void {
    const elapsed = t - this.budgetTime[e]
    if (elapsed <= 0) return
    this.budgetTime[e] = t
    const gain = (this.settings.saturationFlow / 3600) * elapsed
    const off = this.laneOffset[e]
    const lanes = this.graph.lanes[e]
    for (let k = 0; k < lanes; k++) {
      const b = this.budgetLane[off + k] + gain
      this.budgetLane[off + k] = b > 1 ? 1 : b
    }
  }

  /** Tente de faire franchir le carrefour au véhicule occupant la place `k`. Renvoie `true` s'il a quitté le tronçon. */
  private tryMove(v: Vehicle, e: number, k: number, idx: number, t: number): boolean {
    if (v.headSince < 0) v.headSince = t
    const lane = this.laneOffset[e] + k
    const last = v.routeIdx === v.route.length - 1

    if (!last) {
      const mv = v.moves[v.routeIdx]
      const next = v.route[v.routeIdx + 1]
      const state = this.signals.state[mv]
      if (state === SIG_RED) return false
      if (this.count[next] >= this.capacity[next]) return false
      if (state === SIG_GREEN_PROTECTED || state === SIG_GREEN_PERMITTED) {
        // Temps perdu au démarrage : la file ne s'ébranle pas dès la seconde du vert.
        if (t - this.signals.since[mv] < this.settings.startupLostTime) return false
      } else if (state === SIG_AMBER) {
        if (t - this.signals.since[mv] >= this.settings.amberUsable) return false
      }
      const mustYield = state === SIG_GREEN_PERMITTED || (state === SIG_FREE && this.prio.yielding[mv] === 1)
      if (mustYield) {
        if (this.prio.stopRequired[mv] === 1 && t - v.headSince < this.settings.stopDelay) return false
        if (!this.acceptGap(mv, state, t)) return false
      }
      if (this.budgetLane[lane] < 1) return false
      this.budgetLane[lane] -= 1
      if (mustYield) this.budgetM[mv] -= 1
      this.transfer(v, e, next, mv, idx, t)
      return true
    }

    // Véhicule à destination : il quitte le réseau en consommant le budget de sa place.
    if (this.budgetLane[lane] < 1) return false
    this.budgetLane[lane] -= 1
    this.leaveEdge(v, e, idx, t)
    this.vehiclesOnNetwork--
    this.stats.onFinish(t, v.departTime, v.delay, v.exitNode)
    return true
  }

  /** Retire le véhicule du tronçon qu'il quitte et enregistre temps de parcours, retard et EMA. */
  private leaveEdge(v: Vehicle, e: number, idx: number, t: number): void {
    const travel = t - v.edgeEnterTime
    const delay = travel - this.graph.freeTime[e]
    v.delay += delay
    this.stats.onEdgeLeave(e, travel, delay, t)
    this.updateTravelEma(e, travel, t)
    this.removeFromQueue(e, idx)
    this.lastActivity[e] = t // détecteur de ligne d'arrêt : franchissement
  }

  private transfer(v: Vehicle, from: number, to: number, mv: number, idx: number, t: number): void {
    this.leaveEdge(v, from, idx, t)
    this.addFlow(mv, t)

    v.routeIdx++
    v.edgeEnterTime = t
    v.arrivalTime = t + this.graph.freeTime[to]
    v.headSince = -1
    this.queues[to].push(v)
    this.count[to]++
    this.markActive(to)
    this.stats.onEdgeEnter(to, t)
  }

  private removeFromQueue(e: number, idx: number): void {
    const q = this.queues[e]
    if (idx === this.qHead[e]) {
      q[idx] = undefined // libère la référence : la tête ne revient jamais en arrière
      this.qHead[e]++
      // Compactage amorti : la tête ne dérive jamais au-delà de la moitié du tableau.
      if (this.qHead[e] > 32 && this.qHead[e] * 2 > q.length) {
        q.splice(0, this.qHead[e])
        this.qHead[e] = 0
      }
    } else {
      q.splice(idx, 1)
    }
    this.count[e]--
    this.arrived[e]--
    if (this.count[e] === 0) {
      this.qHead[e] = 0
      q.length = 0
    }
  }

  /* ----------------------------- Cession ----------------------------- */

  /** EMA temporelle du flux d'un mouvement (véh/s), lissée sur `FLOW_EMA_TAU`. */
  private flowOf(mv: number, t: number): number {
    const dt = t - this.flowEmaTime[mv]
    if (dt > 0) {
      this.flowEma[mv] *= Math.exp(-dt / FLOW_EMA_TAU)
      this.flowEmaTime[mv] = t
    }
    return this.flowEma[mv]
  }

  private addFlow(mv: number, t: number): void {
    this.flowOf(mv, t)
    this.flowEma[mv] += 1 / FLOW_EMA_TAU
  }

  private updateTravelEma(e: number, travel: number, t: number): void {
    const dt = t - this.travelEmaTime[e]
    const w = dt > 0 ? 1 - Math.exp(-dt / TRAVEL_EMA_TAU) : 0
    this.travelEma[e] += w * (travel - this.travelEma[e])
    this.travelEmaTime[e] = t
  }

  /** Mouvement du véhicule en tête d'un tronçon, ou -1 (aucun véhicule prêt, ou véhicule à destination). */
  private headMovement(e: number): number {
    if (this.arrived[e] <= 0) return -1
    const v = this.queues[e][this.qHead[e]]
    if (!v || v.routeIdx >= v.route.length - 1) return -1
    return v.moves[v.routeIdx]
  }

  /** Contribution d'un mouvement prioritaire au flux conflictuel (véh/s). */
  private conflictFlow(n: number, t: number): number {
    const to = this.graph.movementTo[n]
    if (to < 0 || this.count[to] >= this.capacity[to]) return 0
    const state = this.signals.state[n]
    if (state === SIG_RED) return 0
    let f = this.flowOf(n, t)
    if (this.headMovement(this.graph.movementFrom[n]) === n) {
      // Une file prioritaire qui se décharge sature le créneau : capacité de cession nulle.
      const sat = (this.graph.lanes[this.graph.movementFrom[n]] * this.settings.saturationFlow) / 3600
      if (sat > f) f = sat
    }
    return f
  }

  /**
   * Accumule le budget du mouvement cédant et indique s'il peut franchir.
   * Le budget est remis à zéro dès qu'aucun véhicule n'était en tête au pas précédent.
   */
  private acceptGap(mv: number, state: number, t: number): boolean {
    if (this.budgetMStep[mv] !== this.stepNo) {
      if (this.budgetMStep[mv] !== this.stepNo - 1) this.budgetM[mv] = 0
      this.budgetMStep[mv] = this.stepNo
      let qc = 0
      if (state === SIG_GREEN_PERMITTED) {
        for (let k = this.prio.conflictStart[mv]; k < this.prio.conflictStart[mv + 1]; k++) {
          const n = this.prio.conflictList[k]
          const sn = this.signals.state[n]
          if (sn !== SIG_GREEN_PROTECTED && sn !== SIG_GREEN_PERMITTED) continue
          // Entre deux mouvements permis en conflit, la priorité à droite tranche.
          if (sn === SIG_GREEN_PERMITTED && this.prio.conflictYieldRight[k] === 0) continue
          qc += this.conflictFlow(n, t)
        }
      } else {
        for (let k = this.prio.yieldStart[mv]; k < this.prio.yieldStart[mv + 1]; k++) {
          qc += this.conflictFlow(this.prio.yieldList[k], t)
        }
      }
      const c = yieldCapacity(qc, this.prio.gap[mv], this.settings.followUpTime) * this.dt
      const b = this.budgetM[mv] + c
      this.budgetM[mv] = b > 1 ? 1 : b
    }
    return this.budgetM[mv] >= 1
  }

  /* ----------------------------- Statistiques ----------------------------- */

  private sample(t: number): void {
    this.stats.beginSample(t)
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i]
      const q = this.arrived[e]
      if (q > 0) this.stats.sampleQueue(e, q, t)
    }
  }

  results(): SimResults {
    return this.stats.build({
      seed: this.demand.seed,
      reachedS: this.t,
      completed: this._done,
      inCirculation: this.vehiclesOnNetwork,
      // Une fois la simulation terminée, les arrivées jamais préparées (générées dans la dernière seconde)
      // comptent comme non injectées, pour que « générés = injectés + non injectés » tombe juste.
      // En cours d'exécution elles sont encore à venir : les compter gonflerait le total affiché.
      notInjected: this.noRouteCount + this.pending.length
        + (this._done ? Math.max(0, this.arrivals.length - this.nextArrival) : 0),
      warnings: this.runWarnings(),
    })
  }

  private runWarnings(): string[] {
    const out = this.warnings.slice()
    if (this.noRouteCount > 0) {
      out.push(`${this.noRouteCount} véhicule(s) sans itinéraire : non injectés.`)
    }
    if (this.reassignedCount > 0) {
      out.push(`${this.reassignedCount} véhicule(s) redirigés vers une sortie atteignable (destination initiale inaccessible depuis leur entrée).`)
    }
    if (this.pending.length > 0) {
      out.push(`${this.pending.length} véhicule(s) en attente à l’entrée (réseau saturé).`)
    }
    return out
  }

  /* ----------------------------- Frame ----------------------------- */

  frame(): Frame {
    this.prepare(this.t)
    const t = this.t
    const vehicles = new Float32Array(this.vehiclesOnNetwork * VEHICLE_STRIDE)
    const vehLen = Math.max(1, this.settings.vehicleLength)
    let w = 0
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i]
      const q = this.queues[e]
      const head = this.qHead[e]
      const len = this.graph.length[e]
      const lanes = this.graph.lanes[e]
      const speed = this.graph.speed[e]
      for (let j = head; j < q.length; j++) {
        const v = q[j]
        if (!v) continue
        if (w + VEHICLE_STRIDE > vehicles.length) break
        const free = speed * (t - v.edgeEnterTime)
        const stack = len - ((j - head) * vehLen) / lanes
        // Le tableau étant en Float32, on retire un demi-ulp au plafond : la position transmise ne
        // dépasse jamais la longueur du tronçon, même après arrondi.
        const pos = Math.max(0, Math.min(free, stack, len - len * 6e-8))
        vehicles[w] = v.id
        vehicles[w + 1] = e
        vehicles[w + 2] = pos
        vehicles[w + 3] = v.arrivalTime <= t ? 1 : 0
        w += VEHICLE_STRIDE
      }
    }
    return {
      time: t,
      vehicles: w === vehicles.length ? vehicles : vehicles.slice(0, w),
      controllers: this.signals.states(t),
      counts: {
        inCirculation: this.vehiclesOnNetwork,
        entered: this.injectedCount(),
        exited: this.exitedCount(),
        waitingAtEntries: this.pending.length,
      },
    }
  }

  private injectedCount(): number {
    return this.nextArrival - this.pending.length - this.noRouteCount
  }

  private exitedCount(): number {
    return this.injectedCount() - this.vehiclesOnNetwork
  }

  /* ----------------------------- Feux à chaud ----------------------------- */

  updateSignals(controllers: Record<ControllerId, SignalController>, controls: Record<NodeId, NodeControl>): void {
    this.net = { ...this.net, controllers, controls }
    this.graph.network = this.net
    const previous = this.signals
    this.signals = new SignalEngine(this.graph, this.net, this.signalClock)
    this.signals.adoptStateFrom(previous)
    this.prio = buildPriorityTables(this.graph, this.net, this.settings, this.signals.signalizedNodes)
    this.stats.setGreenShare(this.signals.greenShareByEdge(), this.t)
    this.planEpoch = this.signals.planEpoch
    this.budgetM.fill(0)
    this.budgetMStep.fill(-2)
    this.prepared = -1
    this.prepare(this.t)
  }

  /** Tronçon du réseau par index de `edgeIndex` (diagnostic et tests). */
  edgeAt(index: number): NetEdge {
    return this.net.edges[this.graph.edgeIds[index]]
  }
}
