/**
 * Client Overpass : bascule entre miroirs, chien de garde du premier octet, annulation.
 * Aucun appel réseau réel : `fetch` est remplacé par un double.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OVERPASS_FIRST_BYTE_MS, OVERPASS_MIRRORS, fetchOsmExtract } from './overpass'
import type { CommuneDetail } from './types'

const commune: CommuneDetail = {
  nom: 'Testville',
  code: '00000',
  codesPostaux: ['00000'],
  centre: { type: 'Point', coordinates: [4, 45] },
  contour: { type: 'Polygon', coordinates: [[[4, 45], [4.01, 45], [4.01, 45.01], [4, 45.01], [4, 45]]] },
}

const reponseOk = () =>
  new Response(JSON.stringify({ elements: [{ type: 'node', id: 1, lat: 45, lon: 4 }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('fetchOsmExtract', () => {
  it('bascule sur le miroir suivant quand le premier est saturé', async () => {
    const appels: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      appels.push(url)
      if (appels.length === 1) return new Response('', { status: 429 })
      return reponseOk()
    }))
    const extrait = await fetchOsmExtract(commune)
    expect(appels).toEqual([OVERPASS_MIRRORS[0], OVERPASS_MIRRORS[1]])
    expect(extrait.osm.elements).toHaveLength(1)
  })

  it('abandonne un miroir muet au bout du délai de premier octet, sans attendre le budget complet', async () => {
    vi.useFakeTimers()
    const appels: string[] = []
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      appels.push(url)
      if (appels.length === 1) {
        // Miroir muet : ne se résout jamais de lui-même, seul l'abandon met fin à l'attente.
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
      }
      return Promise.resolve(reponseOk())
    }))

    const promesse = fetchOsmExtract(commune)
    await vi.advanceTimersByTimeAsync(OVERPASS_FIRST_BYTE_MS + 100)
    const extrait = await promesse
    expect(appels).toEqual([OVERPASS_MIRRORS[0], OVERPASS_MIRRORS[1]])
    expect(extrait.commune.nom).toBe('Testville')
  })

  it('énumère la cause de chaque miroir quand tous échouent', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === OVERPASS_MIRRORS[0]) return new Response('', { status: 429 })
      if (url === OVERPASS_MIRRORS[1]) return new Response('', { status: 504 })
      return new Response('', { status: 500 })
    }))
    await expect(fetchOsmExtract(commune)).rejects.toThrow(/saturé[\s\S]*504[\s\S]*500/)
  })

  it('interrompt le téléchargement quand le signal est annulé', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })))
    const promesse = fetchOsmExtract(commune, { signal: controller.signal })
    controller.abort()
    await expect(promesse).rejects.toThrow()
  })

  it('signale la progression miroir par miroir', async () => {
    const messages: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      (url === OVERPASS_MIRRORS[0] ? new Response('', { status: 429 }) : reponseOk())))
    await fetchOsmExtract(commune, { onProgress: (m) => messages.push(m) })
    expect(messages.some((m) => /overpass-api\.de/.test(m) && /saturé/.test(m))).toBe(true)
    expect(messages.some((m) => /Réseau reçu/.test(m))).toBe(true)
  })
})
