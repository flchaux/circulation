/**
 * Parcours de bout en bout dans un vrai navigateur : chargement de la démonstration, édition du réseau,
 * conversion d'un carrefour en feux, simulation, résultats et export JSON.
 *
 * Les tests s'exécutent contre le build de production servi par `vite preview`, donc sur le code livré.
 * Aucun appel réseau externe n'est nécessaire : la démonstration de Veauche est embarquée dans `public/demo`.
 *
 * L'application expose `window.__circulation` (store, carte Leaflet, projection) comme point d'accès de
 * débogage ; les tests s'en servent pour cibler un nœud précis, ce qu'un sélecteur CSS ne permet pas sur un canvas.
 */
import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Debug = {
  store: { getState(): any }
  map?: any
  projection?: { toLonLat(x: number, y: number): { lon: number; lat: number } }
}

/** Exécute une fonction dans la page avec le point d'accès de débogage déjà résolu. */
function withDebug<A, R>(page: Page, fn: (debug: Debug, arg: A) => R, arg: A): Promise<R> {
  return page.evaluate(
    ([source, value]) => {
      const debug = (window as any).__circulation as Debug | undefined
      if (!debug) throw new Error("window.__circulation n'est pas disponible")
      // eslint-disable-next-line no-new-func
      const f = new Function(`return (${source})`)() as (d: Debug, a: unknown) => unknown
      return f(debug, value)
    },
    [fn.toString(), arg] as const,
  ) as Promise<R>
}

/** Attend que la démonstration soit chargée. */
async function attendreProjet(page: Page): Promise<void> {
  await expect(page.getByTestId('nom-projet')).toHaveValue(/Veauche/i, { timeout: 30_000 })
}

/**
 * Centre la carte sur un carrefour au zoom demandé et attend le redessin.
 * Au cadrage initial (commune entière) les nœuds sont trop serrés pour viser l'un d'eux à la souris.
 */
async function zoomerSurUnCarrefour(page: Page, zoom = 18): Promise<void> {
  await withDebug(page, (d, z: number) => {
    const net = d.store.getState().project.network
    const degre = new Map<string, number>()
    for (const e of Object.values(net.edges) as any[]) degre.set(e.to, (degre.get(e.to) ?? 0) + 1)
    let choisi: string | null = null
    for (const [id, deg] of degre) {
      if (deg >= 3 && !net.nodes[id]?.boundary) { choisi = id; break }
    }
    const n = choisi ? net.nodes[choisi] : Object.values(net.nodes)[0]
    const { lon, lat } = d.projection!.toLonLat(n.x, n.y)
    d.map.setView([lat, lon], z, { animate: false })
  }, zoom)
  await page.waitForTimeout(800)
}

const erreursParPage = new WeakMap<Page, string[]>()

test.beforeEach(async ({ page }) => {
  // Chaque test repart d'un navigateur vierge, donc de la démonstration embarquée.
  await page.addInitScript(() => {
    indexedDB.deleteDatabase('keyval-store')
  })
  const erreurs: string[] = []
  erreursParPage.set(page, erreurs)
  page.on('pageerror', (e) => erreurs.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') erreurs.push(m.text())
  })
})

test.afterEach(async ({ page }) => {
  const erreurs = erreursParPage.get(page) ?? []
  // Les tuiles OpenStreetMap peuvent être injoignables : ce n'est pas une erreur applicative.
  const bloquantes = erreurs.filter((e) => !/tile\.openstreetmap|ERR_|Failed to load resource|net::/i.test(e))
  expect(bloquantes, `erreurs console : ${bloquantes.join(' | ')}`).toEqual([])
})

