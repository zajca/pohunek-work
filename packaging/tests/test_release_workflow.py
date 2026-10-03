"""Static checks of the release workflow's trust boundaries (stdlib only).

`actionlint` validates the syntax and the shell steps in CI; these tests pin the
properties that make the release safe: no job holds a secret, only `publish`
holds a write token, only `attest` holds the OIDC scopes and it runs no
repository or downloaded code, the signing job runs no program from the staged
tree, and the CI gate is one reusable workflow.
"""

from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"
RELEASE = (WORKFLOWS / "release.yml").read_text()
CI = (WORKFLOWS / "ci.yml").read_text()

PINNED = re.compile(r"@[0-9a-f]{40}$")

ATTEST_JOB = "attest"
# The only actions the attest job may use, pinned to exact commits.
ATTEST_ALLOWED_ACTIONS = {
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
}
# The only `run:` script of the attest job as normalized lines (stripped,
# without blank and comment lines): it checks the downloaded checksums and
# executes nothing downloaded.
ATTEST_ALLOWED_SCRIPTS = {
    (
        "set -euo pipefail",
        'cd "$RUNNER_TEMP/attest-assets"',
        "sha256sum -c ./*.sha256",
        'test "$(ls ./*.tar.gz | wc -l)" = "$(ls ./*.sha256 | wc -l)"',
    ),
}
# A plain scalar value: its first character may not open a flow collection, an
# anchor, an alias, a tag, a block scalar, or a quoted string.
_SCALAR = r"[^\s{}\[\]&*!|>'\"%@`][^\n]*"
ATTEST_JOB_LINES = [
    re.compile(pattern)
    for pattern in (
        rf"    (name|runs-on|timeout-minutes): {_SCALAR}",
        r"    needs: \[[a-z0-9, -]+\]",
        r"    if: \$\{\{ github\.event_name == 'push' && github\.ref_type == 'tag' \}\}",
        r"    (permissions|steps):",
        r"      contents: read",
        r"      id-token: write",
        r"      attestations: write",
        rf"      - name: {_SCALAR}",
        r"        uses: [a-z0-9_.-]+/[a-z0-9_.-]+@[0-9a-f]{40}( # v[0-9.]+)?",
        r"        with:",
        rf"          (name|path|pattern): {_SCALAR}",
        r"          merge-multiple: true",
        r"          subject-path: \|",
        r"            \$\{\{ runner\.temp \}\}/[a-z-]+/[A-Za-z0-9_.*-]+",
        r"        shell: bash",
        r"        run: \|",
        r"\s*#[^\n]*",
    )
]
OIDC_SCOPE = re.compile(r"^\s*['\"]?(id-token|attestations)['\"]?\s*:", re.M)
RUN = re.compile(r"^(\s+)(?:- )?run:\s*(.*)$")


def run_scripts(block):
    """Every `run:` script of a job as normalized lines."""
    lines = block.splitlines()
    scripts = []
    for index, line in enumerate(lines):
        match = RUN.match(line)
        if match is None:
            continue
        indent, inline = match.groups()
        body = [] if inline in ("|", ">", "|-", ">-") else [inline]
        if not body:
            for following in lines[index + 1 :]:
                if following.strip() and len(following) - len(following.lstrip()) <= len(indent):
                    break
                body.append(following)
        scripts.append(
            tuple(s for s in (raw.strip() for raw in body) if s and not s.startswith("#"))
        )
    return scripts


def lines_outside_run_bodies(block):
    kept = []
    body_indent = None
    for line in block.splitlines():
        indent = len(line) - len(line.lstrip())
        if body_indent is not None:
            if not line.strip() or indent > body_indent:
                continue
            body_indent = None
        kept.append(line)
        if re.fullmatch(r"\s+run: \|", line):
            body_indent = indent
    return kept


