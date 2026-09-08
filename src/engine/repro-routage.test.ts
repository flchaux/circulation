/**
 * Reproduction : le routage dynamique délaisse définitivement un itinéraire une fois congestionné,
 * même lorsqu'il redevient totalement libre.
 *
 * Cause : `updateTravelEma` n'était appelée qu'à la sortie d'un véhicule. Un tronçon que le routage
 * cesse d'alimenter n'est plus mesuré, sa moyenne glissante reste figée sur la congestion passée, le
 * routage continue de l'éviter — et rien ne le réhabilite. Le coût est désormais recalculé à partir de
 * l'état courant du tronçon (§5.5) : décroissance vers le temps à vide faute de mesure, et majoration
 * par la file présente pour que le tronçon bouché, lui, ne redevienne pas « libre » par absence de mesure.
 */
import { describe, expect, it } from 'vitest'
import type { NetEdge, Network, SignalController, SimSettings } from '@/model/types'
import { Simulation } from '@/engine/simulation'
import { DEFAULT_SETTINGS } from '@/model/defaults'

/**
 * Deux itinéraires parallèles entre l'entrée O et la sortie D :
 *  - court : O → A → D, 400 m au total ;
 *  - long  : O → B → D, 1000 m au total.
 * Le court est le plus rapide à vide. On sature d'abord le réseau pour le congestionner,
 * puis on regarde si les véhicules y reviennent une fois la pointe passée.
 */
function deuxItineraires(): Network {
  const nodes: Network['nodes'] = {
    O: { id: 'O', x: -100, y: 0, boundary: true },
    S: { id: 'S', x: 0, y: 0, boundary: false },
    A: { id: 'A', x: 200, y: 60, boundary: false },
    B: { id: 'B', x: 200, y: -400, boundary: false },
    J: { id: 'J', x: 400, y: 0, boundary: false },
    D: { id: 'D', x: 500, y: 0, boundary: true },
  }
  const edges: Record<string, NetEdge> = {}
  const arc = (id: string, from: string, to: string, lanes = 1) => {
    const a = nodes[from]
    const b = nodes[to]
    edges[id] = {
      id, from, to, name: id, highway: 'residential', lanes, maxspeed: 50,
      length: Math.hypot(b.x - a.x, b.y - a.y),
      geometry: [[a.x, a.y], [b.x, b.y]],
      roundabout: false, closed: false, bannedTo: [], estimated: { lanes: false, maxspeed: false },
    }
  }
  arc('oS', 'O', 'S')
  arc('sA', 'S', 'A')
  arc('aJ', 'A', 'J')
  arc('sB', 'S', 'B')
  arc('bJ', 'B', 'J')
  arc('jD', 'J', 'D')
  return { nodes, edges, controls: {}, controllers: {} }
}

/** Demande d'entrée constante sur le nœud d'entrée, toutes les destinations vers D. */
function demande(flow: number, entree = 'O') {
  return {
    seed: 5,
    globalFactor: 1,
    entries: { [entree]: { flow, enabled: true, estimated: false } },
    exits: { D: { weight: 1, enabled: true } },
    destinationMode: 'weights' as const,
    od: {},
    internal: { enabled: false, generationRate: 0, internalDestinationShare: 0, entryInternalShare: 0 },
  }
}

function reglages(o: Partial<SimSettings> = {}): SimSettings {
  return {
    ...DEFAULT_SETTINGS,
    durationMin: 60,
    warmupMin: 0,
    dynamicRouting: true,
    routingIntervalMin: 5,
    statsIntervalMin: 5,
    ...o,
  }
}

/** Trafic entré sur chaque itinéraire, minute par minute. */
function parMinute(sim: Simulation, minutes: number, aLaMinute?: (min: number) => void): { court: number; long: number }[] {
  const out: { court: number; long: number }[] = []
  let precedentCourt = 0
  let precedentLong = 0
  for (let min = 1; min <= minutes; min++) {
    sim.step(60)
    aLaMinute?.(min)
    const r = sim.results()
    const court = r.edges.sA?.entered ?? 0
    const long = r.edges.sB?.entered ?? 0
    out.push({ court: court - precedentCourt, long: long - precedentLong })
    precedentCourt = court
    precedentLong = long
  }
  return out
}

function cumul(tranche: { court: number; long: number }[]): { court: number; long: number } {
  return {
    court: tranche.reduce((s, t) => s + t.court, 0),
    long: tranche.reduce((s, t) => s + t.long, 0),
  }
}