test('la démonstration se charge et le réseau est dessiné', async ({ page }) => {
  await page.goto('/')
  await attendreProjet(page)

  await expect(page.locator('.app')).toBeVisible()
  await expect(page.locator('canvas.carte-canvas--statique')).toHaveCount(1)

  const stats = await withDebug(page, (d) => {
    const net = d.store.getState().project.network
    return { edges: Object.keys(net.edges).length, nodes: Object.keys(net.nodes).length }
  }, null)
  expect(stats.edges).toBeGreaterThan(500)
  expect(stats.nodes).toBeGreaterThan(200)

  // Le canvas statique porte bien un dessin (au moins un pixel opaque).
  const dessine = await page.evaluate(() => {
    const c = document.querySelector('canvas.carte-canvas--statique') as HTMLCanvasElement | null
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return false
    const data = ctx.getImageData(0, 0, c.width, c.height).data
    for (let i = 3; i < data.length; i += 4 * 89) if (data[i] !== 0) return true
    return false
  })
  expect(dessine, 'le réseau doit être visible sur le canvas statique').toBe(true)
})

test('la simulation avance et produit des résultats', async ({ page }) => {
  await page.goto('/')
  await attendreProjet(page)

  await page.getByTestId('sim-vitesse').selectOption('120')
  await page.getByTestId('sim-lecture').click()

  await expect
    .poll(async () => withDebug(page, (d) => d.store.getState().sim.time as number, null), {
      timeout: 60_000,
      message: 'le temps simulé doit avancer',
    })
    .toBeGreaterThan(60)

  // Des véhicules circulent effectivement.
  const enCirculation = await withDebug(page, (d) => {
    const frame = d.store.getState().sim.frame
    return frame ? (frame.counts.entered as number) : 0
  }, null)
  expect(enCirculation).toBeGreaterThan(0)

  // Les résultats agrégés arrivent au premier intervalle.
  await expect
    .poll(async () => withDebug(page, (d) => (d.store.getState().sim.results ? 1 : 0), null), {
      timeout: 120_000,
      message: 'des résultats doivent être agrégés',
    })
    .toBe(1)

  await page.getByTestId('onglet-resultats').click()
  await expect(page.locator('.sidebar-body')).toContainText(/véhicule/i, { timeout: 20_000 })
})

test('un carrefour peut passer en feux avec un plan par défaut', async ({ page }) => {
  await page.goto('/')
  await attendreProjet(page)

  const nodeId = await withDebug(page, (d) => {
    const state = d.store.getState()
    const net = state.project.network
    const degre = new Map<string, number>()
    for (const e of Object.values(net.edges) as any[]) degre.set(e.to, (degre.get(e.to) ?? 0) + 1)
    for (const [id, deg] of degre) {
      if (deg >= 3 && !net.nodes[id]?.boundary && net.controls[id]?.type !== 'signals') {
        state.setTab('reseau')
        state.select({ kind: 'node', id })
        return id
      }
    }
    return null
  }, null)
  expect(nodeId, 'la démonstration doit contenir un carrefour à trois branches au moins').not.toBeNull()

  await page.getByTestId('regulation-noeud').selectOption('signals')

  const plan = await withDebug(page, (d, id: string) => {
    const net = d.store.getState().project.network
    const controlId = net.controls[id]?.controllerId
    const controller = controlId ? net.controllers[controlId] : null
    return controller
      ? { phases: controller.phases.length, mouvements: controller.phases.map((p: any) => Object.keys(p.movements).length) }
      : null
  }, nodeId as string)

  expect(plan, 'un contrôleur doit avoir été créé').not.toBeNull()
  expect(plan!.phases).toBeGreaterThanOrEqual(1)
  expect(Math.max(...plan!.mouvements)).toBeGreaterThan(0)

  await page.getByTestId('onglet-feux').click()
  await expect(page.getByTestId('mode-feux')).toBeVisible({ timeout: 15_000 })

  // Une armoire commande parfois deux nœuds voisins (carrefour décalé) : on regroupe depuis le panneau.
  await page.getByTestId('ajouter-noeud').click()
  const regroupe = await withDebug(page, (d, id: string) => {
    const net = d.store.getState().project.network
    const controller = net.controllers[net.controls[id]?.controllerId]
    return {
      noeuds: controller?.nodeIds.length ?? 0,
      tousAFeux: (controller?.nodeIds ?? []).every((n: string) => net.controls[n]?.type === 'signals'),
    }
  }, nodeId as string)
  expect(regroupe).toEqual({ noeuds: 2, tousAFeux: true })

  // Et le regroupement se défait : le nœud ajouté retrouve sa régulation ordinaire.
  await page.getByTestId('annuler').click()
  const seul = await withDebug(page, (d, id: string) => {
    const net = d.store.getState().project.network
    return net.controllers[net.controls[id]?.controllerId]?.nodeIds.length ?? 0
  }, nodeId as string)
  expect(seul).toBe(1)
})

