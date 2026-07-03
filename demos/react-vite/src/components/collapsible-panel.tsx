import type { ReactNode } from 'react';

type CollapsiblePanelProps = {
  title: string;
  description: string;
  children: ReactNode;
  defaultOpen?: boolean;
  wide?: boolean;
  tone?: 'default' | 'error';
};

type CollapsibleSectionProps = {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
};

export function CollapsiblePanel({
  title,
  description,
  children,
  defaultOpen = false,
  wide = false,
  tone = 'default',
}: CollapsiblePanelProps) {
  return (
    <details
      className={`callback-panel ${wide ? 'callback-panel-wide' : ''} ${tone === 'error' ? 'callback-panel-error' : ''}`}
      open={defaultOpen}
    >
      <summary className="callback-panel-summary">
        <span className="callback-panel-heading">
          <span className="callback-panel-title">{title}</span>
          <span className="callback-panel-description">{description}</span>
        </span>
      </summary>
      <div className="callback-panel-body">{children}</div>
    </details>
  );
}

export function CollapsibleSection({ title, children, defaultOpen = false }: CollapsibleSectionProps) {
  return (
    <details className="callback-section" open={defaultOpen}>
      <summary className="callback-section-summary">{title}</summary>
      <div className="callback-section-body">{children}</div>
    </details>
  );
}
