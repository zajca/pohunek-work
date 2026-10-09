"""Static checks of the release workflow's trust boundaries (stdlib only).

`actionlint` validates the syntax and the shell steps in CI; these tests pin the
properties that make the release safe: a tag selects exactly one surface and
no other surface's job runs, no job holds a secret, only `publish` holds a write
token, only `attest` holds the OIDC scopes and it runs no repository or
downloaded code, the signing job runs no program from the staged tree, and the
CI gate is one reusable workflow.
"""

from pathlib import Path
import os
import re
import subprocess
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
        "test \"$(find . -maxdepth 1 -name '*.tar.gz' | wc -l)\" = \"$(find . -maxdepth 1 -name '*.sha256' | wc -l)\"",
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
        r"    if: >-",
        r"      \$\{\{ !cancelled\(\) && github\.event_name == 'push' && github\.ref_type == 'tag'",
        r"      && needs\.gate\.result == 'success' \}\}",
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

SURFACES = ("web", "launchers", "plugin")
# The jobs that exist per surface; `verify-macos` stands for the whole macOS
# chain (stage, package, verify) for web.
SURFACE_JOBS = {
    "web": ("package-web", "verify-macos"),
    "launchers": ("package-launchers",),
    "plugin": ("package-plugin",),
}
BUILD_JOBS = ("package-web", "package-launchers", "package-plugin", "verify-macos")
# The release assets of each surface: archive name, component, target, signing.
SURFACE_ASSETS = {
    "web": (
        "pohunek-web-${VERSION}-linux-x86_64.tar.gz:web:x86_64-unknown-linux-gnu:none",
        "pohunek-web-${VERSION}-aarch64-apple-darwin.tar.gz:web:aarch64-apple-darwin:adhoc",
    ),
    "launchers": ("pohunek-launchers-${VERSION}-noarch.tar.gz:launchers:noarch:none",),
    "plugin": ("pohunek-work-plugin-${VERSION}-noarch.tar.gz:plugin:noarch:none",),
}


def needs_of(block):
    match = re.search(r"(?m)^    needs: \[([^\]]*)\]$", block)
    return sorted(item.strip() for item in match.group(1).split(","))