def attest_job_violations(name, block):
    """Everything the attest job does beyond downloading, checking and attesting.

    Fails closed: every line outside run bodies matches a canonical shape, every
    action is allowlisted (so no checkout), every script is the checksum check.
    """
    violations = []
    for line in lines_outside_run_bodies(block):
        if line.strip() and not any(shape.fullmatch(line) for shape in ATTEST_JOB_LINES):
            violations.append(f"{name} has a line outside the canonical shapes: {line!r}")
    for action in re.findall(r"^\s+(?:- )?uses:\s*(\S+)", block, re.M):
        if action not in ATTEST_ALLOWED_ACTIONS:
            violations.append(f"{name} uses {action} with an OIDC token")
    for script in run_scripts(block):
        if script not in ATTEST_ALLOWED_SCRIPTS:
            violations.append(f"{name} runs a script outside the allowlist: {script!r}")
    return violations


def oidc_violations(release_jobs):
    """The OIDC scopes belong to the attest job alone."""
    return [name for name, job in release_jobs.items() if name != ATTEST_JOB and OIDC_SCOPE.search(job)]


def jobs(text):
    """Maps each job name to its text (jobs sit at two-space indentation)."""
    body = text.split("\njobs:\n", 1)[1]
    parts = re.split(r"\n  ([a-z][a-z0-9-]*):\n", "\n" + body)
    return dict(zip(parts[1::2], parts[2::2]))


RELEASE_JOBS = jobs(RELEASE)


class ReleaseTriggerTest(unittest.TestCase):
    def test_a_version_tag_triggers_the_release_and_a_manual_run_never_publishes(self):
        header = RELEASE.split("\njobs:\n", 1)[0]
        self.assertIn('- "v[0-9]+.[0-9]+.[0-9]+"', header)
        self.assertIn("workflow_dispatch:", header)
        publish = RELEASE_JOBS["publish"]
        self.assertIn("github.event_name == 'push'", publish)
        self.assertIn("github.ref_type == 'tag'", publish)

    def test_the_tag_name_is_read_only_by_the_prepare_job(self):
        for name, job in RELEASE_JOBS.items():
            if name != "prepare":
                self.assertNotIn("ref_name", job, name)
                self.assertNotIn("GITHUB_REF_NAME", job, name)
                self.assertNotIn("inputs.version", job, name)
        self.assertNotIn("GITHUB_REF_NAME", RELEASE)

    def test_the_ci_gate_is_the_reusable_ci_workflow_and_gates_every_build(self):
        ci = RELEASE_JOBS["ci"]
        self.assertIn("uses: ./.github/workflows/ci.yml", ci)
        self.assertIn("pull-requests: read", ci)
        for name in ("build-gui-linux", "package-web", "package-launchers", "stage-macos"):
            self.assertRegex(RELEASE_JOBS[name], r"needs: \[prepare, ci\]", name)
        self.assertIn("workflow_call:", CI.split("\njobs:\n", 1)[0])
        self.assertIn("ci:\n    if: ${{ always() }}", CI)
        self.assertRegex(CI, r"needs: \[changes, plugin, launchers, native, native-macos, web, web-macos, packaging, macos-package\]")

    def test_the_release_and_ci_concurrency_groups_cannot_collide(self):
        self.assertIn("group: release-${{ github.ref }}", RELEASE)
        self.assertIn("group: ci-${{ github.workflow }}-${{ github.ref }}", CI)

    def test_every_archive_records_the_core_pin_and_is_checked_before_upload(self):
        for name in ("build-gui-linux", "package-web", "package-launchers"):
            job = RELEASE_JOBS[name]
            self.assertIn("POHUNEK_CORE_REF: ${{ needs.prepare.outputs.core_ref }}", job, name)
            self.assertIn("packaging/check-archive", job, name)
        self.assertIn("packaging/core-pin --require-web --expect-version", RELEASE_JOBS["prepare"])
        self.assertIn("pipefail", RELEASE_JOBS["prepare"].split("Resolve the core pin", 1)[1])


