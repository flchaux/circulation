/**
 * Les k itinéraires les plus courts entre deux nœuds (§5.5 de docs/ARCHITECTURE.md).
 *
 * Sert l'outil de carte « itinéraires » : montrer, entre deux points choisis, non pas le seul plus court
 * chemin mais la petite famille de chemins entre lesquels le trafic se partage vraiment, et le temps que
 * coûte chacun. C'est ce que le routage de la simulation arbitre en permanence sans jamais le montrer.
 *
 * Le calcul se fait sur le **même graphe et les mêmes coûts que le moteur** (`buildGraph`, temps de
 * référence de §5.5) : sens uniques, interdictions de tourner, demi-tours, tronçons fermés et nœuds
 * frontières sont donc respectés, et le retard structurel des carrefours traversés (feux, stops, cessions)
 * compte dans le temps annoncé. Un itinéraire affiché ici est un itinéraire que la simulation pourrait
 * choisir, et le temps affiché est celui qu'elle lui prête à réseau vide.
 *
 * Algorithme : Yen (k plus courts chemins élémentaires), sur le graphe des tronçons orientés.
 */
import type { EdgeId, Network, NodeId, SimSettings } from '@/model/types'
import { MinHeap, buildGraph, structuralDelays, type EngineGraph } from './routing'
import { SignalEngine } from './signals'
import { buildPriorityTables } from './priority'

/** Nombre d'itinéraires proposés par défaut. */
export const NB_ITINERAIRES = 5

/**
 * Plafond du nombre de Dijkstra lancés pour une demande. Yen en lance un par point de déviation possible,
 * soit la longueur du chemin précédent : sur un trajet de bout en bout d'une commune, cela se compte en
 * centaines. Le plafond garde l'outil interactif (calcul synchrone, dans le fil de l'interface) quitte à
 * rendre moins d'itinéraires que demandé — mieux vaut trois itinéraires tout de suite que cinq dans dix
 * secondes, et les premiers trouvés sont de toute façon les meilleurs.
 */
const MAX_RECHERCHES = 1200

/** Un itinéraire complet entre les deux nœuds demandés. */
export interface Itineraire {
  /** Tronçons empruntés, du départ à l'arrivée. */
  edges: EdgeId[]
  /** Nœuds traversés, de l'origine à la destination (`edges.length + 1` éléments). */
  nodes: NodeId[]
  /** Temps de parcours à réseau vide (s), retard des carrefours **traversés** compris. */
  time: number
  /** Longueur cumulée (m). */
  length: number
}

export interface OptionsItineraires {
  /** Nombre d'itinéraires voulus (défaut `NB_ITINERAIRES`). */
  count?: number
  /**
   * Réglages de simulation : sans eux, seul le temps de parcours à vide compte ; avec eux, le retard
   * structurel des carrefours s'y ajoute, comme dans le routage du moteur.
   */
  settings?: SimSettings
}

/**
 * Coûts d'un tronçon, séparés en deux termes parce qu'ils ne s'appliquent pas au même moment :
 *  - `libre` : le temps de parcours du tronçon, toujours compté ;
 *  - `retard` : le retard du carrefour que ce tronçon aborde, compté seulement si l'itinéraire **traverse**
 *    ce carrefour. Le dernier tronçon d'un trajet n'en subit rien : on arrive, on ne franchit pas.
 */
interface Couts {
  libre: Float64Array
  retard: Float64Array
}

function coutsDeReference(graph: EngineGraph, network: Network, settings?: SimSettings): Couts {
  const libre = graph.freeTime
  if (!settings) return { libre, retard: new Float64Array(graph.edgeIds.length) }
  const signals = new SignalEngine(graph, network, {
    startTimeOfDayMin: settings.startTimeOfDayMin,
    dayOfWeek: settings.dayOfWeek,
  })
  const prio = buildPriorityTables(graph, network, settings, signals.signalizedNodes)
  const retard = structuralDelays(
    graph, signals.signalDelayByEdge(), prio.yielding, prio.stopRequired,
    settings.stopDelay, settings.startupLostTime,
  )
  return { libre, retard }
}

