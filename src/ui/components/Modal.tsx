/**
 * Fenêtre modale minimale : voile, panneau centré, fermeture par la croix, la touche Échap ou un clic
 * sur le voile. Le focus est amené sur le panneau à l'ouverture et rendu à l'élément précédent à la fermeture.
 */
import { useEffect, useRef } from 'react'
import type { JSX, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { S } from '@/ui/strings'

export interface ModalProps {
  title: string
  onClose(): void
  children: ReactNode
}

export function Modal(props: ModalProps): JSX.Element {
  const { title, onClose, children } = props
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panelRef.current?.focus()
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previous?.focus?.()
    }
  }, [onClose])

  const modal = (
    <div className="modal-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={panelRef}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="icon-button" onClick={onClose} title={S.app.fermer} aria-label={S.app.fermer}>×</button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}
