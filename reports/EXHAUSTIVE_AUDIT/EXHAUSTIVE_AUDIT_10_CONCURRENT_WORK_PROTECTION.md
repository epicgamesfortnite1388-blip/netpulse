# EXHAUSTIVE_AUDIT_10 — Concurrent work protection

## Policy

A file is excluded from the commit candidate set when any of the following applies:

- It was observed changing while verification was running.
- It belongs to a separate UI-design stream not authored by this mission.
- Its ownership is mixed or uncertain.
- It is local operational state or a scratch artifact.
- It would require C3 math authorization to include safely.

No excluded file was edited, staged, reverted, or cleaned by this mission.

## Concurrent external UI files

The following dirty files were protected and excluded:

- `apps/web/src/components/EngineBadge.tsx`
- `apps/web/src/features/map/LiveMapPage.tsx`
- `apps/web/src/features/account/AccountPage.tsx`
- `apps/web/src/features/nodes/NodeDetailPage.tsx`
- `apps/web/src/features/nodes/NodeExplorerPage.tsx`
- `apps/web/src/features/vpn/AetherCore.tsx`
- `apps/web/src/features/vpn/AetherSurface.tsx`
- `apps/web/src/features/vpn/AgentPathTrace.tsx`
- `apps/web/src/features/vpn/OverviewSurface.tsx`
- `apps/web/src/features/vpn/QuickConnectActivity.tsx`
- `apps/web/src/features/vpn/TunnelSurface.tsx`
- `apps/web/src/features/vpn/VpnPage.tsx`
- `apps/web/src/features/vpn/engineMeta.ts`
- `apps/web/test/designPrimitives.test.tsx`
- `scripts/unify-palette.mjs`

Earlier verification saw partially written versions of `EngineBadge.tsx` and `LiveMapPage.tsx`. The final builds were rerun after those edits settled, but the files themselves remain outside this commit.

## Pre-existing and unrelated work

Also protected but excluded:

- `NANI_ADVERSARIAL_TEST_REPORT.md`
- Pre-existing `FINAL_UI_*` reports outside the recovery set
- `UI_REVIEW_*` corpora
- Most `UI_MASTER_*` reports outside the three explicitly included design documents
- `NANI_AUDIT_*`, `N0_REVIEW_*`, `N1_REVIEW_*`, and `N1_2_REVIEW_*` corpora
- Unrelated screenshot directories
- `.tmp-desktop-dev.log`
- `.workbuddy-ai/`

## C3-held files

The six Rust files held in report 09 are also protected from inclusion. They were not modified by this mission and remain dirty for a separate authorized decision.

## Local release marker

The checked-in `package.json` still contains:

```json
"netpulse": {
  "releaseFeed": "local"
}
```

It was not removed. The release script clears it only during an explicit release run with a real repository slug.

## Protection conclusion

The final commit plan touches only audit-authored, reviewed files. No external UI work, local operational state, or C3 math work is included. This satisfies the user’s instruction that a smaller correct commit is preferred over a larger risky one.