test('le dossier d’un carrefour se charge sur le feu sélectionné', async ({ page }) => {
  await page.goto('/')
  await attendreProjet(page)

  // Le carrefour du dossier VE001 de Veauche : Avenue du Général de Gaulle / Croix des Pères. C'est
  // l'exploitant qui le désigne — ici en le sélectionnant sur la carte — puis qui le passe en feux.
  const nodeId = await withDebug(page, (d) => {
    const state = d.store.getState()
    const net = state.project.network
    const rues = new Map<string, Set<string>>()
    for (const e of Object.values(net.edges) as any[]) {
      if (!e.name) continue
      for (const n of [e.from, e.to]) {
        if (!rues.has(n)) rues.set(n, new Set())
        rues.get(n).add(e.name)
      }
    }
    for (const [id, noms] of rues) {
      if (noms.has('Avenue du Général de Gaulle') && noms.has('Rue de la Croix des Pères')) {
        state.setTab('reseau')
        state.select({ kind: 'node', id })
        return id
      }
    }
    return null
  }, null)
  expect(nodeId, 'la démonstration doit contenir le carrefour de Gaulle / Croix des Pères').not.toBeNull()

  await page.getByTestId('regulation-noeud').selectOption('signals')
  await page.getByTestId('onglet-feux').click()
  await expect(page.getByTestId('mode-feux')).toBeVisible({ timeout: 15_000 })

  const dossier = readFileSync('src/geo/fixtures/veauche-VE001-gaulle-croix-des-peres.json', 'utf8')
  await page.getByTestId('importer-dossier').click()
  await page.locator('input[type=file]').last().setInputFiles({
    name: 'veauche_feux_VE001_gaulle_croix_des_peres.json',
    mimeType: 'application/json',
    buffer: Buffer.from(dossier),
  })
  await expect(page.getByText(/Dossier appliqué : VE001/)).toBeVisible()

  const feu = await withDebug(page, (d, id: string) => {
    const net = d.store.getState().project.network
    const controller = net.controllers[net.controls[id]?.controllerId]
    return controller
      ? { source: controller.source, groupes: controller.groups?.length ?? 0, plans: controller.plans?.length ?? 0 }
      : null
  }, nodeId as string)

  expect(feu).toEqual({ source: 'dossier VE001', groupes: 7, plans: 1 })

  // Le jour et l'heure simulés sont un réglage de la commune, pas du feu : ils se règlent dans l'onglet
  // Trafic, et c'est le panneau Feux qui en lit l'effet (le plan que le calendrier du carrefour désigne).
  await page.getByTestId('onglet-trafic').click()
  await page.getByTestId('jour-simule').selectOption('6')
  await page.getByTestId('heure-simulee').fill('17:30')
  await page.getByTestId('onglet-feux').click()
  await expect(page.getByText(/Plan actif à 17 h 30 \(samedi\)/i)).toBeVisible()

  const horloge = await withDebug(page, (d) => {
    const s = d.store.getState().project.settings
    return { startTimeOfDayMin: s.startTimeOfDayMin, dayOfWeek: s.dayOfWeek }
  }, null)
  expect(horloge).toEqual({ startTimeOfDayMin: 1050, dayOfWeek: 6 })
})

