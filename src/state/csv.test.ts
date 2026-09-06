import { describe, expect, it } from 'vitest'
import { defaultDemand } from '@/model/defaults'
import type { Demand, NetEdge, NetNode, Network } from '@/model/types'
import { parseDemandCsv, serializeDemandCsv } from './csv'

function node(id: string, x: number, y: number, boundary = false, label?: string): NetNode {
  return label ? { id, x, y, boundary, label } : { id, x, y, boundary }
}

function edge(id: string, from: NetNode, to: NetNode): NetEdge {
  const geometry: [number, number][] = [[from.x, from.y], [to.x, to.y]]
  return {
    id,
    from: from.id,
    to: to.id,
    highway: 'residential',
    lanes: 1,
    maxspeed: 50,
    length: Math.hypot(to.x - from.x, to.y - from.y),
    geometry,
    roundabout: false,
    closed: false,
    bannedTo: [],
    estimated: { lanes: false, maxspeed: false },
  }
}

/** Croisement en croix, chaque branche frontière étant à la fois entrée et sortie. */
function crossNetwork(): Network {
  const centre = node('n0', 0, 0)
  const branches = [
    node('nN', 0, 100, true, 'Route de Lyon'),
    node('nS', 0, -100, true, 'Avenue de la Gare'),
    node('nE', 100, 0, true),
    node('nW', -100, 0, true),
  ]
  const nodes: Record<string, NetNode> = { n0: centre }
  const edges: Record<string, NetEdge> = {}
  for (const branch of branches) {
    nodes[branch.id] = branch
    edges[`${branch.id}in`] = edge(`${branch.id}in`, branch, centre)
    edges[`${branch.id}out`] = edge(`${branch.id}out`, centre, branch)
  }
  return { nodes, edges, controls: {}, controllers: {} }
}

function fixture(): { network: Network; demand: Demand } {
  const network = crossNetwork()
  return { network, demand: defaultDemand(network) }
}

describe('parseDemandCsv — format A (entree;debit)', () => {
  it('lit un fichier point-virgule avec en-tête et décimales à la virgule', () => {
    const { network, demand } = fixture()
    const csv = 'entree;debit\nnN;800\nnS;1 250,5\n'
    const { demand: next, report } = parseDemandCsv(csv, demand, network)
    expect(report).toEqual({ entries: 2, exits: 0, odCells: 0, unknown: [] })
    expect(next.entries.nN.flow).toBe(800)
    expect(next.entries.nS.flow).toBe(1250.5)
    // Une valeur importée n'est plus une estimation.
    expect(next.entries.nN.estimated).toBe(false)
    expect(demand.entries.nN.estimated).toBe(true) // la demande d'origine n'est pas modifiée
    // Les entrées absentes du fichier gardent leur valeur.
    expect(next.entries.nE.flow).toBe(demand.entries.nE.flow)
  })

  it('accepte la virgule comme séparateur', () => {
    const { network, demand } = fixture()
    const { demand: next, report } = parseDemandCsv('nN,600\nnE,120\n', demand, network)
    expect(report.entries).toBe(2)
    expect(next.entries.nN.flow).toBe(600)
    expect(next.entries.nE.flow).toBe(120)
  })

  it('accepte un libellé exact à la place de l’identifiant', () => {
    const { network, demand } = fixture()
    const { demand: next, report } = parseDemandCsv('Route de Lyon;450\nAVENUE DE LA GARE;90\n', demand, network)
    expect(report.entries).toBe(2)
    expect(next.entries.nN.flow).toBe(450)
    expect(next.entries.nS.flow).toBe(90)
  })

  it('signale les entrées inconnues sans rien casser', () => {
    const { network, demand } = fixture()
    const { demand: next, report } = parseDemandCsv('nN;300\nRue Inexistante;700\n', demand, network)
    expect(report.entries).toBe(1)
    expect(report.unknown).toEqual(['Rue Inexistante'])
    expect(next.entries.nN.flow).toBe(300)
  })
})

describe('parseDemandCsv — format B (entree;sortie;part)', () => {
  it('alimente la matrice OD et bascule le mode de destination', () => {
    const { network, demand } = fixture()
    const csv = 'entree;sortie;part\nnN;nS;0,7\nnN;nE;0,3\nnS;nN;1\n'
    const { demand: next, report } = parseDemandCsv(csv, demand, network)
    expect(report.odCells).toBe(3)
    expect(next.destinationMode).toBe('od')
    expect(next.od).toEqual({ nN: { nS: 0.7, nE: 0.3 }, nS: { nN: 1 } })
    expect(demand.destinationMode).toBe('weights')
  })

  it('remplace la ligne existante d’une entrée présente dans le fichier', () => {
    const { network, demand } = fixture()
    const withOd: Demand = { ...demand, od: { nN: { nW: 1 }, nE: { nW: 1 } } }
    const { demand: next } = parseDemandCsv('nN;nS;1\n', withOd, network)
    expect(next.od.nN).toEqual({ nS: 1 })
    expect(next.od.nE).toEqual({ nW: 1 }) // ligne absente du fichier : conservée
  })

  it('signale une sortie inconnue', () => {
    const { network, demand } = fixture()
    const { report } = parseDemandCsv('nN;nZ;1\n', demand, network)
    expect(report.odCells).toBe(0)
    expect(report.unknown).toEqual(['nZ'])
  })
})

describe('serializeDemandCsv', () => {
  it('exporte les entrées puis les sorties après « # sorties »', () => {
    const { network, demand } = fixture()
    const text = serializeDemandCsv(demand, network)
    const lines = text.trim().split('\n')
    expect(lines[1]).toBe('entree;debit')
    expect(lines).toContain('# sorties')
    expect(lines).toContain('sortie;poids')
    expect(lines).toContain(`nN;${demand.entries.nN.flow}`)
  })

  it('fait un aller-retour complet', () => {
    const { network, demand } = fixture()
    const modified: Demand = {
      ...demand,
      entries: { ...demand.entries, nN: { ...demand.entries.nN, flow: 812.5 } },
      exits: { ...demand.exits, nS: { ...demand.exits.nS, weight: 37.25 } },
    }
    const { demand: back, report } = parseDemandCsv(serializeDemandCsv(modified, network), demand, network)
    expect(report.unknown).toEqual([])
    expect(report.entries).toBe(4)
    expect(report.exits).toBe(4)
    for (const id of Object.keys(modified.entries)) {
      expect(back.entries[id].flow).toBe(modified.entries[id].flow)
    }
    for (const id of Object.keys(modified.exits)) {
      expect(back.exits[id].weight).toBe(modified.exits[id].weight)
    }
    expect(back.destinationMode).toBe('weights')
  })
})
