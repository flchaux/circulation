/**
 * Agrégation des indicateurs et des séries temporelles (§5.7 de docs/ARCHITECTURE.md).
 *
 * Conventions :
 *  - les tableaux par tronçon, par sortie et par carrefour sont calculés **hors chauffe** ;
 *  - `NetworkStats.entered / exited / inCirculation / notInjected` couvrent toute l'exécution afin que
 *    la conservation des véhicules soit exacte quelle que soit la durée de chauffe ;
 *  - les séries couvrent l'axe complet (chauffe comprise), chaque valeur étant calculée sur son intervalle.
 */
import type {
  ApproachStats, EdgeId, EdgeStats, ExitStats, Network, NetworkStats, NodeId, SimResults, SimSeries, SimSettings,
} from '@/model/types'
import type { EngineGraph } from './routing'

export interface StatsContext {
  seed: number
  reachedS: number
  completed: boolean
  inCirculation: number
  notInjected: number
  warnings: string[]
}

/** Décrit un carrefour retenu dans le tableau des résultats. */
interface Junction {
  nodeId: NodeId
  approaches: number[]
}

export class StatsCollector {
  private readonly g: EngineGraph
  private readonly settings: SimSettings
  private readonly warmupS: number
  private readonly durationS: number
  private readonly intervalS: number
  private readonly dt: number

  /* --- cumuls hors chauffe, par tronçon --- */
  private readonly entered: Float64Array
  private readonly exited: Float64Array
  private readonly travelSum: Float64Array
  private readonly delaySum: Float64Array
  private readonly queueSum: Float64Array
  private readonly queueMax: Float64Array
  private samples = 0

  /* --- cumuls de l'intervalle courant --- */
  private readonly iExited: Float64Array
  private readonly iEnteredEdge: Float64Array
  private readonly iDelaySum: Float64Array
  private readonly iQueueSum: Float64Array
  private iSamples = 0
  private iEntered = 0
  private iExitedVeh = 0
  private iDelayVeh = 0

  /* --- séries --- */
  private readonly times: number[] = []
  private readonly sFlow: number[][] = []
  private readonly sDelay: number[][] = []
  private readonly sQueue: number[][] = []
  private readonly sExitCount: number[][] = []
  private readonly sNet = { entered: [] as number[], exited: [] as number[], inCirculation: [] as number[], meanDelay: [] as number[] }
  private intervalStart = 0
  /** Incrémenté à chaque intervalle clos : le Worker s'en sert pour émettre un message `stats`. */
  intervalsClosed = 0

  /* --- sorties --- */
  private readonly exitIds: NodeId[]
  private readonly exitSlot = new Map<NodeId, number>()
  private readonly exitCount: Float64Array
  private readonly exitTravel: Float64Array
  private readonly exitDelay: Float64Array
  private readonly iExitCount: Float64Array

  /* --- réseau --- */
  private netEntered = 0
  private netExited = 0
  private measExited = 0
  private totalDelay = 0
  private tripTimeSum = 0
  private vehMeters = 0

  private greenShare: Float64Array

  private readonly junctions: Junction[]

  constructor(graph: EngineGraph, network: Network, settings: SimSettings, greenShare: Float64Array) {
    this.g = graph
    this.settings = settings
    this.warmupS = Math.max(0, settings.warmupMin * 60)
    this.durationS = Math.max(0, settings.durationMin * 60)
    this.intervalS = Math.max(60, settings.statsIntervalMin * 60)
    this.dt = settings.dt > 0 ? settings.dt : 1
    this.greenShare = greenShare

    const n = graph.edgeIds.length
    this.entered = new Float64Array(n)
    this.exited = new Float64Array(n)
    this.travelSum = new Float64Array(n)
    this.delaySum = new Float64Array(n)
    this.queueSum = new Float64Array(n)
    this.queueMax = new Float64Array(n)
    this.iExited = new Float64Array(n)
    this.iEnteredEdge = new Float64Array(n)
    this.iDelaySum = new Float64Array(n)
    this.iQueueSum = new Float64Array(n)
    for (let i = 0; i < n; i++) { this.sFlow.push([]); this.sDelay.push([]); this.sQueue.push([]) }

    this.exitIds = graph.nodeIds.filter((id) => {
      const node = network.nodes[id]
      if (!node?.boundary) return false
      const k = graph.nodeOf.get(id)
      return k !== undefined && graph.inStart[k + 1] > graph.inStart[k]
    })
    this.exitIds.forEach((id, i) => this.exitSlot.set(id, i))
    this.exitCount = new Float64Array(this.exitIds.length)
    this.exitTravel = new Float64Array(this.exitIds.length)
    this.exitDelay = new Float64Array(this.exitIds.length)
    this.iExitCount = new Float64Array(this.exitIds.length)
    for (let i = 0; i < this.exitIds.length; i++) this.sExitCount.push([])

    this.junctions = collectJunctions(graph, network)
  }

  setGreenShare(share: Float64Array): void {
    this.greenShare = share
  }