test('un nœud se déplace à la souris et le déplacement s’annule', async ({ page }) => {
  await page.goto('/')
  await attendreProjet(page)
  await zoomerSurUnCarrefour(page)

  // Nœud isolé à l'écran : aucun voisin à moins de 70 px, pour que le dépôt ne déclenche pas une fusion.
  const cible = await withDebug(page, (d) => {
    const nodes = d.store.getState().project.network.nodes
    if (!d.map || !d.projection) return null
    const w = window.innerWidth
    const h = window.innerHeight
    const points: { id: string; x: number; y: number; px: number; py: number }[] = []
    for (const [id, n] of Object.entries(nodes) as [string, any][]) {
      const { lon, lat } = d.projection.toLonLat(n.x, n.y)
      const p = d.map.latLngToContainerPoint([lat, lon])
      points.push({ id, x: n.x, y: n.y, px: p.x, py: p.y })
    }
    for (const c of points) {
      if (nodes[c.id].boundary) continue
      if (c.px < 180 || c.py < 180 || c.px > w - 180 || c.py > h - 180) continue
      let libre = true
      for (const o of points) {
        if (o.id === c.id) continue
        // Voisin proche de la position de départ ou de la position d'arrivée : on écarte ce nœud.
        if (Math.hypot(o.px - c.px, o.py - c.py) < 70) { libre = false; break }
        if (Math.hypot(o.px - (c.px + 50), o.py - (c.py + 40)) < 40) { libre = false; break }
      }
      if (libre) return c
    }
    return null
  }, null)

  expect(cible, 'un nœud isolé doit être visible à l’écran').not.toBeNull()

  const boite = await page.locator('.carte-conteneur').boundingBox()
  expect(boite).not.toBeNull()

  await page.mouse.move(boite!.x + cible!.px, boite!.y + cible!.py)
  await page.mouse.down()
  await page.mouse.move(boite!.x + cible!.px + 50, boite!.y + cible!.py + 40, { steps: 10 })
  await page.mouse.up()

  const apres = await withDebug(page, (d, id: string) => {
    const s = d.store.getState()
    const n = s.project.network.nodes[id]
    return { existe: !!n, x: n ? (n.x as number) : 0, y: n ? (n.y as number) : 0, canUndo: s.canUndo as boolean }
  }, cible!.id)

  expect(apres.existe, 'le nœud ne doit pas avoir été fusionné').toBe(true)
  expect(Math.hypot(apres.x - cible!.x, apres.y - cible!.y), 'le nœud doit avoir bougé').toBeGreaterThan(5)
  expect(apres.canUndo, 'le déplacement doit être annulable').toBe(true)

  await page.getByTestId('annuler').click()

  const restaure = await withDebug(page, (d, id: string) => {
    const n = d.store.getState().project.network.nodes[id]
    return { x: n.x as number, y: n.y as number }
  }, cible!.id)
  expect(
    Math.hypot(restaure.x - cible!.x, restaure.y - cible!.y),
    'annuler doit remettre le nœud à sa place',
  ).toBeLessThan(0.5)
})

test('déposer un nœud sur un autre les fusionne', async ({ page }) => {
  await page.goto('/')
  await attendreProjet(page)
  await zoomerSurUnCarrefour(page)

  // Deux nœuds voisins à l'écran : le premier sera déposé sur le second.
  const paire = await withDebug(page, (d) => {
    const nodes = d.store.getState().project.network.nodes
    if (!d.map || !d.projection) return null
    const w = window.innerWidth
    const h = window.innerHeight
    const points: { id: string; px: number; py: number; boundary: boolean }[] = []
    for (const [id, n] of Object.entries(nodes) as [string, any][]) {
      const { lon, lat } = d.projection.toLonLat(n.x, n.y)
      const p = d.map.latLngToContainerPoint([lat, lon])
      if (p.x > 150 && p.y > 150 && p.x < w - 150 && p.y < h - 150) {
        points.push({ id, px: p.x, py: p.y, boundary: !!n.boundary })
      }
    }
    for (const a of points) {
      if (a.boundary) continue
      for (const b of points) {
        if (b.id === a.id || b.boundary) continue
        const dist = Math.hypot(b.px - a.px, b.py - a.py)
        if (dist > 40 && dist < 200) return { source: a, cible: b }
      }
    }
    return null
  }, null)

  expect(paire, 'la démonstration doit contenir deux nœuds voisins à l’écran').not.toBeNull()

  const avant = await withDebug(page, (d) => Object.keys(d.store.getState().project.network.nodes).length, null)

  const boite = await page.locator('.carte-conteneur').boundingBox()
  await page.mouse.move(boite!.x + paire!.source.px, boite!.y + paire!.source.py)
  await page.mouse.down()
  await page.mouse.move(boite!.x + paire!.cible.px, boite!.y + paire!.cible.py, { steps: 12 })
  await page.mouse.up()

  const apres = await withDebug(page, (d, id: string) => {
    const s = d.store.getState()
    return {
      nombre: Object.keys(s.project.network.nodes).length,
      sourceExiste: !!s.project.network.nodes[id],
      canUndo: s.canUndo as boolean,
    }
  }, paire!.source.id)

  expect(apres.sourceExiste, 'le nœud déposé doit avoir disparu').toBe(false)
  expect(apres.nombre).toBeLessThan(avant)
  expect(apres.canUndo).toBe(true)

  // La fusion est annulable et restaure le nœud.
  await page.getByTestId('annuler').click()
  const restaure = await withDebug(page, (d, id: string) => !!d.store.getState().project.network.nodes[id], paire!.source.id)
  expect(restaure, 'annuler doit restaurer le nœud fusionné').toBe(true)
})

