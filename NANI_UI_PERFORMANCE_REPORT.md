# NANI UI Performance Report

## Measures taken
- Lazy-loaded route (`React.lazy`) so NANI code splits.
- TanStack Query with 15s staleTime; manual refresh only.
- Reasoning trace types at 16ms/char with cleanup on unmount.
- Event feed bounded to last 25 entries.
- No high-frequency polling; no unbounded histories in new code.

## Not measured
- React render counts / profiler numbers (not run).
- Bundle size delta (not measured).