  /** Un véhicule vient d'entrer sur un tronçon (injection ou franchissement). */
  onEdgeEnter(edge: number, t: number): void {
    this.iEnteredEdge[edge]++
    if (t >= this.warmupS) this.entered[edge]++
  }

  /**
   * Un véhicule quitte un tronçon : temps de parcours mesuré.
   * Le retard n'est PAS comptabilisé ici mais à chaque pas dans `sampleQueue`, afin que les véhicules
   * bloqués qui ne sortent jamais du tronçon soient comptés eux aussi.
   */
  onEdgeLeave(edge: number, travel: number, _delay: number, t: number): void {
    this.iExited[edge]++
    if (t < this.warmupS) return
    this.exited[edge]++
    this.travelSum[edge] += travel
    this.vehMeters += this.g.length[edge]
  }

  onInject(): void {
    this.netEntered++
    this.iEntered++
  }

  /** Un véhicule a atteint sa destination. */
  onFinish(t: number, departTime: number, delay: number, exitNode: NodeId | null): void {
    this.netExited++
    const slot = exitNode === null ? undefined : this.exitSlot.get(exitNode)
    if (slot !== undefined) this.iExitCount[slot]++
    this.iExitedVeh++
    this.iDelayVeh += delay
    if (t < this.warmupS) return
    this.measExited++
    this.tripTimeSum += t - departTime
    if (slot !== undefined) {
      this.exitCount[slot]++
      this.exitTravel[slot] += t - departTime
      this.exitDelay[slot] += delay
    }
  }

  /** Échantillonnage des files : appelé une fois par pas, seulement sur les tronçons occupés. */
  beginSample(t: number): void {
    this.iSamples++
    if (t >= this.warmupS) this.samples++
  }

  /**
   * Files d'attente d'un pas. Chaque véhicule en attente accumule `dt` secondes de retard : cette mesure
   * continue égale, pour un véhicule qui finit par passer, son temps de parcours moins le temps à vide,
   * et capte en plus le retard des véhicules encore bloqués à la fin de la période.
   */
  sampleQueue(edge: number, queue: number, t: number): void {
    this.iQueueSum[edge] += queue
    const retard = queue * this.dt
    this.iDelaySum[edge] += retard
    if (t < this.warmupS) return
    this.queueSum[edge] += queue
    this.delaySum[edge] += retard
    this.totalDelay += retard
    if (queue > this.queueMax[edge]) this.queueMax[edge] = queue
  }

  /** Clôt les intervalles terminés (appelé après l'avancement de l'horloge). */
  closeIntervals(t: number, inCirculation: number): void {
    while (t >= this.intervalStart + this.intervalS) {
      this.closeInterval(this.intervalStart, this.intervalS, inCirculation)
      this.intervalStart += this.intervalS
    }
  }

  /** Clôt l'intervalle en cours même s'il est incomplet (fin de simulation). */
  flush(t: number, inCirculation: number): void {
    if (t > this.intervalStart && this.iSamples > 0) {
      this.closeInterval(this.intervalStart, t - this.intervalStart, inCirculation)
      this.intervalStart = t
    }
  }

  private closeInterval(start: number, span: number, inCirculation: number): void {
    const n = this.g.edgeIds.length
    const hours = span / 3600
    for (let e = 0; e < n; e++) {
      const ex = this.iExited[e]
      this.sFlow[e].push(hours > 0 ? ex / hours : 0)
      // Retard moyen par véhicule entré sur le tronçon pendant l'intervalle.
      const en = this.iEnteredEdge[e]
      this.sDelay[e].push(en > 0 ? this.iDelaySum[e] / en : 0)
      this.sQueue[e].push(this.iSamples > 0 ? this.iQueueSum[e] / this.iSamples : 0)
      this.iExited[e] = 0
      this.iDelaySum[e] = 0
      this.iEnteredEdge[e] = 0
      this.iQueueSum[e] = 0
    }
    for (let i = 0; i < this.exitIds.length; i++) {
      this.sExitCount[i].push(this.iExitCount[i])
      this.iExitCount[i] = 0
    }
    this.times.push(start)
    this.sNet.entered.push(this.iEntered)
    this.sNet.exited.push(this.iExitedVeh)
    this.sNet.inCirculation.push(inCirculation)
    this.sNet.meanDelay.push(this.iExitedVeh > 0 ? this.iDelayVeh / this.iExitedVeh : 0)
    this.iEntered = 0
    this.iExitedVeh = 0
    this.iDelayVeh = 0
    this.iSamples = 0
    this.intervalsClosed++
  }

