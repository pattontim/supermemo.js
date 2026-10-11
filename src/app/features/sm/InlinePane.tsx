import React, { Suspense, lazy, useEffect, useState } from 'react';

/**
 * LOAD_PANES_WITH_PARENT:
 *   true  - lazy chunk + content mount as soon as the player renders;
 *           toggling only shows/hides.
 *   false (default) - chunk + content fetched/mounted only on first expand.
 */
export const LOAD_PANES_WITH_PARENT = false;

const PANES = {
  archive: lazy(() => import('../../templates/archive/Archive')),
} as const;

export type PaneKey = keyof typeof PANES;

export const InlinePane = ({ paneKey, title, expanded, onToggle, defaultExpanded = false }: {
  paneKey: PaneKey;
  title: string;
  /** Controlled expanded state. Omit for uncontrolled (internal) state. */
  expanded?: boolean;
  onToggle?: (next: boolean) => void;
  defaultExpanded?: boolean;
}) => {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const [everExpanded, setEverExpanded] = useState(defaultExpanded);

  const isControlled = expanded !== undefined;
  const isExpanded = isControlled ? expanded : internalExpanded;

  useEffect(() => {
    if (isExpanded) setEverExpanded(true);
  }, [isExpanded]);

  const toggle = () => {
    const next = !isExpanded;
    if (isControlled) {
      onToggle && onToggle(next);
    } else {
      setInternalExpanded(next);
    }
    if (next) setEverExpanded(true);
  };

  const shouldMount = LOAD_PANES_WITH_PARENT || everExpanded;
  const Content = PANES[paneKey];

  return (
    <div className="accordion-item">
      <div className="accordion-title" onClick={toggle} style={{ cursor: 'pointer' }}>
        <div>{title} [{isExpanded ? '−' : '+'}]</div>
      </div>
      {shouldMount && (
        <div
          className="accordion-content"
          // Once mounted, content STAYS mounted; expand/collapse toggles
          // visibility only (preserves component state, avoids refetching).
          style={{ display: isExpanded ? 'block' : 'none' }}
        >
          <Suspense fallback={<div style={{ padding: '12px' }}>Loading…</div>}>
            <Content />
          </Suspense>
        </div>
      )}
    </div>
  );
};
