# Red-main macOS CI reporter

This composite action tracks failures of the macOS jobs in `zajca/pohunek`'s
`.github/workflows/ci.yml`. It has two modes so the Actions reader and issue
writer receive separate least-privilege workflow tokens. `collect` verifies the
run and its jobs, then produces a bounded sanitized snapshot. `report` consumes
that snapshot and creates or updates one issue per failing macOS job. A later
green run comments on and closes the incident. Job labels provide stable
deduplication across deliveries.

The action's tracked job names mirror core CI. Update `src/config.ts` and its
fixtures when a macOS job is renamed or added. The package-install matrix is
tracked per runner, including the informational `macos-14` leg.

## Caller permissions

The core caller must use a read-only collection job followed by the final
writer job. The collection job's token has only `actions: read`:

```yaml
permissions:
  actions: read
```

The final reporter job's token has only `issues: write`. It does not receive or
use an Actions-read token:

```yaml
  red-main-read:
    needs: [platform-contracts, macos-package, hermes-compatibility-macos, sdk-macos]
    if: ${{ always() && (github.event_name == 'schedule' || (github.event_name == 'push' && github.ref == 'refs/heads/main')) }}
    runs-on: ubuntu-latest
    outputs:
      snapshot: ${{ steps.collect.outputs.snapshot }}
    permissions:
      actions: read
    steps:
      - uses: zajca/pohunek-work/ci-reporter@<reviewed-commit-sha>
        id: collect
        with:
          mode: collect
          run-id: ${{ github.run_id }}
          repository: ${{ github.repository }}
  red-main-report:
    needs: [red-main-read]
    if: ${{ always() && needs.red-main-read.result == 'success' }}
    runs-on: ubuntu-latest
    concurrency:
      group: red-main-report-${{ github.repository }}
      cancel-in-progress: false
    permissions:
      issues: write
    steps:
      - uses: zajca/pohunek-work/ci-reporter@<reviewed-commit-sha>
        with:
          mode: report
          run-id: ${{ github.run_id }}
          repository: ${{ github.repository }}
          snapshot: ${{ needs.red-main-read.outputs.snapshot }}
```

The job IDs must remain `red-main-read` and `red-main-report`, with no custom
display names, so the collector can verify its current Actions job. The read
job depends on every tracked macOS job and passes only the sanitized snapshot to
the writer job. While the jobs run, GitHub reports the overall run as
`in_progress`; the collector accepts it only when its own job is running and
every required tracked macOS job is terminal. The final reporter job has a
repository-wide concurrency group with `cancel-in-progress: false`. This is a
required cross-run serialization boundary: it protects issue lookup/create,
update, and close ordering across independent runners. Do not rely on an
in-process mutex. The workflow-level CI concurrency group should also remain
serialized for main runs.

The reader scans at most the latest 50 trusted completed main CI runs and
requests each run's jobs at most once. It fails closed for a red or green
mutation when the newest per-job outcome cannot be established: an unavailable
run list, an unreadable newer run, or a current run older than the 50-run window
marks that job uncertain and the writer skips it. Failure to read only older
history or the compare endpoint affects commit-range enrichment alone, so a
verified incident still gets reported with an explicit unavailable range. The
snapshot is limited to 64 KiB and contains only run provenance,
tracked job outcomes/failed steps, bounded history outcomes, and optional
compare links. No external secret is required; each job uses its own scoped
standard GitHub token.

Pass `dry-run: "true"` to inspect the proposed changes. Dry-run still performs
the read-only provenance, job, issue, and history queries, and makes no API
write request.

## Commit range and incident ordering

Each issue includes failed step names, the Actions run link, and the compare
range from the latest earlier successful `main` run of that same job. If history
or compare enrichment is unavailable, incident reporting continues and says no
previous green range is available. The latest observed run number, attempt, and
outcome are stored in an HTML comment in the issue body, including after close.
Later failures reopen the same labeled issue. A bounded history check rejects
older failures delivered after a newer green run, even when the green run
arrived before any issue existed. Duplicate deliveries are ignored, and stale
green runs cannot close a newer incident. These checks also protect delayed
snapshots: the writer compares each event with the issue's persisted run and
outcome marker. The official caller must keep the exact repository-wide writer
group `red-main-report-${{ github.repository }}` with
`cancel-in-progress: false`; this serializes issue mutations across runs, while
the action itself does not provide a distributed lock. The CI workflow's
workflow-level main-run concurrency must remain enabled as well.

To retain ordering after a green run ages out of the 50-run history window, the
writer keeps one closed issue per tracked job with the `red-main-watermark`
label and that job's stable label. It creates this record even if the job has
never had an incident. These closed issues are reporter state: do not delete
them or edit their ordering marker, or a delayed older failure could be
reported as current. The repository-wide writer concurrency above serializes
watermark creation and updates as well as incident mutations.

The reporter is deliberately outside `zajca/pohunek`; it contains GitHub issue
provider behavior only in this client repository.