  build(ctx: StatsContext): SimResults {
    const g = this.g
    const measured = Math.max(1e-9, Math.min(ctx.reachedS, this.warmupS + this.durationS) - this.warmupS)
    const hours = measured / 3600
    const satFlow = this.settings.saturationFlow

    const edges: Record<EdgeId, EdgeStats> = {}
    for (let e = 0; e < g.edgeIds.length; e++) {
      const ex = this.exited[e]
      const en = this.entered[e]
      const meanTravel = ex > 0 ? this.travelSum[e] / ex : g.freeTime[e]
      const flow = hours > 0 ? ex / hours : 0
      const share = Math.max(0.01, this.greenShare[e])
      const capacity = satFlow * g.lanes[e] * share
      edges[g.edgeIds[e]] = {
        entered: this.entered[e],
        exited: ex,
        flowVehH: flow,
        meanSpeedKmh: meanTravel > 0 ? (g.length[e] / meanTravel) * 3.6 : 0,
        meanTravelTimeS: meanTravel,
        totalDelayS: this.delaySum[e],
        // Rapporté aux véhicules entrés : un tronçon bloqué, dont aucun véhicule ne sort, affiche
        // bien le retard qu'il inflige au lieu de zéro.
        meanDelayS: en > 0 ? this.delaySum[e] / en : 0,
        maxQueue: this.queueMax[e],
        meanQueue: this.samples > 0 ? this.queueSum[e] / this.samples : 0,
        saturation: capacity > 0 ? flow / capacity : 0,
      }
    }

    const exits: Record<NodeId, ExitStats> = {}
    for (let i = 0; i < this.exitIds.length; i++) {
      const c = this.exitCount[i]
      exits[this.exitIds[i]] = {
        count: c,
        flowVehH: hours > 0 ? c / hours : 0,
        meanTravelTimeS: c > 0 ? this.exitTravel[i] / c : 0,
        meanDelayS: c > 0 ? this.exitDelay[i] / c : 0,
      }
    }

    const intersections: Record<NodeId, { approaches: Record<EdgeId, ApproachStats> }> = {}
    for (const j of this.junctions) {
      const approaches: Record<EdgeId, ApproachStats> = {}
      for (const e of j.approaches) {
        const s = edges[g.edgeIds[e]]
        // `entered` et non `exited` : une approche bloquée doit peser dans le retard du carrefour,
        // et `meanDelayS × vehicles` doit redonner le retard total de l'approche.
        approaches[g.edgeIds[e]] = { vehicles: s.entered, meanDelayS: s.meanDelayS, maxQueue: s.maxQueue }
      }
      intersections[j.nodeId] = { approaches }
    }

    const network: NetworkStats = {
      entered: this.netEntered,
      exited: this.netExited,
      inCirculation: ctx.inCirculation,
      notInjected: ctx.notInjected,
      totalDelayS: this.totalDelay,
      meanDelayS: this.measExited > 0 ? this.totalDelay / this.measExited : 0,
      meanTravelTimeS: this.measExited > 0 ? this.tripTimeSum / this.measExited : 0,
      vehKm: this.vehMeters / 1000,
    }

    const series: SimSeries = {
      times: this.times.slice(),
      edges: {},
      exits: {},
      network: {
        entered: this.sNet.entered.slice(),
        exited: this.sNet.exited.slice(),
        inCirculation: this.sNet.inCirculation.slice(),
        meanDelay: this.sNet.meanDelay.slice(),
      },
    }
    for (let e = 0; e < g.edgeIds.length; e++) {
      series.edges[g.edgeIds[e]] = { flow: this.sFlow[e].slice(), delay: this.sDelay[e].slice(), queue: this.sQueue[e].slice() }
    }
    for (let i = 0; i < this.exitIds.length; i++) {
      series.exits[this.exitIds[i]] = { count: this.sExitCount[i].slice() }
    }

    return {
      seed: ctx.seed,
      durationS: this.durationS,
      warmupS: this.warmupS,
      intervalS: this.intervalS,
      reachedS: ctx.reachedS,
      completed: ctx.completed,
      network,
      edges,
      exits,
      intersections,
      series,
      warnings: ctx.warnings.slice(),
    }
  }
}

/**
 * Carrefours retenus : nœuds intérieurs ayant au moins trois voisins distincts, ou une régulation explicite
 * (stop, cédez-le-passage, feux). Les simples points de géométrie d'une rue sont écartés.
 */
function collectJunctions(graph: EngineGraph, network: Network): Junction[] {
  const out: Junction[] = []
  for (let n = 0; n < graph.nodeIds.length; n++) {
    const nodeId = graph.nodeIds[n]
    if (network.nodes[nodeId].boundary) continue
    const approaches: number[] = []
    const neighbours = new Set<number>()
    for (let k = graph.inStart[n]; k < graph.inStart[n + 1]; k++) {
      const e = graph.inList[k]
      approaches.push(e)
      neighbours.add(graph.edgeFromNode[e])
    }
    for (let k = graph.outStart[n]; k < graph.outStart[n + 1]; k++) neighbours.add(graph.edgeToNode[graph.outList[k]])
    if (approaches.length === 0) continue
    const explicit = network.controls[nodeId]
    const regulated = explicit && explicit.type !== 'priority_class' && explicit.type !== 'priority_right'
    if (neighbours.size < 3 && !regulated) continue
    out.push({ nodeId, approaches })
  }
  return out
}
