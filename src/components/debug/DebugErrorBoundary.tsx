"use client";

import { Component, type ReactNode } from "react";
import { isDebugActive, reportError } from "./debug";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * Catches React render/lifecycle errors in the subtree so they surface in the
 * in-app debug console instead of vanishing.
 *
 * Crucially, this is transparent when debug mode is OFF: it re-throws the
 * error from render so Next.js's normal error handling (error.tsx / the default
 * overlay) takes over exactly as before. Only in debug mode does it report the
 * error and show a minimal inline fallback (the floating console shows details).
 */
export default class DebugErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    if (!isDebugActive()) return;
    reportError({
      kind: "react",
      message: error?.message || String(error),
      stack:
        (error?.stack ? error.stack + "\n" : "") +
        (info?.componentStack
          ? "Component stack:" + info.componentStack
          : ""),
    });
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      // Debug off → behave like we were never here: let the error propagate to
      // the nearest Next.js boundary.
      if (!isDebugActive()) throw this.state.error;
      return (
        <div
          role="alert"
          className="m-4 rounded-xl border border-line bg-surface p-4 text-sm text-ink"
        >
          <p className="font-semibold text-red-400">A component crashed.</p>
          <p className="mt-1 text-muted">
            Details are in the debug console (bottom-right). Fix the cause, then
          </p>
          <button
            onClick={this.reset}
            className="mt-3 rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-white/5"
          >
            Try to recover
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
