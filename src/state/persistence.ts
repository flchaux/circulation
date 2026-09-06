/**
 * Persistance navigateur (§6 de docs/ARCHITECTURE.md) : IndexedDB via `idb-keyval`.
 *
 * Clés utilisées dans l'unique magasin `circulation/kv` :
 *   - `project:current` : projet courant autosauvegardé (chaîne JSON) ;
 *   - `library:index`   : index de la bibliothèque (LibraryEntry[]) ;
 *   - `library:<id>`    : projet de la bibliothèque (chaîne JSON) ;
 *   - `osm:<code>`      : extrait Overpass mis en cache (objet OsmExtract).
 *
 * Les lectures sont tolérantes (une base indisponible ou corrompue équivaut à « rien en cache ») ; les écritures
 * remontent leur erreur à l'appelant, qui l'affiche en français.
 */
import { createStore, del as idbDel, get as idbGet, set as idbSet, type UseStore } from 'idb-keyval'
import type { Project } from '@/model/types'
import type { OsmExtract } from '@/geo/types'
import { validateProject } from '@/model/schema'
import type { LibraryEntry } from './storeTypes'

const DB_NAME = 'circulation'
const STORE_NAME = 'kv'

export const KEY_CURRENT = 'project:current'
export const KEY_LIBRARY_INDEX = 'library:index'
export const libraryKey = (id: string): string => `library:${id}`
export const osmKey = (code: string): string => `osm:${code}`

/** Délai d'inactivité avant autosauvegarde du projet courant. */
export const AUTOSAVE_DEBOUNCE_MS = 800

let customStore: UseStore | null = null

/** Magasin IndexedDB, créé à la première utilisation (absent hors navigateur). */
function store(): UseStore | null {
  if (!customStore) {
    if (typeof indexedDB === 'undefined') return null
    customStore = createStore(DB_NAME, STORE_NAME)
  }
  return customStore
}

function requireStore(): UseStore {
  const s = store()
  if (!s) throw new Error("Le stockage local du navigateur (IndexedDB) n'est pas disponible.")
  return s
}

async function readRaw<T>(key: string): Promise<T | undefined> {
  const s = store()
  if (!s) return undefined
  try {
    return await idbGet<T>(key, s)
  } catch {
    return undefined // base illisible : on se comporte comme si la clé était absente
  }
}

/* ------------------------------------------------------------------ */
/*  Cache des extraits OSM                                             */
/* ------------------------------------------------------------------ */

export async function getCachedExtract(code: string): Promise<OsmExtract | undefined> {
  const value = await readRaw<OsmExtract>(osmKey(code))
  if (!value || value.format !== 'circulation-osm-extract' || !value.osm || !value.commune) return undefined
  return value
}

export async function putCachedExtract(extract: OsmExtract): Promise<void> {
  await idbSet(osmKey(extract.commune.code), extract, requireStore())
}

/* ------------------------------------------------------------------ */
/*  Projet courant (autosauvegarde)                                    */
/* ------------------------------------------------------------------ */

function parseStoredProject(value: unknown): Project | null {
  if (typeof value !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  const result = validateProject(parsed)
  return result.ok ? result.project : null
}

/** Projet autosauvegardé, ou `null` s'il est absent, illisible ou invalide. */
export async function loadCurrentProject(): Promise<Project | null> {
  return parseStoredProject(await readRaw<string>(KEY_CURRENT))
}

export async function saveCurrentProject(project: Project): Promise<void> {
  await idbSet(KEY_CURRENT, JSON.stringify(project), requireStore())
}

let autosaveTimer: ReturnType<typeof setTimeout> | null = null
let autosavePending: Project | null = null
let autosaveInFlight: Promise<void> = Promise.resolve()
let autosaveOnError: ((message: string) => void) | undefined

/** Attend un moment d'inactivité (repli : prochaine boucle d'événements). */
function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 2000 })
    else setTimeout(resolve, 0)
  })
}

