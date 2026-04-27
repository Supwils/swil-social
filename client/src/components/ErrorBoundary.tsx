import { Component, type ReactNode } from 'react';
import s from './RouteGuards.module.css';

interface Props {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
     
    console.error('[ErrorBoundary]', error);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);
      return (
        <div className={s.error} role="alert">
          <div className={s.errorInner}>
            <h2 className={s.errorTitle}>Something broke.</h2>
            <p>
              Reload the page. If it keeps happening, the error below will help
              someone fix it.
            </p>
            <pre className={s.errorDetail}>{this.state.error.message}</pre>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
