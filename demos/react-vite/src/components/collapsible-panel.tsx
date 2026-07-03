import { useState, type ReactNode, type SyntheticEvent } from 'react';

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

function useCollapsible(defaultOpen: boolean) {
  const [open, setOpen] = useState(defaultOpen);

  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    setOpen(event.currentTarget.open);
  };

  return { open, onToggle };
}

export function CollapsiblePanel({
  title,
  description,
  children,
  defaultOpen = false,
  wide = false,
  tone = 'default',
}: CollapsiblePanelProps) {
  const { open, onToggle } = useCollapsible(defaultOpen);

  return (
    <details
      className={`callback-panel ${wide ? 'callback-panel-wide' : ''} ${tone === 'error' ? 'callback-panel-error' : ''}`}
      open={open}
      onToggle={onToggle}
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
  const { open, onToggle } = useCollapsible(defaultOpen);

  return (
    <details className="callback-section" open={open} onToggle={onToggle}>
      <summary className="callback-section-summary">{title}</summary>
      <div className="callback-section-body">{children}</div>
    </details>
  );
}