class MacosPackagingTest(unittest.TestCase):
    def setUp(self):
        self.stage = RELEASE_JOBS["stage-macos"]
        self.package = RELEASE_JOBS["package-macos"]
        self.verify = RELEASE_JOBS["verify-macos"]

    def test_no_job_uses_a_secret_an_environment_or_a_repository_variable(self):
        for name, job in RELEASE_JOBS.items():
            if name == "ci":
                continue
            for forbidden in ("secrets.", "environment:", "vars."):
                self.assertNotIn(forbidden, job, f"{name}: {forbidden}")
        for forbidden in ("secrets.", "environment:", "vars."):
            self.assertNotIn(forbidden, RELEASE)

    def test_no_credential_or_opt_out_name_remains(self):
        for retired in (
            "macos-signing",
            "MACOS_CERTIFICATE",
            "APPLE_NOTARY",
            "MACOS_TEAM_ID",
            "RELEASE_WITHOUT_MACOS",
            "skip_macos_signing",
            "signing-keychain",
            "sign-macos",
            "developer-id",
            "--notarized",
            "--team-id",
            "--sign-release",
        ):
            self.assertNotIn(retired, RELEASE, retired)

    def test_the_macos_archives_are_always_built(self):
        for name in ("stage-macos", "package-macos", "verify-macos"):
            self.assertNotRegex(RELEASE_JOBS[name], r"(?m)^    if:", name)

    def test_the_packaging_job_runs_nothing_from_the_tree_and_uses_pinned_actions(self):
        for use in re.findall(r"uses: (\S+)", self.package):
            self.assertRegex(use, PINNED, use)
        for forbidden in ("--stage-release", "cargo", "bun ", "--version", "smoke", "stage-archive", "setup-"):
            self.assertNotIn(forbidden, self.package, forbidden)
        self.assertIn("needs: [prepare, stage-macos]", self.package)
        self.assertIn("packaging/macos/package --adhoc-release", self.package)
        self.assertIn("contents: read", self.package)
        self.assertNotIn("contents: write", self.package)

    def test_every_action_that_shapes_the_signed_bytes_is_pinned(self):
        for name in ("stage-macos", "package-macos", "verify-macos", "attest", "publish"):
            for use in re.findall(r"uses: (\S+)", RELEASE_JOBS[name]):
                self.assertRegex(use, PINNED, "%s: %s" % (name, use))

    def test_the_staged_tree_travels_as_a_checked_tar_and_no_artifact_value_reaches_a_script(self):
        self.assertIn("shasum -a 256 -c stage.tar.sha256", self.package)
        self.assertIn("packaging/macos/package --stage-release", self.stage)
        self.assertNotIn("--adhoc-release", self.stage)
        self.assertNotIn("--stage-release", self.package)
        self.assertNotIn("--development", RELEASE)
        self.assertIn("entries outside", self.package)
        self.assertIn("parent-directory component", self.package)
        for job in (self.package, self.verify):
            self.assertNotIn("steps.stage.outputs", job)

    def test_the_verify_job_checks_the_signed_bytes_and_cannot_write(self):
        self.assertIn("packaging/macos/verify-signed --adhoc", self.verify)
        self.assertIn("--signing adhoc", self.verify)
        self.assertIn("grep -q '^signing adhoc$'", self.verify)
        self.assertIn("RUNNER_TEMP/extracted", self.verify)
        self.assertIn("contents: read", self.verify)
        self.assertNotIn("contents: write", self.verify)
        self.assertIn("needs: [prepare, package-macos]", self.verify)

    def test_the_header_describes_the_adhoc_and_attestation_model(self):
        header = RELEASE.split("\njobs:\n", 1)[0]
        self.assertIn("ad-hoc", header)
        self.assertIn("attest", header)
        self.assertNotIn("notariz", header.lower())