def run_gate(surface, results):
    """Runs the gate job's script with the given job results; True when it passes."""
    script = "\n".join(run_scripts(RELEASE_JOBS["gate"])[0])
    env = {
        "PATH": os.environ["PATH"],
        "SURFACE": surface,
        "WEB_LINUX": results.get("package-web", "skipped"),
        "LAUNCHERS": results.get("package-launchers", "skipped"),
        "PLUGIN": results.get("package-plugin", "skipped"),
        "MACOS": results.get("verify-macos", "skipped"),
    }
    done = subprocess.run(["bash", "-c", script], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return done.returncode == 0


class ReleaseTriggerTest(unittest.TestCase):
    def test_a_surface_tag_triggers_the_release_and_a_manual_run_never_publishes(self):
        header = RELEASE.split("\njobs:\n", 1)[0]
        tags = re.findall(r'(?m)^      - "([^"]+)"$', header.split("workflow_dispatch:", 1)[0])
        self.assertEqual(tags, [f"{surface}-v[0-9]+.[0-9]+.[0-9]+" for surface in SURFACES])
        self.assertNotIn('- "v[0-9]+', header)
        dispatch = header.split("workflow_dispatch:", 1)[1]
        self.assertRegex(dispatch, r"surface:\n(?:.*\n)*?        type: choice\n        options:\n          - web\n          - launchers\n          - plugin\n")
        self.assertIn("      version:\n", dispatch)
        publish = RELEASE_JOBS["publish"]
        self.assertIn("github.event_name == 'push'", publish)
        self.assertIn("github.ref_type == 'tag'", publish)

    def test_the_tag_name_is_read_only_by_the_prepare_job(self):
        for name, job in RELEASE_JOBS.items():
            if name != "prepare":
                self.assertNotIn("ref_name", job, name)
                self.assertNotIn("GITHUB_REF_NAME", job, name)
                self.assertNotIn("inputs.version", job, name)
                self.assertNotIn("inputs.surface", job, name)
        self.assertNotIn("GITHUB_REF_NAME", RELEASE)

    def test_the_ci_gate_is_the_reusable_ci_workflow_and_gates_every_build(self):
        ci = RELEASE_JOBS["ci"]
        self.assertIn("uses: ./.github/workflows/ci.yml", ci)
        self.assertIn("pull-requests: read", ci)
        self.assertIn("needs: [prepare]", ci)
        self.assertIn("surface: ${{ needs.prepare.outputs.surface }}", ci)
        for name in ("package-web", "package-launchers", "package-plugin", "stage-macos"):
            self.assertRegex(RELEASE_JOBS[name], r"needs: \[prepare, ci\]", name)
        self.assertRegex(CI.split("\njobs:\n", 1)[0], r"workflow_call:\n    inputs:\n      surface:\n")
        self.assertIn("ci:\n    if: ${{ always() }}", CI)
        self.assertRegex(CI, r"needs: \[changes, plugin, launchers, web, web-macos, packaging, macos-package\]")

    def test_the_release_and_ci_concurrency_groups_cannot_collide(self):
        self.assertIn("group: release-${{ github.ref }}-${{ inputs.surface }}", RELEASE)
        self.assertIn("group: ci-${{ github.workflow }}-${{ github.ref }}", CI)

    def test_every_archive_records_the_core_pin_and_is_checked_before_upload(self):
        for name in ("package-web", "package-launchers", "package-plugin"):
            job = RELEASE_JOBS[name]
            self.assertIn("POHUNEK_CORE_REF: ${{ needs.prepare.outputs.core_ref }}", job, name)
            self.assertIn("packaging/check-archive", job, name)
        prepare = RELEASE_JOBS["prepare"]
        self.assertIn("packaging/core-pin", prepare)
        self.assertIn("pipefail", prepare.split("Resolve the core pin", 1)[1])
        self.assertIn('packaging/resolve-release --tag="$REF_NAME"', prepare)
        self.assertIn('packaging/resolve-release --surface="$INPUT_SURFACE" --version="$INPUT_VERSION"', prepare)


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

    def test_the_macos_archives_are_built_for_web_only(self):
        condition = "    if: ${{ needs.prepare.outputs.surface == 'web' }}\n"
        for name in ("stage-macos", "package-macos", "verify-macos"):
            job = RELEASE_JOBS[name]
            self.assertIn(condition, job, name)
            self.assertEqual(len(re.findall(r"(?m)^    if:", job)), 1, name)
            self.assertIn("      COMPONENT: web\n", job, name)
            self.assertNotIn("matrix:", job, name)

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

    def test_the_attest_job_waits_for_the_gate_and_runs_on_tag_pushes_only(self):
        self.assertEqual(needs_of(self.attest), ["gate"])
        self.assertIn("github.event_name == 'push' && github.ref_type == 'tag'", self.attest)

    def test_the_attest_job_runs_although_the_other_surfaces_jobs_were_skipped(self):
        # Without a status function the implicit success() also requires every
        # transitive predecessor to have run, and the jobs of the surfaces that
        # were not selected are skipped by design.
        self.assertIn("!cancelled()", self.attest)
        self.assertIn("needs.gate.result == 'success'", self.attest)

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

    def test_only_the_publish_job_can_write_and_it_needs_the_gate_and_the_attestation(self):
        for name, job in RELEASE_JOBS.items():
            if name != "publish":
                self.assertNotIn("contents: write", job, name)
        self.assertIn("contents: write", self.publish)
        self.assertEqual(needs_of(self.publish), ["attest", "gate", "prepare"])

    def test_publishing_needs_every_job_to_have_succeeded(self):
        condition = self.publish.split("runs-on:", 1)[0]
        for result in ("prepare", "gate", "attest"):
            self.assertIn(f"needs.{result}.result == 'success'", condition, result)
        self.assertNotIn("skipped", condition)
        self.assertNotIn("vars.", condition)

    def test_the_publish_job_runs_nothing_from_an_archive(self):
        for forbidden in ("tar -x", "smoke", "cargo", "bun ", "verify-signed", "install.sh"):
            self.assertNotIn(forbidden, self.publish, forbidden)

    def asset_arms(self):
        """Maps each surface to the expected asset entries of its `case` arm."""
        script = "\n".join(run_scripts(self.publish)[0])
        body = script.split('case "$SURFACE" in', 1)[1].split("esac", 1)[0]
        arms = dict(re.findall(r"(?s)(web|launchers|plugin)\)\n(.*?)\n;;", body))
        return {surface: tuple(re.findall(r'"([^"]+)"', arm)) for surface, arm in arms.items()}, body

    def test_the_asset_set_is_fixed_per_surface_and_checked_around_publishing(self):
        arms, body = self.asset_arms()
        self.assertEqual(arms, SURFACE_ASSETS)
        self.assertIn('echo "::error::unknown surface: $SURFACE"', body)
        self.assertNotIn("expected+=", self.publish)
        self.assertIn("the downloaded assets differ from the expected set", self.publish)
        self.assertIn("fail_on_unmatched_files: true", self.publish)
        after = self.publish.split("Verify the published assets", 1)[1]
        self.assertIn("gh release download", after)
        self.assertIn("sha256sum -c", after)
        self.assertIn("cmp ", after)

    def test_a_surface_release_holds_no_other_surfaces_archive(self):
        arms, _ = self.asset_arms()
        prefixes = {
            "web": "pohunek-web-",
            "launchers": "pohunek-launchers-",
            "plugin": "pohunek-work-plugin-",
        }
        for surface, entries in arms.items():
            self.assertTrue(entries, surface)
            for entry in entries:
                self.assertTrue(entry.startswith(prefixes[surface]), f"{surface}: {entry}")
                self.assertEqual(entry.split(":")[1], surface, entry)

    def test_the_release_is_named_by_the_surface_tag_from_prepare(self):
        self.assertIn("TAG: ${{ needs.prepare.outputs.tag }}", self.publish)
        self.assertIn("SURFACE: ${{ needs.prepare.outputs.surface }}", self.publish)
        self.assertIn('gh release download "$TAG"', self.publish)
        self.assertIn("gh release download ${TAG}", self.publish)
        self.assertNotIn("gh release download v", self.publish)

    def test_the_release_notes_point_at_the_attestation_check(self):
        self.assertIn("gh attestation verify", self.publish)


class SurfaceSelectionTest(unittest.TestCase):
    def test_prepare_exposes_the_surface_the_version_and_the_tag(self):
        prepare = RELEASE_JOBS["prepare"]
        for output in ("surface", "version", "tag"):
            self.assertIn(f"{output}: ${{{{ steps.release.outputs.{output} }}}}", prepare)

    def test_each_build_job_runs_for_its_surface_only(self):
        expected = {
            "package-web": "needs.prepare.outputs.surface == 'web'",
            "package-launchers": "needs.prepare.outputs.surface == 'launchers'",
            "package-plugin": "needs.prepare.outputs.surface == 'plugin'",
        }
        for name, condition in expected.items():
            self.assertIn(f"    if: ${{{{ {condition} }}}}\n", RELEASE_JOBS[name], name)

    def test_every_job_that_builds_waits_for_prepare_and_none_reads_the_tag(self):
        for name in ("package-web", "package-launchers", "package-plugin", "stage-macos"):
            self.assertEqual(needs_of(RELEASE_JOBS[name]), ["ci", "prepare"], name)

    def test_the_plugin_archive_is_built_from_the_repository_root_and_smoked_outside_the_checkout(self):
        job = RELEASE_JOBS["package-plugin"]
        self.assertIn('packaging/make-archive plugin "$VERSION" noarch . dist', job)
        self.assertIn("--component plugin", job)
        self.assertIn("mktemp -d", job)
        self.assertIn("bun plugin/src/main.ts", job)
        self.assertIn("name: release-plugin", job)
        self.assertIn("bun-version-file: plugin/package.json", job)
        for use in re.findall(r"uses: (\S+)", job):
            self.assertRegex(use, PINNED, use)

    def test_the_gate_needs_every_build_job_and_holds_no_token_beyond_read(self):
        gate = RELEASE_JOBS["gate"]
        self.assertEqual(needs_of(gate), sorted(("prepare",) + BUILD_JOBS))
        self.assertIn("if: ${{ !cancelled() && needs.prepare.result == 'success' }}", gate)
        self.assertRegex(gate, r"(?m)^    permissions:\n      contents: read\n")
        self.assertNotIn("actions/checkout", gate)
        self.assertNotIn("uses:", gate)

    def test_the_gate_passes_only_when_exactly_the_selected_surfaces_jobs_succeeded(self):
        for surface in SURFACES:
            selected = {name: "success" for name in SURFACE_JOBS[surface]}
            self.assertTrue(run_gate(surface, selected), surface)
            for job in SURFACE_JOBS[surface]:
                for result in ("failure", "cancelled", "skipped"):
                    self.assertFalse(run_gate(surface, dict(selected, **{job: result})), f"{surface} {job} {result}")
            for other in BUILD_JOBS:
                if other in selected:
                    continue
                for result in ("success", "failure"):
                    self.assertFalse(
                        run_gate(surface, dict(selected, **{other: result})),
                        f"a {surface} release must not run {other}",
                    )

    def test_the_gate_refuses_an_unknown_or_empty_surface(self):
        for surface in ("", "docs", "GUI", "gui web"):
            self.assertFalse(run_gate(surface, {"package-web": "success", "verify-macos": "success"}), repr(surface))

    def test_the_attest_and_publish_jobs_cannot_start_without_the_gate(self):
        self.assertEqual(needs_of(RELEASE_JOBS["attest"]), ["gate"])
        self.assertIn("needs.gate.result == 'success'", RELEASE_JOBS["publish"])


class CiFilterTest(unittest.TestCase):
    def test_the_packaging_job_and_filter_cover_the_shared_paths(self):
        block = CI.split("            packaging:\n", 1)[1].split("\n\n", 1)[0]
        for path in (
            "packaging/**",
            "web/core-sdk.json",
            "web/packaging/**",
            "web/release/**",
            ".github/workflows/**",
            "plugin/**",
            "launchers/**",
        ):
            self.assertIn("- '%s'" % path, block)
        self.assertIn("packaging: ${{ steps.filter.outputs.packaging }}", CI)

    def test_the_macos_package_job_signs_for_real_and_verifies_adhoc(self):
        job = jobs(CI)["macos-package"]
        block = CI.split("            macos_package:\n", 1)[1].split("\n\n", 1)[0]
        for path in ("packaging/**", "web/core-sdk.json", "web/packaging/**", "web/release/**"):
            self.assertIn("- '%s'" % path, block)
        self.assertIn("macos_package: ${{ steps.filter.outputs.macos_package }}", CI)
        self.assertIn("needs.changes.outputs.macos_package == 'true'", job)
        self.assertIn("runs-on: macos-15", job)
        self.assertIn("COMPONENT: web", job)
        self.assertNotIn("matrix:", job)
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

    def test_pull_requests_are_still_filtered_and_other_events_run_everything_or_the_released_surface(self):
        surfaces = {
            "plugin": ("plugin", "launchers"),
            "launchers": ("launchers", "plugin"),
            "web": ("web",),
            "web-macos": ("web",),
            "packaging": SURFACES,
            "macos-package": ("web",),
        }
        for name, released in surfaces.items():
            condition = re.search(r"(?m)^    if: (.*)$", jobs(CI)[name]).group(1)
            self.assertIn("github.event_name == 'pull_request' && needs.changes.outputs.", condition, name)
            self.assertIn("github.event_name != 'pull_request' && (inputs.surface == ''", condition, name)
            self.assertEqual(re.findall(r"inputs\.surface == '([a-z]+)'", condition), list(released), name)
        changes = jobs(CI)["changes"]
        self.assertEqual(changes.count("if: ${{ github.event_name == 'pull_request' }}"), 2)

    def test_no_surface_job_runs_for_a_release_of_another_surface(self):
        for surface in SURFACES:
            running = [
                name
                for name in ("plugin", "launchers", "web", "web-macos", "macos-package")
                if re.search(rf"inputs\.surface == '{surface}'", re.search(r"(?m)^    if: (.*)$", jobs(CI)[name]).group(1))
            ]
            others = {
                "web": {"web", "web-macos", "macos-package"},
                "launchers": {"launchers", "plugin"},
                "plugin": {"plugin", "launchers"},
            }
            self.assertEqual(set(running), others[surface], surface)

    def test_a_plugin_release_runs_the_launcher_checks_its_archive_embeds(self):
        condition = re.search(r"(?m)^    if: (.*)$", jobs(CI)["launchers"]).group(1)
        self.assertIn("inputs.surface == 'plugin'", condition)
        # The plugin imports the launcher scripts as text, so they ship in its archive.
        self.assertIn("../../../launchers/", (ROOT / "plugin" / "src" / "setup" / "assets.ts").read_text())

    def test_the_shared_core_pin_triggers_every_surface_gate(self):
        for surface in ("plugin", "launchers", "packaging", "macos_package"):
            block = re.search(rf"(?m)^            {surface}:\n((?:^              - .*\n)+)", CI)
            self.assertIsNotNone(block, surface)
            self.assertIn("- 'web/core-sdk.json'", block.group(1), surface)
        self.assertIn("- 'web/**'", CI.split("            web:\n", 1)[1].split("            packaging:\n", 1)[0])

    def test_the_launcher_pin_check_preserves_development_pins(self):
        job = jobs(CI)["launchers"]
        self.assertIn("../packaging/core-pin --web ../web/core-sdk.json", job)
        self.assertIn('[[ "$core_ref" == v* && "$POHUNEK_RELEASE" != "$core_ref" ]]', job)
        self.assertIn("set -euo pipefail", job)

    def test_only_web_is_packaged_for_macos_and_required_by_the_release_gate(self):
        job = jobs(CI)["macos-package"]
        self.assertIn("COMPONENT: web", job)
        self.assertNotIn("matrix:", job)
        for surface, expected in (("web", "success"), ("launchers", "skipped"), ("plugin", "skipped")):
            self.assertIn(f"verify-macos={expected}", re.search(rf"{surface}\) want=\"(.*?)\"", RELEASE).group(1), surface)


if __name__ == "__main__":
    unittest.main()