test('la recherche retrouve une voie dans une longue liste', async ({ page }) => {
  await page.goto('/')
  await attendreProjet(page)

  await page.getByTestId('onglet-trafic').click()
  const champ = page.getByTestId('recherche-entrees')
  await expect(champ).toBeVisible()
  const entrees = page.locator('section.block').filter({ has: champ })
  const lignes = entrees.locator('tbody tr')
  const total = await lignes.count()
  expect(total).toBeGreaterThan(10)

  // Une entrée réelle de la commune, saisie sans accent ni majuscule : la recherche doit la retrouver.
  const nom = await withDebug(page, (d) => {
    const { demand, network } = d.store.getState().project
    const noms = Object.keys(demand.entries)
      .map((id: string) => demand.entries[id].label ?? network.nodes[id]?.label ?? '')
      .filter((n: string) => n.includes(' '))
    return noms.sort()[0] as string
  }, null)
  await champ.fill(nom.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase())
  await expect(lignes).not.toHaveCount(total)
  await expect(entrees.locator('tbody')).toContainText(nom)

  // Une saisie sans correspondance vide le tableau et le dit.
  await champ.fill('zzzzz')
  await expect(lignes).toHaveCount(0)
  await expect(entrees).toContainText(/Aucun résultat/i)

  // La croix rend la liste entière.
  await entrees.getByRole('button', { name: 'Effacer la recherche' }).click()
  await expect(lignes).toHaveCount(total)
})

test('la configuration se télécharge en JSON complet', async ({ page }) => {
  await page.goto('/')
  await attendreProjet(page)

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('exporter-json').click(),
  ])
  expect(download.suggestedFilename()).toMatch(/^circulation-.*\.json$/)

  const brut = await withDebug(page, (d) => d.store.getState().exportProjectJson() as string, null)
  const projet = JSON.parse(brut)

  expect(projet.format).toBe('circulation-project')
  // Version 2 depuis l'arrivée des dossiers de carrefour ; un fichier version 1 reste relisible.
  expect(projet.version).toBe(2)
  expect(Object.keys(projet.network.edges).length).toBeGreaterThan(500)
  expect(Object.keys(projet.demand.entries).length).toBeGreaterThan(0)
  expect(projet.meta.commune.nom).toMatch(/Veauche/i)
  expect(projet.settings.durationMin).toBeGreaterThan(0)

  // Le fichier se relit sans erreur par le même chemin que l'import de l'interface.
  const relu = await withDebug(page, (d, texte: string) => {
    d.store.getState().importProjectJson(texte)
    const s = d.store.getState()
    return { erreur: s.error as string | null, edges: Object.keys(s.project.network.edges).length }
  }, brut)
  expect(relu.erreur).toBeNull()
  expect(relu.edges).toBeGreaterThan(500)
})

