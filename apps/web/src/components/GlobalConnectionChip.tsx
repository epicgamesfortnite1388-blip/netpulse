/**
 * Global connection indicator. Isolated into its own component so the 4-5s
 * backend polls re-render only this chip, not the entire application shell.
 */
import { NavLink } from 'react-router';

import { TONE_VAR, useConnection } from '@/features/connection/connectionState';

import type { CSSProperties } from 'react';

export function GlobalConnectionChip() {
  const state = useConnection();
  return (
    <NavLink
      to="/vpn"
      className="np-state-badge"
      style={{ '--np-state': TONE_VAR[state.tone] } as CSSProperties}
      aria-label={`Connection: ${state.label}. Open connection settings.`}
      title={state.detail}
    >
      <span className="np-state-dot" />
      {state.short}
    </NavLink>
  );
}
