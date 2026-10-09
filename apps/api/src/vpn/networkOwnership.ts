/**
 * The single queue for operations that change who owns the machine's network
 * state.
 *
 * Two independent state machines used to transition the OS concurrently:
 *
 *   - the VPN engine profiles (connect / reconnect / disconnect), and
 *   - the proxy tunnel (start / quick-connect / reconnect / stop).
 *
 * Both write the same system-proxy registry value — each capturing a
 * `previousProxy` at ITS OWN start time and restoring it at stop — both arm
 * and release the same kill-switch hold, and (in TUN form) both claim the
 * default route. Nothing coordinated them, so the common flows broke in ways
 * that looked like flaky engines:
 *
 *   - connecting an engine while the tunnel was up left the OS proxy pointing
 *     at the previous owner's port; whichever stopped SECOND then "restored"
 *     a stale value, wiping the survivor's handoff — traffic bypassed the
 *     connection the user could see was up;
 *   - stopping one mode released the kill-switch hold the OTHER mode had
 *     armed, silently disarming fail-closed protection;
 *   - switching modes captured restore-chains (user proxy → tunnel port →
 *     engine port) that ended on a dead port: no internet after disconnect.
 *
 * The rule this queue enforces is one writer at a time, and each mode is
 * started only after the other has fully released what it held — so the
 * `previousProxy` a mode captures is always the user's own value, never
 * another mode's port.
 *
 * It replaces the module-local serializer that only the engine routes shared
 * (`serializeVpnOp` in routes/vpn.ts): the queue keeps that name and call
 * shape, and now also wraps tunnel transitions, handovers between the modes,
 * and the drop watchdog's reconnect attempts — the places that could
 * previously interleave a transition already in flight.
 *
 * RE-ENTRANCE RULE: a queued function must never call `serializeVpnOp` again
 * (it would await itself). Helpers invoked inside a queued section talk to
 * the tunnel service's own internal chain or to providers directly.
 */
let chain: Promise<unknown> = Promise.resolve();

export function serializeVpnOp<T>(op: () => Promise<T>): Promise<T> {
  const next = chain.then(op, op);
  chain = next.catch(() => undefined);
  return next;
}