describe('routage dynamique : retour sur un itinéraire redevenu libre', () => {
  it('le chemin court est de nouveau emprunté quand il se vide', () => {
    const sim = new Simulation({ network: deuxItineraires(), demand: demande(1500), settings: reglages() })
    const parTranche = parMinute(sim, 60).map((t, i) => ({ min: i + 1, ...t }))

    const lignes = parTranche.filter((t) => t.min % 5 === 0)
    console.log('minute   chemin court   chemin long')
    for (const t of lignes) console.log(`  ${String(t.min).padStart(2)}         ${String(t.court).padStart(4)}          ${String(t.long).padStart(4)}`)

    // Les vingt dernières minutes : le réseau est vidé de la pointe, le chemin court est libre.
    const fin = cumul(parTranche.slice(-20))
    console.log(`\n20 dernières minutes : court ${fin.court}, long ${fin.long}`)

    // Avant correctif ce chiffre était exactement 0 : une fois congestionné, l'itinéraire n'était plus
    // jamais réessayé, quoi qu'il advienne de son état réel. Il reprend maintenant une part
    // substantielle du trafic, à chaque fois qu'il se vide.
    expect(fin.court).toBeGreaterThan(50)
    expect(fin.court / (fin.court + fin.long)).toBeGreaterThan(0.15)

    // Pourquoi le chemin court ne reprend-il pas ici la majorité, alors qu'il est deux fois plus rapide
    // à vide ? Parce qu'à ce débit il ne peut pas l'absorber : au carrefour J, `aJ` cède le passage à
    // `bJ` (priorité à droite). Sa capacité mesurée est de 1 182 véh/h quand le chemin long est vide
    // (test suivant), et elle s'effondre dès que le chemin long écoule la demande — le mouvement doit
    // alors s'insérer dans un flux prioritaire saturé. L'équilibre de ce réseau à 1 500 véh/h laisse
    // donc la majorité du trafic sur le chemin long, et c'est le bon choix. Le scénario suivant place
    // le réseau dans la situation que ce test visait : une pointe qui passe, puis un chemin court
    // réellement disponible — et le chemin court y reprend alors 100 % du trafic.
  })

  it('capacité de chaque itinéraire, mesurée en routage statique', () => {
    const court = new Simulation({
      network: deuxItineraires(), demand: demande(1500), settings: reglages({ dynamicRouting: false }),
    })
    while (!court.done) court.step(600)

    const reseauSansCourt = deuxItineraires()
    reseauSansCourt.edges.sA = { ...reseauSansCourt.edges.sA, closed: true }
    const long = new Simulation({
      network: reseauSansCourt, demand: demande(1500), settings: reglages({ dynamicRouting: false }),
    })
    while (!long.done) long.step(600)

    console.log(`capacité du chemin court seul : ${court.results().edges.jD.flowVehH.toFixed(0)} véh/h`)
    console.log(`capacité du chemin long seul  : ${long.results().edges.jD.flowVehH.toFixed(0)} véh/h`)
    // Le chemin court, qui cède le passage au carrefour de raccordement, plafonne sous la demande.
    expect(court.results().edges.jD.flowVehH).toBeLessThan(1500)
    expect(long.results().edges.jD.flowVehH).toBeGreaterThan(1400)
  })
})

/**
 * Feu de chantier provisoire sur la rue courte : quatre secondes de vert par cycle de vingt,
 * soit environ 360 véh/h. Il bride le chemin court pendant la pointe, puis il est retiré.
 */
function feuDeChantier(): SignalController {
  return {
    id: 'chantier',
    name: 'Chantier rue courte',
    nodeIds: ['A'],
    mode: 'fixed',
    offset: 0,
    amber: 3,
    allRed: 13,
    phases: [{
      id: 'p1', name: 'Passage alterné', green: 4,
      movements: { 'sA>aJ': 'protected' },
      minGreen: 4, maxGreen: 20, gap: 3,
    }],
    actuated: { skipEmpty: false },
  }
}

describe('routage dynamique : une pointe qui passe', () => {
  it('le chemin court reprend tout le trafic une fois le bouchon résorbé', () => {
    const network = deuxItineraires()
    network.controllers.chantier = feuDeChantier()
    network.controls.A = { nodeId: 'A', type: 'signals', controllerId: 'chantier' }
    // 800 véh/h : les deux itinéraires savent l'absorber, seul le chantier crée la congestion.
    const sim = new Simulation({ network, demand: demande(800), settings: reglages() })

    // Le chantier est levé au bout de dix minutes : le chemin court redevient totalement libre.
    const parTranche = parMinute(sim, 60, (min) => { if (min === 10) sim.updateSignals({}, {}) })

    const pointe = cumul(parTranche.slice(0, 10))
    const fin = cumul(parTranche.slice(-20))
    console.log(`pointe (chantier) : court ${pointe.court}, long ${pointe.long}`)
    console.log(`20 dernières minutes : court ${fin.court}, long ${fin.long}`)

    // Le chantier a bien détourné le trafic pendant la pointe…
    const pendantPointe = cumul(parTranche.slice(10, 20))
    expect(pendantPointe.long).toBeGreaterThan(pendantPointe.court)
    // … et le chemin court, redevenu libre et plus rapide, reprend l'essentiel du trafic.
    expect(fin.court).toBeGreaterThan(fin.long)
    expect(fin.court / (fin.court + fin.long)).toBeGreaterThan(0.9)

    // Pas d'oscillation : le partage ne bascule pas d'une tranche de 5 min à l'autre.
    const tranches = [0, 1, 2, 3].map((k) => cumul(parTranche.slice(40 + k * 5, 45 + k * 5)))
    console.log('tranches de 5 min : ' + tranches.map((t) => `${t.court}/${t.long}`).join('  '))
    for (const t of tranches) expect(t.court).toBeGreaterThan(t.long)
  })

  it('deux exécutions identiques donnent exactement le même résultat', () => {
    const executer = () => {
      const network = deuxItineraires()
      network.controllers.chantier = feuDeChantier()
      network.controls.A = { nodeId: 'A', type: 'signals', controllerId: 'chantier' }
      const sim = new Simulation({ network, demand: demande(800), settings: reglages() })
      parMinute(sim, 60, (min) => { if (min === 10) sim.updateSignals({}, {}) })
      return JSON.stringify(sim.results())
    }
    expect(executer()).toBe(executer())
  })
})