/** État initial d'une recherche : on est déjà engagé sur `edge`, pour un coût déjà accumulé de `dist`. */
interface Depart {
  edge: number
  dist: number
}

/**
 * Dijkstra sur le graphe des tronçons, d'un ensemble d'états initiaux vers le premier tronçon qui aboutit
 * au nœud `cible`. Les nœuds marqués dans `bannis` ne peuvent pas être atteints : c'est ainsi que Yen
 * interdit à une déviation de repasser par le début du chemin qu'elle prolonge.
 */
function plusCourt(
  g: EngineGraph,
  couts: Couts,
  departs: Depart[],
  cible: number,
  bannis: Uint8Array,
): { edges: number[]; cost: number } | null {
  const n = g.edgeIds.length
  const dist = new Float64Array(n).fill(Infinity)
  const parent = new Int32Array(n).fill(-1)
  const heap = new MinHeap(64)
  for (const d of departs) {
    if (d.dist < dist[d.edge]) {
      dist[d.edge] = d.dist
      heap.push(d.dist, d.edge)
    }
  }
  let arrivee = -1
  while (heap.size > 0) {
    const e = heap.pop()
    const d = heap.lastKey
    if (d > dist[e]) continue
    if (g.edgeToNode[e] === cible) { arrivee = e; break }
    for (let k = g.succStart[e]; k < g.succStart[e + 1]; k++) {
      const nx = g.movementTo[g.succList[k]]
      if (nx < 0 || g.closed[nx]) continue
      const noeud = g.edgeToNode[nx]
      if (noeud >= 0 && bannis[noeud]) continue
      const nd = d + couts.retard[e] + couts.libre[nx]
      if (nd < dist[nx]) {
        dist[nx] = nd
        parent[nx] = e
        heap.push(nd, nx)
      }
    }
  }
  if (arrivee < 0) return null
  const edges: number[] = []
  for (let cur = arrivee; cur >= 0; cur = parent[cur]) edges.push(cur)
  edges.reverse()
  return { edges, cost: dist[arrivee] }
}

/** Le chemin `p` commence-t-il exactement par `racine`, et va-t-il au moins un tronçon plus loin ? */
function prolonge(p: number[], racine: number[]): boolean {
  if (p.length <= racine.length) return false
  for (let i = 0; i < racine.length; i++) if (p[i] !== racine[i]) return false
  return true
}

/**
 * Les `count` itinéraires les plus courts de `from` vers `to`, du plus rapide au plus lent, sans doublon
 * et sans boucle. Renvoie moins d'itinéraires que demandé s'il n'en existe pas davantage, et `[]` si les
 * deux nœuds sont confondus, inconnus, ou si aucun chemin ne les relie.
 */
