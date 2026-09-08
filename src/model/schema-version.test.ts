/**
 * Version du format de projet : un fichier version 1 doit rester lisible, et une version future doit être
 * refusée explicitement plutôt que dépouillée en silence.
 */
import { describe, expect, it } from 'vitest'
import { PROJECT_FORMAT, PROJECT_VERSION } from './types'
import { validateProject } from './schema'
import { crossNetwork, withSignals } from './testNetworks'
import { ATTRIBUTION, DEFAULT_SETTINGS, defaultDemand } from './defaults'

function projetBrut(version: number): Record<string, unknown> {
  const network = withSignals(crossNetwork())
  return {
    format: PROJECT_FORMAT,
    version,
    meta: {
      id: 'p', name: 'Test', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      center: { lon: 4, lat: 45 }, attribution: ATTRIBUTION,
    },
    network,
    demand: defaultDemand(network),
    settings: DEFAULT_SETTINGS,
    changes: [],
  }
}

describe('version du format de projet', () => {
  it('est passée à 2 avec l’arrivée des dossiers de carrefour', () => {
    expect(PROJECT_VERSION).toBe(2)
  })

  it('relit un fichier de version 1 sans perte', () => {
    const brut = projetBrut(1)
    const r = validateProject(JSON.parse(JSON.stringify(brut)))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.project.version).toBe(2)
    expect(Object.keys(r.project.network.controllers)).toEqual(Object.keys(brut.network as object ? (brut.network as { controllers: object }).controllers : {}))
    // Les réglages d'heure simulée sont complétés par leurs valeurs par défaut.
    expect(r.project.settings.startTimeOfDayMin).toBe(DEFAULT_SETTINGS.startTimeOfDayMin)
    expect(r.project.settings.dayOfWeek).toBe(DEFAULT_SETTINGS.dayOfWeek)
  })

  it('refuse explicitement un fichier plus récent au lieu de l’amputer', () => {
    const r = validateProject(projetBrut(PROJECT_VERSION + 1))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.join(' ')).toMatch(/version/i)
  })

  it('refuse une version inconnue sans migration', () => {
    const r = validateProject(projetBrut(0))
    expect(r.ok).toBe(false)
  })
})
