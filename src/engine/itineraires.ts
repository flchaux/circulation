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
  /**
   * Nœud de passage imposé, si l'itinéraire vient de `itineraireParPassage`. Absent pour les itinéraires
   * les plus courts, qui ne passent que par où ils veulent.
   */
  passage?: NodeId
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
 * Dijkstra sur le graphe des tronçons, depuis un ensemble d'états initiaux.
 *
 * `dist[e]` est le coût d'être arrivé au bout de `e` (traversée de `e` comprise), `parent[e]` le tronçon
 * précédent. Les nœuds marqués dans `bannis` ne peuvent pas être atteints : c'est ainsi que Yen interdit à
 * une déviation de repasser par le début du chemin qu'elle prolonge. La recherche s'arrête au premier
 * tronçon qui aboutit à `cible`, ou explore tout le graphe si `cible` vaut −1.
 */
function explorerDepuis(
  g: EngineGraph,
  couts: Couts,
  departs: Depart[],
  cible: number,
  bannis: Uint8Array,
): { dist: Float64Array; parent: Int32Array; arrivee: number } {
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
  return { dist, parent, arrivee }
}

/** Remonte la chaîne des parents jusqu'à un état initial. */
function cheminVers(parent: Int32Array, arrivee: number): number[] {
  const edges: number[] = []
  for (let cur = arrivee; cur >= 0; cur = parent[cur]) edges.push(cur)
  edges.reverse()
  return edges
}

function plusCourt(
  g: EngineGraph,
  couts: Couts,
  departs: Depart[],
  cible: number,
  bannis: Uint8Array,
): { edges: number[]; cost: number } | null {
  const { dist, parent, arrivee } = explorerDepuis(g, couts, departs, cible, bannis)
  if (arrivee < 0) return null
  return { edges: cheminVers(parent, arrivee), cost: dist[arrivee] }
}

/**
 * Dijkstra **inverse** : `cout[f]` est le coût pour aller de l'engagement sur le tronçon `f` jusqu'à
 * l'arrivée au nœud `cible`, traversée de `f` comprise et retards des carrefours traversés compris ;
 * `suivant[f]` est le tronçon d'après sur ce meilleur trajet (−1 si `f` aboutit à la cible).
 *
 * C'est la moitié aval d'un itinéraire par point de passage : combinée à la moitié amont, elle donne le
 * meilleur trajet **pour chaque façon de traverser le carrefour de passage**, ce que deux plus courts
 * chemins calculés séparément ne sauraient pas faire — leur jonction pourrait être un mouvement interdit.
 */
function explorerVers(g: EngineGraph, couts: Couts, cible: number): { cout: Float64Array; suivant: Int32Array } {
  const n = g.edgeIds.length
  const cout = new Float64Array(n).fill(Infinity)
  const suivant = new Int32Array(n).fill(-1)
  const heap = new MinHeap(64)
  for (let k = g.inStart[cible]; k < g.inStart[cible + 1]; k++) {
    const f = g.inList[k]
    if (g.closed[f]) continue
    cout[f] = couts.libre[f]
    heap.push(cout[f], f)
  }
  while (heap.size > 0) {
    const f = heap.pop()
    const d = heap.lastKey
    if (d > cout[f]) continue
    for (let k = g.predStart[f]; k < g.predStart[f + 1]; k++) {
      const p = g.movementFrom[g.predList[k]]
      if (p < 0 || g.closed[p]) continue
      const nd = couts.libre[p] + couts.retard[p] + d
      if (nd < cout[p]) {
        cout[p] = nd
        suivant[p] = f
        heap.push(nd, p)
      }
    }
  }
  return { cout, suivant }
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

  return trouves.map((chemin) => construire(g, from, chemin.edges, chemin.cost))
}

/** Traduit une suite d'indices de tronçons en itinéraire lisible (identifiants, nœuds, longueur). */
function construire(g: EngineGraph, from: NodeId, edges: number[], cost: number): Itineraire {
  let longueur = 0
  const nodes: NodeId[] = [from]
  for (const e of edges) {
    longueur += g.length[e]
    nodes.push(g.nodeIds[g.edgeToNode[e]])
  }
  return { edges: edges.map((e) => g.edgeIds[e]), nodes, time: cost, length: longueur }
}

/**
 * Le plus court itinéraire de `from` à `to` **contraint à traverser** le nœud `passage`.
 *
 * Ce n'est pas la concaténation du plus court chemin `from → passage` et du plus court chemin
 * `passage → to` : leur jonction serait un mouvement quelconque au carrefour de passage, y compris un
 * demi-tour ou un tourne-à-gauche interdit. La contrainte est donc portée par le **mouvement** : deux
 * explorations, l'une depuis l'origine, l'autre vers la destination, puis le minimum sur les mouvements
 * autorisés du carrefour de passage (`nodeMovements`, donc sans demi-tour hors impasse, sans mouvement
 * interdit et vide si le nœud est frontière — on ne traverse pas une frontière, on ne peut donc pas
 * l'imposer comme point de passage).
 *
 * L'itinéraire obtenu peut repasser par un tronçon déjà emprunté : c'est le propre d'un détour imposé
 * vers un point de passage puis d'un retour, et le réseau interdisant le demi-tour, ce retour se fait par
 * le tour du pâté de maisons. Renvoie `null` si le passage est confondu avec une extrémité, si l'un des
 * trois nœuds est inconnu, ou si aucun itinéraire ne les enchaîne.
 */
export function itineraireParPassage(
  network: Network,
  from: NodeId,
  passage: NodeId,
  to: NodeId,
  opts: OptionsItineraires = {},
): Itineraire | null {
  if (passage === from || passage === to || from === to) return null
  const g = buildGraph(network)
  const source = g.nodeOf.get(from)
  const pivot = g.nodeOf.get(passage)
  const cible = g.nodeOf.get(to)
  if (source === undefined || pivot === undefined || cible === undefined) return null
  const couts = coutsDeReference(g, network, opts.settings)

  const departs: Depart[] = []
  for (let k = g.outStart[source]; k < g.outStart[source + 1]; k++) {
    const e = g.outList[k]
    if (!g.closed[e]) departs.push({ edge: e, dist: couts.libre[e] })
  }
  if (!departs.length) return null

  // Moitié amont : on interdit de revenir à l'origine, comme pour les itinéraires les plus courts.
  const bannis = new Uint8Array(g.nodeIds.length)
  bannis[source] = 1
  const amont = explorerDepuis(g, couts, departs, -1, bannis)
  const aval = explorerVers(g, couts, cible)

  let meilleur = Infinity
  let approche = -1
  let sortie = -1
  for (let m = g.nodeMovStart[pivot]; m < g.nodeMovStart[pivot + 1]; m++) {
    const e = g.movementFrom[m]
    const f = g.movementTo[m]
    if (e < 0 || f < 0) continue
    const total = amont.dist[e] + couts.retard[e] + aval.cout[f]
    if (total < meilleur) { meilleur = total; approche = e; sortie = f }
  }
  if (approche < 0 || !Number.isFinite(meilleur)) return null

  const edges = cheminVers(amont.parent, approche)
  let garde = g.edgeIds.length + 2
  for (let cur = sortie; cur >= 0; cur = aval.suivant[cur]) {
    if (garde-- <= 0) return null
    edges.push(cur)
  }
  return { ...construire(g, from, edges, meilleur), passage }
}