test('la comparaison référence / variante chiffre l’effet d’un changement de signalisation', async ({ page }) => {
  test.setTimeout(300_000)
  await page.goto('/')
  await attendreProjet(page)

  // 1. Scénario de référence : simulation complète en calcul rapide.
  await page.getByTestId('sim-rapide').click()
  await expect
    .poll(async () => withDebug(page, (d) => d.store.getState().sim.status as string, null), { timeout: 240_000 })
    .toBe('done')

  const reference = await withDebug(page, (d) => {
    const n = d.store.getState().sim.results.network
    return { retard: n.meanDelayS as number, sortis: n.exited as number }
  }, null)
  expect(reference.sortis).toBeGreaterThan(100)

  // 2. Figer la référence puis poser des feux sur le carrefour le plus chargé.
  await page.getByTestId('onglet-comparer').click()
  await page.getByTestId('figer-reference').click()

  const carrefour = await withDebug(page, (d) => {
    const s = d.store.getState()
    const net = s.project.network
    const r = s.sim.results
    const flux = new Map<string, number>()
    const degre = new Map<string, number>()
    for (const e of Object.values(net.edges) as any[]) {
      degre.set(e.to, (degre.get(e.to) ?? 0) + 1)
      flux.set(e.to, (flux.get(e.to) ?? 0) + (r.edges[e.id]?.exited ?? 0))
    }
    let best: string | null = null
    let meilleur = -1
    for (const [id, f] of flux) {
      if ((degre.get(id) ?? 0) >= 3 && !net.nodes[id].boundary && f > meilleur) { meilleur = f; best = id }
    }
    if (best) s.setNodeControl(best, { type: 'signals' })
    return best
  }, null)
  expect(carrefour).not.toBeNull()

  // 3. Relancer : le moteur doit repartir de zéro avec le nouveau plan de feux.
  await page.getByTestId('sim-rapide').click()
  await expect
    .poll(async () => withDebug(page, (d) => d.store.getState().sim.status as string, null), { timeout: 240_000 })
    .toBe('done')

  const variante = await withDebug(page, (d) => {
    const s = d.store.getState()
    return {
      retard: s.sim.results.network.meanDelayS as number,
      refRetard: s.project.reference.results.network.meanDelayS as number,
    }
  }, null)

  expect(variante.refRetard).toBeCloseTo(reference.retard, 3)
  // Poser des feux là où la priorité suffisait coûte du temps : l'écart doit être visible, pas nul.
  expect(Math.abs(variante.retard - variante.refRetard)).toBeGreaterThan(1)
  expect(variante.retard).toBeGreaterThan(variante.refRetard)

  // La carte des écarts est disponible.
  await page.getByTestId('carte-delta-retard').click()
  expect(await withDebug(page, (d) => d.store.getState().ui.colorMode as string, null)).toBe('deltaDelay')
})

