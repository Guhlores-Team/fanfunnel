"use client";

import type { ReactNode, RefObject } from "react";
import { useFocusTrap } from "@/lib/hooks/useFocusTrap";

export interface ModalProps {
  /** Called to dismiss (Escape / backdrop click). Omit Escape by passing dismissable=false. */
  onClose: () => void;
  children: ReactNode;
  /** Accessible name for the dialog (sets aria-label). */
  label?: string;
  /** id of an element labelling the dialog (sets aria-labelledby). */
  labelledBy?: string;
  /**
   * When false, the dialog is non-dismissable: no Escape, no backdrop-close.
   * Used for compliance gates that must stay trapped. Defaults to true.
   */
  dismissable?: boolean;
  /** Focus this element on open instead of the first focusable child. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Extra classes for the dialog panel. */
  className?: string;
  /** Classes for the fixed backdrop wrapper (positioning, padding, bg). */
  overlayClassName?: string;
  /** Inline style for the dialog panel (e.g. brand-tinted shadow). */
  style?: React.CSSProperties;
}

/**
 * Shared accessible modal: a focus-trapped dialog over a backdrop. Provides
 * focus-in on open, Tab/Shift-Tab cycling, Escape-to-close (unless
 * non-dismissable), focus restore on close, and role/aria-modal — so call sites
 * stop re-implementing these by hand. Visuals are driven entirely by the caller
 * via className/overlayClassName/style, keeping each existing dialog's look.
 */
export default function Modal({
  onClose,
  children,
  label,
  labelledBy,
  dismissable = true,
  initialFocus,
  className = "",
  overlayClassName = "fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm",
  style,
}: ModalProps) {
  const ref = useFocusTrap<HTMLDivElement>({
    active: true,
    onEscape: dismissable ? onClose : undefined,
    initialFocus,
  });

  return (
    <div
      className={overlayClassName}
      onClick={dismissable ? onClose : undefined}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        className={className}
        style={style}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