function runAutosave(): void {
  const project = autosavePending
  autosavePending = null
  if (!project) return
  const onError = autosaveOnError
  // La sérialisation (coûteuse sur un gros réseau) est repoussée à un temps mort du navigateur.
  autosaveInFlight = whenIdle()
    .then(() => saveCurrentProject(project))
    .catch(() => onError?.("Échec de l'enregistrement automatique : le stockage du navigateur est indisponible."))
}

/** Programme l'autosauvegarde du projet courant (déclenchée après `AUTOSAVE_DEBOUNCE_MS` d'inactivité). */
export function scheduleAutosave(project: Project, onError?: (message: string) => void): void {
  autosavePending = project
  autosaveOnError = onError
  if (autosaveTimer) clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null
    runAutosave()
  }, AUTOSAVE_DEBOUNCE_MS)
}

/** Force l'écriture en attente et attend sa fin (fermeture de page, tests). */
export async function flushAutosave(): Promise<void> {
  if (autosaveTimer) {
    clearTimeout(autosaveTimer)
    autosaveTimer = null
    runAutosave()
  }
  await autosaveInFlight
}

/* ------------------------------------------------------------------ */
/*  Bibliothèque de projets                                            */
/* ------------------------------------------------------------------ */

function isLibraryEntry(value: unknown): value is LibraryEntry {
  const e = value as LibraryEntry | null
  return !!e && typeof e.id === 'string' && typeof e.name === 'string' && typeof e.updatedAt === 'string'
}

export async function listLibrary(): Promise<LibraryEntry[]> {
  const raw = await readRaw<unknown>(KEY_LIBRARY_INDEX)
  if (!Array.isArray(raw)) return []
  return raw.filter(isLibraryEntry)
}

function libraryEntry(project: Project): LibraryEntry {
  const entry: LibraryEntry = {
    id: project.meta.id,
    name: project.meta.name,
    updatedAt: new Date().toISOString(),
    edgeCount: Object.keys(project.network.edges).length,
  }
  if (project.meta.commune) entry.commune = project.meta.commune.nom
  return entry
}

/** Enregistre (ou remplace) un projet dans la bibliothèque et renvoie l'index à jour. */
export async function saveLibraryProject(project: Project): Promise<LibraryEntry[]> {
  const s = requireStore()
  await idbSet(libraryKey(project.meta.id), JSON.stringify(project), s)
  const index = [libraryEntry(project), ...(await listLibrary()).filter((e) => e.id !== project.meta.id)]
  index.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  await idbSet(KEY_LIBRARY_INDEX, index, s)
  return index
}

export async function loadLibraryProject(id: string): Promise<Project | null> {
  return parseStoredProject(await readRaw<string>(libraryKey(id)))
}

export async function deleteLibraryProject(id: string): Promise<LibraryEntry[]> {
  const s = requireStore()
  await idbDel(libraryKey(id), s)
  const index = (await listLibrary()).filter((e) => e.id !== id)
  await idbSet(KEY_LIBRARY_INDEX, index, s)
  return index
}

/* ------------------------------------------------------------------ */
/*  Identifiants et noms de fichiers                                   */
/* ------------------------------------------------------------------ */

/** Identifiant de projet unique (bibliothèque, autosauvegarde). */
export function newProjectId(): string {
  const random = Math.random().toString(36).slice(2, 8)
  return `p${Date.now().toString(36)}${random}`
}

/** Fragment d'URL/nom de fichier : minuscules, sans accents ni ponctuation. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'projet'
}

/** Nom du fichier d'export : `circulation-<slug>-<AAAA-MM-JJ>.json`. */
export function projectFileName(project: Project): string {
  const date = new Date().toISOString().slice(0, 10)
  return `circulation-${slugify(project.meta.commune?.nom ?? project.meta.name)}-${date}.json`
}