export function itinerairesLesPlusCourts(
  network: Network,
  from: NodeId,
  to: NodeId,
  opts: OptionsItineraires = {},
): Itineraire[] {
  const count = Math.max(1, Math.round(opts.count ?? NB_ITINERAIRES))
  if (from === to) return []
  const g = buildGraph(network)
  const source = g.nodeOf.get(from)
  const cible = g.nodeOf.get(to)
  if (source === undefined || cible === undefined) return []
  const couts = coutsDeReference(g, network, opts.settings)

  /** Tronçons par lesquels un itinéraire peut quitter l'origine. */
  const sorties: number[] = []
  for (let k = g.outStart[source]; k < g.outStart[source + 1]; k++) {
    const e = g.outList[k]
    if (!g.closed[e]) sorties.push(e)
  }

  const trouves: { edges: number[]; cost: number }[] = []
  const candidats: { edges: number[]; cost: number }[] = []
  const connus = new Set<string>()
  const cle = (edges: number[]): string => edges.join(',')

  const bannisInitiaux = new Uint8Array(g.nodeIds.length)
  bannisInitiaux[source] = 1
  const premier = plusCourt(g, couts, sorties.map((e) => ({ edge: e, dist: couts.libre[e] })), cible, bannisInitiaux)
  if (!premier) return []
  trouves.push(premier)
  connus.add(cle(premier.edges))

  let recherches = 0
  while (trouves.length < count && recherches < MAX_RECHERCHES) {
    const precedent = trouves[trouves.length - 1].edges
    // Point de déviation : `i = -1` change le tronçon de départ, `i ≥ 0` prolonge les `i + 1` premiers
    // tronçons du chemin précédent puis bifurque.
    for (let i = -1; i < precedent.length - 1 && recherches < MAX_RECHERCHES; i++) {
      const racine = precedent.slice(0, i + 1)
      // Coût de la racine : traversées comprises, sauf celle du carrefour où l'on bifurque (elle est
      // ajoutée avec le premier tronçon de la déviation, qui seul dit quel mouvement est fait).
      let coutRacine = 0
      for (let j = 0; j < racine.length; j++) {
        coutRacine += couts.libre[racine[j]]
        if (j > 0) coutRacine += couts.retard[racine[j - 1]]
      }
      // Nœuds déjà traversés par la racine, origine comprise : la déviation ne doit pas y revenir.
      const bannis = new Uint8Array(g.nodeIds.length)
      bannis[source] = 1
      for (const e of racine) {
        const nd = g.edgeToNode[e]
        if (nd >= 0) bannis[nd] = 1
      }
      // Déviations déjà retenues depuis cette même racine : les reprendre redonnerait un chemin connu.
      const interdits = new Set<number>()
      for (const p of trouves) if (prolonge(p.edges, racine)) interdits.add(p.edges[i + 1])

      const departs: Depart[] = []
      if (i < 0) {
        for (const e of sorties) {
          if (interdits.has(e)) continue
          const nd = g.edgeToNode[e]
          if (nd >= 0 && bannis[nd]) continue
          departs.push({ edge: e, dist: couts.libre[e] })
        }
      } else {
        const pivot = racine[racine.length - 1]
        for (let k = g.succStart[pivot]; k < g.succStart[pivot + 1]; k++) {
          const nx = g.movementTo[g.succList[k]]
          if (nx < 0 || g.closed[nx] || interdits.has(nx)) continue
          const nd = g.edgeToNode[nx]
          if (nd >= 0 && bannis[nd]) continue
          departs.push({ edge: nx, dist: coutRacine + couts.retard[pivot] + couts.libre[nx] })
        }
      }
      if (!departs.length) continue

      recherches++
      const suite = plusCourt(g, couts, departs, cible, bannis)
      if (!suite) continue
      const edges = [...racine, ...suite.edges]
      const k = cle(edges)
      if (connus.has(k)) continue
      connus.add(k)
      candidats.push({ edges, cost: suite.cost })
    }

    if (!candidats.length) break
    let meilleur = 0
    for (let j = 1; j < candidats.length; j++) if (candidats[j].cost < candidats[meilleur].cost) meilleur = j
    trouves.push(candidats.splice(meilleur, 1)[0])
  }

  // Budget de recherche épuisé avant d'avoir le compte : on complète avec les meilleurs candidats déjà
  // rencontrés. Ce sont de vrais itinéraires, sans boucle et distincts ; seul leur rang exact n'est plus
  // garanti, faute d'avoir exploré toutes les déviations possibles.
  if (trouves.length < count && candidats.length) {
    candidats.sort((a, b) => a.cost - b.cost)
    for (const c of candidats) {
      if (trouves.length >= count) break
      trouves.push(c)
    }
  }

  return trouves.map((chemin) => {
    let longueur = 0
    const nodes: NodeId[] = [from]
    for (const e of chemin.edges) {
      longueur += g.length[e]
      nodes.push(g.nodeIds[g.edgeToNode[e]])
    }
    return {
      edges: chemin.edges.map((e) => g.edgeIds[e]),
      nodes,
      time: chemin.cost,
      length: longueur,
    }
  })
}
