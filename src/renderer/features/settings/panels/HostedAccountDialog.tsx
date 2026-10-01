import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { ModalCard, ModalRoot } from '../../../components/ui/Modal';

/** Account overlays sit above Settings and own focus/Escape until dismissed. */
export function HostedAccountDialog({
  title,
  busy = false,
  onClose,
  children,
  returnFocusRef,
}: {
  title: string;
  busy?: boolean;
  onClose(): void;
  children: ReactNode;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous =
      returnFocusRef?.current ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    content.current?.querySelector<HTMLElement>('[data-dialog-autofocus]')?.focus();
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [returnFocusRef]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!busy) onClose();
      } else if (event.key === 'Tab') {
        const items = [
          ...(content.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
          ) ?? []),
        ].filter((element) => element.getClientRects().length > 0);
        const first = items[0];
        const last = items[items.length - 1];
        if (!first) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (
          event.shiftKey &&
          (document.activeElement === first || !content.current?.contains(document.activeElement))
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || !content.current?.contains(document.activeElement))
        ) {
          event.preventDefault();
          first.focus();
        }
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [busy, onClose]);
  return (
    <ModalRoot
      ariaLabel={title}
      onClose={onClose}
      closeOnBackdrop={!busy}
      dismissOnEscape={false}
      className="set-account-modal"
    >
      <ModalCard width={440}>
        <div ref={content} className="set-account-dialog-content">
          {children}
        </div>
      </ModalCard>
    </ModalRoot>
  );
}
