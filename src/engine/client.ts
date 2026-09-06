/**
 * Enveloppe typée du Worker côté interface (§5.8 de docs/ARCHITECTURE.md).
 * Le store n'instancie ce client qu'au premier démarrage de simulation.
 */
import type { FromWorker, SimClientLike, ToWorker } from './protocol'

export class SimClient implements SimClientLike {
  private readonly worker: Worker

  constructor(onMessage: (msg: FromWorker) => void) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (ev: MessageEvent<FromWorker>) => onMessage(ev.data)
    this.worker.onmessageerror = () => onMessage({ type: 'error', message: 'Message illisible reçu du moteur.' })
    this.worker.onerror = (ev: ErrorEvent) => {
      onMessage({ type: 'error', message: `Erreur du moteur : ${ev.message || 'cause inconnue'}` })
    }
  }

  send(msg: ToWorker): void {
    this.worker.postMessage(msg)
  }

  dispose(): void {
    this.worker.onmessage = null
    this.worker.onerror = null
    this.worker.terminate()
  }
}
