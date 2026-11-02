import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import loglevel from 'loglevel';
import { reportError } from '../../services/diagnostics/crash-reporter';
import { RenderErrorFallback } from './RenderErrorFallback';

const log = loglevel.getLogger('RenderErrorBoundary');

interface RenderErrorBoundaryProps {
  /** Names the replaced region in the console and crash report. */
  scope: 'app' | 'workspace';
  children: ReactNode;
}

interface RenderErrorBoundaryState {
  error: Error | null;
}

/**
 * Replaces a crashed render tree with a retryable stop screen. The workspace
 * instance sits inside ProjectRuntimeProvider, so a failing editor or panel
 * no longer unmounts the project's Agent tool bridge: a running Agent turn
 * keeps its tools while the author reads the error and retries.
 */
export class RenderErrorBoundary extends Component<RenderErrorBoundaryProps, RenderErrorBoundaryState> {
  state: RenderErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RenderErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    log.error(`[${this.props.scope}] Unhandled renderer error:`, error, info.componentStack);
    // The region was replaced by the fallback, so this is always fatal to it.
    reportError('render-failure', error, 'fatal');
  }

  private retry = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return <RenderErrorFallback error={this.state.error} onRetry={this.retry} />;
    }
    return this.props.children;
  }
}
