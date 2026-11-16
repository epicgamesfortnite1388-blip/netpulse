# W0-1 Backup and Restoration

## Backup creation

| Property | Value |
|---|---|
| Location | `E:\Code\Project\Vpn_app-W0-1-backup-20261116T2112\` (outside the repository) |
| Archive | `backup.tar.gz` (8,737,332 bytes) |
| Contents | 317 files: 39 tracked-modified + 278 untracked (all source, tests, config, docs, text reports; PNG binaries included; explicitly NOT `.data/`, `certs/`, ignored dist dirs) |
| Metadata | `BACKUP_INFO.txt` (repo root, branch `main`, HEAD `b0311fb…`, timestamp, file count) + copy of `W0_1_SHA256_MANIFEST.txt` |
| Overwrite protection | pre-checked existing backup; none overwritten |
| Created | 2026-11-16 21:52, tar exit 0 |

## Secrets policy (mission §2/§4)

`.data/` (daemon token, sqlite runtime DB) and `certs/` (signing keys) were deliberately **not copied** into the backup: duplicating a live daemon token and private keys to a second on-machine location without a protected destination would create new exposure. They are preserved in place, untouched, and remain gitignored. Backing them up requires the user's explicit authorization + protected destination. **This is recorded here; nothing was silently discarded.**

## Restoration verification (twice)

1. **Working-tree restoration test**: extracted `backup.tar.gz` into `C:\Users\RADIN\AppData\Local\Temp\W0-1-restore-test\` (separate location) → `sha256sum -c` against the manifest → **317/317 OK, 0 mismatches** (exit 0 on extract).
2. **Post-commit re-check**: identical verification re-run after the recovery commit → **317/317 OK** (backup undamaged by subsequent work).

Per the mission standard: verification is hash-based extraction, not "exit code zero" from the archive command.

## Restore procedure (for future recovery)

```
tar xzf /e/Code/Project/Vpn_app-W0-1-backup-20261116T2112/backup.tar.gz -C <target>
cd <target> && sha256sum -c <manifest>   # must print 317 OK, 0 failed
```

Target must be an empty directory. Files restore with original relative paths from the repo root.

## Addendum — post-backup deltas (2026-11-16, commit `1fc8875`)

This backup is an immutable point-in-time snapshot (HEAD `b0311fb`, 21:52). It is **not** overwritten. Two coherent in-flight deltas post-dated it: the release-profile ranking measurements in `reports/NANI_PERFORMANCE.md`, and removal of the temporary `tmp_rank_speedup_measurement` harness from `diagnosis.rs`. Per mission §3 ("do not overwrite an existing backup"), these were preserved durably via commit `1fc8875` rather than by re-archiving. The live worktree therefore diverges from the manifest in four files (2 registry + `NANI_PERFORMANCE.md` + `diagnosis.rs`), all committed to Git. Extraction re-verification of the untouched archive still yields **317/317 OK** (performed this session into `E:\Code\Project\Vpn_app-W0-1-restore-20261116T215455`).
