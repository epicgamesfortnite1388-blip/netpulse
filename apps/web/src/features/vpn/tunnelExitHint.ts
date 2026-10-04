/**
 * What the "Active tunnel" card says underneath its value.
 *
 * The card shows two things that must agree: the value names the tunnel that is
 * up, the hint explains where it exits. The hint used to fall back to "nothing
 * is carrying traffic" whenever no exit IP was known — which is true only when
 * there is no tunnel. A live proxy tunnel whose exit has not been confirmed
 * rendered as "proxy tunnel / nothing is carrying traffic" on the same card,
 * telling the user their working tunnel was dead.
 *
 * Derived in one place so the value and the hint cannot drift apart again.
 */

/** The tunnel kinds the card distinguishes; `null` means no tunnel is up. */
export type ActiveTunnel = 'proxy tunnel' | string | null;

export function tunnelExitHint(args: {
  /** What the card's value shows — null when no tunnel is up. */
  activeTunnel: ActiveTunnel;
  /** Exit IP confirmed by an external check, when there is one. */
  verifiedPublicIp?: string | null;
  /** Exit IP the tunnel itself reports. */
  exitIp?: string | null;
}): string {
  const { activeTunnel, verifiedPublicIp, exitIp } = args;
  if (verifiedPublicIp) return `exit ${verifiedPublicIp}`;
  if (exitIp) return `exit ${exitIp}`;
  // Unknown exit, live tunnel: traffic IS flowing, the exit is simply unknown.
  return activeTunnel ? 'exit not verified' : 'nothing is carrying traffic';
}