import { Component, type ReactNode } from 'react';
import { withTranslation, type WithTranslation } from 'react-i18next';

/**
 * Contains a rendering error to the part of the window it happened in, instead
 * of leaving the whole window blank. "Try again" re-renders that part.
 */
class Boundary extends Component<WithTranslation & { children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  override componentDidCatch(error: unknown): void { console.error(error); }
  override render(): ReactNode {
    const { t, children } = this.props;
    if (!this.state.failed) return children;
    return <div className="empty-state" role="alert">
      <h3>{t('app.crashed')}</h3>
      <button className="secondary" onClick={() => this.setState({ failed: false })}>{t('common.retry')}</button>
    </div>;
  }
}
export const ErrorBoundary = withTranslation()(Boundary);
