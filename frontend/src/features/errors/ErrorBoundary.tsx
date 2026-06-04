import * as React from "react";
import { ErrorPage } from "./ErrorPage";

interface ErrorBoundaryState {
  error: Error | null;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /**
   * Optional render override. Default is `<ErrorPage error={error} />`.
   * Useful for tests that need to assert on a specific UI without
   * coupling to the (large) ErrorPage tree.
   */
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
}

/**
 * Top-level React error boundary. Wraps the app inside `<App>` so any
 * thrown render-phase error in a route or shell renders a friendly
 * surface instead of the white-screen-of-death.
 *
 * Scope notes:
 *  - Boundaries don't catch async errors thrown outside React's render
 *    cycle (e.g. unhandled rejections in event handlers, fetch errors).
 *    Those flow through TanStack Query / fetch error handling.
 *  - We log to `console.error` in `componentDidCatch` so the local dev
 *    console retains the full stack. A real reporter (Sentry) wires in
 *    here in a later slice.
 */
export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", error, info);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) return this.props.fallback(error, this.reset);
      return <ErrorPage error={error} onRetry={this.reset} />;
    }
    return this.props.children;
  }
}