class AttestTest(unittest.TestCase):
    def setUp(self):
        self.attest = RELEASE_JOBS[ATTEST_JOB]

    def test_only_the_attest_job_holds_the_oidc_scopes_in_one_spelling(self):
        self.assertEqual(oidc_violations(RELEASE_JOBS), [])
        self.assertRegex(
            self.attest,
            r"(?m)^    permissions:\n      contents: read\n      id-token: write\n      attestations: write\n",
        )
        self.assertNotIn("contents: write", self.attest)
        header = RELEASE.split("\njobs:\n", 1)[0]
        self.assertRegex(header, r"(?m)^permissions:\n  contents: read$")
        self.assertIsNone(OIDC_SCOPE.search(header))

    def test_the_attest_job_stays_inside_its_allowlist(self):
        self.assertEqual(attest_job_violations(ATTEST_JOB, self.attest), [])

    def test_the_attest_job_checks_out_nothing(self):
        self.assertNotIn("actions/checkout", self.attest)
        self.assertNotIn("persist-credentials", self.attest)

    def test_the_attest_job_attests_every_archive_and_checksum(self):
        for glob in ("*.tar.gz", "*.sha256"):
            self.assertIn("${{ runner.temp }}/attest-assets/" + glob, self.attest)
        self.assertIn("actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6", self.attest)

    def test_the_attest_job_waits_for_every_archive_and_runs_on_tag_pushes_only(self):
        needs = re.search(r"(?m)^    needs: \[([^\]]*)\]$", self.attest).group(1)
        self.assertEqual(
            sorted(item.strip() for item in needs.split(",")),
            sorted(["build-gui-linux", "package-web", "package-launchers", "verify-macos"]),
        )
        self.assertIn("github.event_name == 'push' && github.ref_type == 'tag'", self.attest)

    def test_an_oidc_scope_on_any_other_job_is_rejected(self):
        jobs_with_scope = dict(RELEASE_JOBS)
        jobs_with_scope["publish"] = RELEASE_JOBS["publish"].replace(
            "      contents: write\n", "      contents: write\n      id-token: write\n", 1
        )
        self.assertEqual(oidc_violations(jobs_with_scope), ["publish"])

    def test_a_checkout_in_the_attest_job_is_rejected(self):
        tampered = self.attest.replace(
            "    steps:\n",
            "    steps:\n      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0\n",
            1,
        )
        self.assertNotEqual(attest_job_violations(ATTEST_JOB, tampered), [])

    def test_an_unlisted_action_or_script_in_the_attest_job_is_rejected(self):
        action = self.attest.replace(
            "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
            "actions/attest@0000000000000000000000000000000000000000",
        )
        self.assertNotEqual(attest_job_violations(ATTEST_JOB, action), [])
        script = self.attest.replace(
            "sha256sum -c ./*.sha256\n", "sha256sum -c ./*.sha256\n          ./*.tar.gz\n", 1
        )
        self.assertNotEqual(attest_job_violations(ATTEST_JOB, script), [])
        piped = self.attest.replace("sha256sum -c ./*.sha256", "sha256sum -c ./*.sha256 | sh", 1)
        self.assertNotEqual(attest_job_violations(ATTEST_JOB, piped), [])

    def test_a_flow_style_or_extra_permission_line_in_the_attest_job_is_rejected(self):
        extra = self.attest.replace(
            "      attestations: write\n", "      attestations: write\n      packages: write\n", 1
        )
        self.assertNotEqual(attest_job_violations(ATTEST_JOB, extra), [])