/** Feu au carrefour J dont la phase unique ne fait jamais passer la branche courte. */
function feuBloquantLaBrancheCourte(): SignalController {
  return {
    id: 'j',
    name: 'Carrefour J',
    nodeIds: ['J'],
    mode: 'fixed',
    offset: 0,
    amber: 3,
    allRed: 2,
    // `aJ>jD` n'apparaît dans aucune phase : le mouvement reste rouge en permanence.
    phases: [{
      id: 'p1', name: 'Branche longue', green: 55,
      movements: { 'bJ>jD': 'protected' },
      minGreen: 7, maxGreen: 60, gap: 3,
    }],
    actuated: { skipEmpty: false },
  }
}

describe('routage dynamique : un tronçon bouché reste évité', () => {
  it('ne redevient pas attractif du seul fait qu’on n’en mesure plus rien', () => {
    // L'entrée est portée par le nœud de divergence S : les véhicules engagés vers la branche bouchée
    // attendent dans la file virtuelle de l'entrée, sans plomber ceux qui visent l'autre branche.
    const network = deuxItineraires()
    delete network.edges.oS
    delete network.nodes.O
    network.nodes.S = { ...network.nodes.S, boundary: true }
    network.controllers.j = feuBloquantLaBrancheCourte()
    network.controls.J = { nodeId: 'J', type: 'signals', controllerId: 'j' }
    const sim = new Simulation({ network, demand: demande(800, 'S'), settings: reglages() })

    const parTranche = parMinute(sim, 60)
    const apresPointe = cumul(parTranche.slice(10))
    const r = sim.results()
    console.log(`bouché : entrés sur le chemin court ${r.edges.sA.entered} (dont ${apresPointe.court} après la 10ᵉ minute),`
      + ` sortis du réseau ${r.network.exited}`)

    // Aucun véhicule ne sort de `aJ` : le tronçon n'est jamais mesuré, sa moyenne glissante reste au
    // temps à vide. Seule la file présente peut le signaler comme bouché.
    expect(r.edges.aJ.exited).toBe(0)
    // Le routage l'abandonne dès le premier recalcul et ne le réessaie plus.
    expect(apresPointe.court).toBe(0)
    // …et le trafic passe par le chemin long au lieu de s'agglutiner derrière le bouchon.
    expect(apresPointe.long).toBeGreaterThan(600)
    expect(r.network.exited).toBeGreaterThan(600)
  })
})

describe('routage statique : comportement strictement inchangé', () => {
  it('donne exactement les résultats d’avant correctif', () => {
    const sim = new Simulation({
      network: deuxItineraires(),
      demand: demande(1500),
      settings: reglages({ dynamicRouting: false }),
    })
    while (!sim.done) sim.step(600)
    const r = sim.results()

    // Valeurs relevées sur le moteur d'avant correctif (git stash des deux fichiers du lot) :
    // sans routage dynamique, les coûts ne sont jamais recalculés et rien ne doit bouger.
    expect(r.network).toEqual({
      entered: 1251,
      exited: 1182,
      inCirculation: 69,
      notInjected: 263,
      totalDelayS: 172931,
      meanDelayS: 146.3037225042301,
      meanTravelTimeS: 189.75888324873097,
      vehKm: 742.6082940371386,
    })
    expect(r.edges.sA.entered).toBe(1239)
    expect(r.edges.sA.exited).toBe(1212)
    expect(r.edges.sA.maxQueue).toBe(22)
    expect(r.edges.sB.entered).toBe(0)
    expect(r.edges.jD.exited).toBe(1182)
    expect(r.exits.D.count).toBe(1182)
    expect(r.exits.D.meanDelayS).toBe(145.29080050306627)
  })
})