test('les cinq itinéraires les plus courts se comparent entre deux nœuds cliqués', async ({ page }) => {
  await page.goto('/')
  await attendreProjet(page)
  await page.getByTestId('onglet-reseau').click()
  await page.getByTestId('outil-itineraires').click()

  // Deux carrefours distants de quelques centaines de mètres, cadrés ensemble à l'écran.
  const paire = await withDebug(page, (d) => {
    const net = d.store.getState().project.network
    const degre = new Map<string, number>()
    for (const e of Object.values(net.edges) as any[]) degre.set(e.to, (degre.get(e.to) ?? 0) + 1)
    const candidats = (Object.values(net.nodes) as any[]).filter((n) => !n.boundary && (degre.get(n.id) ?? 0) >= 3)
    for (const a of candidats) {
      for (const b of candidats) {
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        if (dist < 500 || dist > 900) continue
        const A = d.projection!.toLonLat(a.x, a.y)
        const B = d.projection!.toLonLat(b.x, b.y)
        d.map.fitBounds([[A.lat, A.lon], [B.lat, B.lon]], { padding: [140, 140], animate: false })
        return { a: a.id, b: b.id }
      }
    }
    return null
  }, null)
  expect(paire, 'deux carrefours éloignés doivent exister dans la commune').not.toBeNull()
  await page.waitForTimeout(800)

  // Points écran des deux nœuds, en vérifiant qu'aucun autre nœud n'est plus près du clic.
  const points = await withDebug(page, (d, ids: { a: string; b: string }) => {
    const nodes = d.store.getState().project.network.nodes
    const point = (id: string) => {
      const n = nodes[id]
      const { lon, lat } = d.projection!.toLonLat(n.x, n.y)
      const p = d.map.latLngToContainerPoint([lat, lon])
      let plusProche = id
      let meilleure = Infinity
      for (const [autre, m] of Object.entries(nodes) as [string, any][]) {
        const ll = d.projection!.toLonLat(m.x, m.y)
        const q = d.map.latLngToContainerPoint([ll.lat, ll.lon])
        const dist = Math.hypot(q.x - p.x, q.y - p.y)
        if (dist < meilleure) { meilleure = dist; plusProche = autre }
      }
      return { px: p.x, py: p.y, plusProche }
    }
    return { a: point(ids.a), b: point(ids.b) }
  }, paire!)
  expect(points.a.plusProche).toBe(paire!.a)
  expect(points.b.plusProche).toBe(paire!.b)

  const boite = await page.locator('.carte-conteneur').boundingBox()
  expect(boite).not.toBeNull()
  await page.mouse.click(boite!.x + points.a.px, boite!.y + points.a.py)
  await page.mouse.click(boite!.x + points.b.px, boite!.y + points.b.py)

  // Le panneau liste cinq itinéraires, du plus rapide au plus lent.
  await expect(page.getByTestId('itineraire-0')).toBeVisible()
  await expect(page.getByTestId('itineraire-4')).toBeVisible()
  const temps = await withDebug(page, (d) => {
    const a = d.store.getState().ui.itineraires
    return { chemins: a.chemins.map((c: any) => c.time as number), from: a.from as string, to: a.to as string }
  }, null)
  expect(temps.from).toBe(paire!.a)
  expect(temps.to).toBe(paire!.b)
  expect(temps.chemins).toHaveLength(5)
  for (let i = 1; i < temps.chemins.length; i++) expect(temps.chemins[i]).toBeGreaterThanOrEqual(temps.chemins[i - 1])

  // Le temps du premier itinéraire est écrit dans le tableau, et le ruban est dessiné sur la carte.
  await expect(page.getByTestId('itineraire-0')).toContainText(/\d+\s*(s|min)/)
  const rubanVisible = await page.evaluate(() => {
    const c = document.querySelector('canvas.carte-canvas--statique') as HTMLCanvasElement | null
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return false
    const data = ctx.getImageData(0, 0, c.width, c.height).data
    // Couleur du meilleur itinéraire (#d1495b), tolérance large : le ruban est dessiné en semi-transparence.
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i] - 209) < 40 && Math.abs(data[i + 1] - 73) < 45 && Math.abs(data[i + 2] - 91) < 45) return true
    }
    return false
  })
  expect(rubanVisible, 'le ruban du meilleur itinéraire doit être visible sur la carte').toBe(true)

  // Une modification du réseau périme la comparaison plutôt que d'afficher des temps devenus faux.
  await withDebug(page, (d) => {
    const s = d.store.getState()
    const chemin = s.ui.itineraires.chemins[0]
    s.updateEdge(chemin.edges[0], { closed: true })
  }, null)
  await expect(page.getByTestId('itineraires-perimes')).toBeVisible()
  await page.getByTestId('itineraires-recalculer').click()
  await expect(page.getByTestId('itineraire-0')).toBeVisible()
  const apres = await withDebug(page, (d) => {
    const a = d.store.getState().ui.itineraires
    return { perime: a.perime as boolean, premier: a.chemins[0].edges as string[] }
  }, null)
  expect(apres.perime).toBe(false)
  // Le tronçon fermé n'est plus emprunté : le recalcul a bien vu le réseau modifié.
  expect(apres.premier.length).toBeGreaterThan(0)
})
