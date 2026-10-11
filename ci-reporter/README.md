# Red-main macOS CI reporter

This composite action tracks failures of the macOS jobs in `zajca/pohunek`'s
`.github/workflows/ci.yml`. It receives the caller run ID, fetches the run and
its jobs from the Actions API, verifies that the run came from the trusted
repository's main `push` or `schedule` and the expected workflow, then creates or updates
one issue per failing macOS job. A later green run comments on and closes that
job's open incident. Job labels provide stable deduplication across deliveries.

The action's tracked job names mirror core CI. Update `src/config.ts` and its
fixtures when a macOS job is renamed or added. The package-install matrix is
tracked per runner, including the informational `macos-14` leg.

## Caller permissions

Call the action from the final job of core `ci.yml`, which runs on main pushes
and the weekly schedule. The caller's `GITHUB_TOKEN` must have only this write
permission:

```yaml
permissions:
  issues: write
```

The action reads public Actions run data without authentication. The writer
token is used only for issue and label endpoints, so it does not need
`actions:read`. Pin the action to the reviewed commit SHA when wiring it into
core CI:

```yaml
  red-main-report:
    needs: [platform-contracts, macos-package, hermes-compatibility-macos, sdk-macos]
    if: ${{ always() && (github.event_name == 'schedule' || (github.event_name == 'push' && github.ref == 'refs/heads/main')) }}
    runs-on: ubuntu-latest
    permissions:
      issues: write
    steps:
      - uses: zajca/pohunek-work/ci-reporter@<reviewed-commit-sha>
        with:
          run-id: ${{ github.run_id }}
          repository: ${{ github.repository }}
```

The job ID must remain `red-main-report` with no custom display name so it
matches the Actions API job name. The action reads that ID from the runner's
current GitHub context. The run identity and repository from the caller are
only lookup keys. The action independently queries GitHub and
refuses any run that does not match the expected repository,
workflow path, `push` or `schedule` event, main branch, commit SHA, and that the
run ID/repository match the current caller context. The final caller job must
be named `red-main-report`, depend on all macOS jobs, and use `if: always()`.
While that job runs, GitHub reports its overall run as `in_progress`; the action
accepts that state only when the matching reporter job itself is in progress
and every tracked macOS job has a terminal conclusion. For a completed run,
the matching reporter job must also be completed. No reporter secret is needed
beyond the caller's scoped `GITHUB_TOKEN`.

Pass `dry-run: "true"` to inspect the proposed changes. Dry-run still performs
the read-only provenance, job, issue, and history queries, and makes no API
write request.

## Commit range and incident ordering

Each issue includes failed step names, the Actions run link, and the compare
range from the latest earlier successful `main` run of that same job. If no
earlier green run exists, the issue says so explicitly. The latest observed run
number and attempt are stored in an HTML comment in the issue body. Duplicate
deliveries are ignored, and a green run older than the issue's recorded failure
cannot close it.

The reporter is deliberately outside `zajca/pohunek`; it contains GitHub issue
provider behavior only in this client repository.