class PublishTest(unittest.TestCase):
    def setUp(self):
        self.publish = RELEASE_JOBS["publish"]

    def test_only_the_publish_job_can_write_and_it_needs_every_archive_job_and_the_attestation(self):
        for name, job in RELEASE_JOBS.items():
            if name != "publish":
                self.assertNotIn("contents: write", job, name)
        self.assertIn("contents: write", self.publish)
        needs = re.search(r"(?m)^    needs: \[([^\]]*)\]$", self.publish).group(1)
        self.assertEqual(
            sorted(item.strip() for item in needs.split(",")),
            sorted(
                [
                    "prepare",
                    "build-gui-linux",
                    "package-web",
                    "package-launchers",
                    "verify-macos",
                    "attest",
                ]
            ),
        )

    def test_publishing_needs_every_job_to_have_succeeded(self):
        condition = self.publish.split("runs-on:", 1)[0]
        for result in (
            "prepare",
            "build-gui-linux",
            "package-web",
            "package-launchers",
            "verify-macos",
            "attest",
        ):
            self.assertIn(f"needs.{result}.result == 'success'", condition, result)
        self.assertNotIn("skipped", condition)
        self.assertNotIn("vars.", condition)

    def test_the_publish_job_runs_nothing_from_an_archive(self):
        for forbidden in ("tar -x", "smoke", "cargo", "bun ", "verify-signed", "install.sh"):
            self.assertNotIn(forbidden, self.publish, forbidden)

    def test_the_asset_set_always_holds_the_macos_archives_and_is_checked_around_publishing(self):
        for asset in (
            "pohunek-gui-${VERSION}-x86_64-unknown-linux-gnu.tar.gz",
            "pohunek-web-${VERSION}-linux-x86_64.tar.gz",
            "pohunek-launchers-${VERSION}-noarch.tar.gz",
            "pohunek-gui-${VERSION}-aarch64-apple-darwin.tar.gz:gui:aarch64-apple-darwin:adhoc",
            "pohunek-web-${VERSION}-aarch64-apple-darwin.tar.gz:web:aarch64-apple-darwin:adhoc",
        ):
            self.assertIn(asset, self.publish)
        self.assertNotIn("expected+=", self.publish)
        self.assertNotRegex(self.publish, r"(?m)^\s+if \[ .*macos", "the macOS archives are not optional")
        self.assertIn("the downloaded assets differ from the expected set", self.publish)
        self.assertIn("fail_on_unmatched_files: true", self.publish)
        after = self.publish.split("Verify the published assets", 1)[1]
        self.assertIn("gh release download", after)
        self.assertIn("sha256sum -c", after)
        self.assertIn("cmp ", after)

    def test_the_release_notes_point_at_the_attestation_check(self):
        self.assertIn("gh attestation verify", self.publish)


class CiFilterTest(unittest.TestCase):
    def test_the_packaging_job_and_filter_cover_the_shared_paths(self):
        block = CI.split("            packaging:\n", 1)[1].split("\n\n", 1)[0]
        for path in (
            "packaging/**",
            "native/packaging/**",
            "web/packaging/**",
            "native/scripts/**",
            "web/release/**",
            ".github/workflows/**",
        ):
            self.assertIn("- '%s'" % path, block)
        native = CI.split("            native:\n", 1)[1].split("            packaging:\n", 1)[0]
        self.assertIn("- 'packaging/**'", native)
        self.assertIn("packaging: ${{ steps.filter.outputs.packaging }}", CI)

    def test_the_macos_package_job_signs_for_real_and_verifies_adhoc(self):
        job = jobs(CI)["macos-package"]
        block = CI.split("            macos_package:\n", 1)[1].split("\n\n", 1)[0]
        for path in ("packaging/**", "native/packaging/**", "web/packaging/**", "web/release/**"):
            self.assertIn("- '%s'" % path, block)
        self.assertIn("macos_package: ${{ steps.filter.outputs.macos_package }}", CI)
        self.assertIn("needs.changes.outputs.macos_package == 'true'", job)
        self.assertIn("runs-on: macos-15", job)
        self.assertIn("component: [gui, web]", job)
        self.assertIn("packaging/macos/package --adhoc-release", job)
        self.assertIn("packaging/macos/verify-signed --adhoc", job)
        self.assertIn("--signing adhoc", job)
        for forbidden in ("secrets.", "environment:", "vars.", "notariz"):
            self.assertNotIn(forbidden, job)

    def test_the_web_filter_covers_the_web_folder_and_the_shared_packaging(self):
        block = CI.split("            web:\n", 1)[1].split("            packaging:\n", 1)[0]
        for path in ("web/**", "packaging/**", ".github/workflows/ci.yml"):
            self.assertIn("- '%s'" % path, block)
        self.assertIn("web: ${{ steps.filter.outputs.web }}", CI)
        for name in ("web", "web-macos"):
            self.assertIn("needs.changes.outputs.web == 'true'", jobs(CI)[name], name)

    def test_pull_requests_are_still_filtered_and_other_events_run_everything(self):
        for name in ("plugin", "launchers", "native", "native-macos", "web", "web-macos", "packaging", "macos-package"):
            job = jobs(CI)[name]
            self.assertIn("github.event_name != 'pull_request' ||", job, name)
        changes = jobs(CI)["changes"]
        self.assertEqual(changes.count("if: ${{ github.event_name == 'pull_request' }}"), 2)


if __name__ == "__main__":
    unittest.main()
