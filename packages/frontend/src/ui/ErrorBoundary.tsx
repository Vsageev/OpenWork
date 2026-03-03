import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw, Home, ChevronDown, Copy, Check } from 'lucide-react';
import styles from './ErrorBoundary.module.css';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  showDetails: boolean;
  copied: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, showDetails: false, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null, showDetails: false, copied: false });
  };

  handleGoHome = () => {
    window.location.href = '/';
  };

  handleGoBack = () => {
    window.history.back();
  };

  handleToggleDetails = () => {
    this.setState((prev) => ({ showDetails: !prev.showDetails }));
  };

  handleCopy = () => {
    const { error } = this.state;
    if (!error) return;
    const text = [
      `Error: ${error.name}: ${error.message}`,
      '',
      `URL: ${window.location.href}`,
      `Time: ${new Date().toISOString()}`,
      `User Agent: ${navigator.userAgent}`,
      '',
      error.stack || '(no stack trace)',
    ].join('\n');
    navigator.clipboard.writeText(text).then(() => {
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 2000);
    }).catch(() => {
      // Fallback: silently ignore if clipboard is unavailable
    });
  };

  render() {
    if (this.state.hasError) {
      const { error, showDetails, copied } = this.state;

      return (
        <div className={styles.page}>
          <div className={styles.icon}>
            <AlertTriangle size={36} strokeWidth={1.5} />
          </div>
          <h2 className={styles.title}>Something went wrong</h2>
          <p className={styles.message}>
            An unexpected error occurred. You can try again, or go back to the dashboard.
          </p>

          <div className={styles.actions}>
            <button className={styles.actionBtnGhost} onClick={this.handleGoBack}>
              Go Back
            </button>
            <button className={styles.actionBtnPrimary} onClick={this.handleRetry}>
              <RotateCcw size={14} />
              Try Again
            </button>
            <button className={styles.actionBtnGhost} onClick={this.handleGoHome}>
              <Home size={14} />
              Dashboard
            </button>
          </div>

          {error && (
            <>
              <button className={styles.detailsToggle} onClick={this.handleToggleDetails}>
                <ChevronDown
                  size={14}
                  className={`${styles.detailsChevron}${showDetails ? ` ${styles.detailsChevronOpen}` : ''}`}
                />
                {showDetails ? 'Hide error details' : 'Show error details'}
              </button>

              {showDetails && (
                <div className={styles.details}>
                  <div className={styles.detailsBox}>
                    <button
                      className={copied ? styles.copyBtnDone : styles.copyBtn}
                      onClick={this.handleCopy}
                    >
                      {copied ? <Check size={11} /> : <Copy size={11} />}
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                    <div className={styles.detailsErrorName}>{error.name}</div>
                    <div className={styles.detailsErrorMessage}>{error.message}</div>
                    {error.stack && (
                      <div className={styles.detailsStack}>
                        {error.stack}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
