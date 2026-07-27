import { Component } from 'react';

/* Catches render/lifecycle errors from the page tree so one broken page shows a
   recoverable panel instead of white-screening the whole application.
   Must be a class — React has no hook equivalent for componentDidCatch. */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep the stack in the console for developers; the UI stays non-technical.
    console.error('[Synapse] Unhandled UI error:', error, info?.componentStack);
  }

  componentDidUpdate(prevProps) {
    // A route change should clear a previous page's error so the app recovers.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="page active">
        <div className="page-header">
          <div>
            <h1 className="page-title">Something went wrong</h1>
            <div className="page-subtitle">This screen failed to load. The rest of Synapse is unaffected.</div>
          </div>
        </div>
        <div className="page-body">
          <div className="card" style={{ maxWidth: 640 }}>
            <p style={{ fontSize: 'var(--fs-base)', color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 16 }}>
              You can retry this screen, or move to another page from the sidebar. If it keeps
              happening, send the details below to your Synapse administrator.
            </p>
            <div className="flex gap-8 mb-16">
              <button className="btn btn-primary btn-sm" onClick={() => this.setState({ error: null })}>
                Retry this page
              </button>
              <button className="btn btn-outline btn-sm" onClick={() => { window.location.href = '/dashboard'; }}>
                Go to Dashboard
              </button>
            </div>
            <details>
              <summary style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                Technical details
              </summary>
              <pre className="json-block" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
                {String(error?.stack || error?.message || error)}
              </pre>
            </details>
          </div>
        </div>
      </div>
    );
  }
}
