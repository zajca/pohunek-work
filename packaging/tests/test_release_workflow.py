"""Static checks of the release workflow's trust boundaries (stdlib only).

`actionlint` validates the syntax and the shell steps in CI; these tests pin the
properties that make the release safe: which job holds a secret or a write
token, that the signing job runs no program from the staged tree, and that the
CI gate is one reusable workflow.
"""

from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"
RELEASE = (WORKFLOWS / "release.yml").read_text()
CI = (WORKFLOWS / "ci.yml").read_text()

SECRETS = {
    "MACOS_CERTIFICATE_P12_BASE64",
    "MACOS_CERTIFICATE_PASSWORD",
    "APPLE_NOTARY_KEY_P8_BASE64",
    "APPLE_NOTARY_KEY_ID",
    "APPLE_NOTARY_ISSUER_ID",
}
PINNED = re.compile(r"@[0-9a-f]{40}$")


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
        self.assertRegex(CI, r"needs: \[changes, plugin, launchers, native, native-macos, web, web-macos, packaging\]")

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


class MacosSigningTest(unittest.TestCase):
    def setUp(self):
        self.stage = RELEASE_JOBS["stage-macos"]
        self.sign = RELEASE_JOBS["sign-macos"]
        self.verify = RELEASE_JOBS["verify-macos"]
        self.publish = RELEASE_JOBS["publish"]

    def test_secrets_exist_only_in_the_signing_job_and_only_in_its_steps(self):
        for name, job in RELEASE_JOBS.items():
            if name != "sign-macos":
                self.assertNotIn("secrets.", job.replace("secrets: inherit", ""), name)
                self.assertNotIn("macos-signing", job.replace("environment: macos-signing", "x"), name)
        header = self.sign.split("    steps:", 1)[0]
        self.assertNotIn("secrets.", header, "no secret may be exposed to the whole job")
        self.assertIn("environment: macos-signing", header)
        self.assertEqual(set(re.findall(r"secrets\.([A-Z0-9_]+)", self.sign)), SECRETS)
        for block in re.split(r"\n      - ", self.sign):
            if "uses:" in block:
                self.assertNotIn("secrets.", block)

    def test_the_secret_names_are_listed_in_the_workflow_header(self):
        header = RELEASE.split("\njobs:\n", 1)[0]
        for secret in SECRETS | {"MACOS_TEAM_ID"}:
            self.assertIn(secret, header)

    def test_the_signing_job_uses_only_pinned_actions_and_runs_nothing_from_the_tree(self):
        for use in re.findall(r"uses: (\S+)", self.sign):
            self.assertRegex(use, PINNED, use)
        for forbidden in ("--stage-release", "cargo", "bun ", "--version", "smoke", "stage-archive", "setup-"):
            self.assertNotIn(forbidden, self.sign, forbidden)

    def test_every_action_that_shapes_the_signed_bytes_is_pinned(self):
        for name in ("stage-macos", "sign-macos", "verify-macos", "publish"):
            for use in re.findall(r"uses: (\S+)", RELEASE_JOBS[name]):
                self.assertRegex(use, PINNED, "%s: %s" % (name, use))

    def test_missing_credentials_fail_the_signing_job_before_any_work(self):
        order = [
            self.sign.index("Require signing and notarization credentials"),
            self.sign.index("Download the staged tree"),
            self.sign.index("Create ephemeral signing keychain"),
        ]
        self.assertEqual(order, sorted(order))
        self.assertIn("exit 1", self.sign.split("Download the staged tree", 1)[0])
        self.assertIn("vars.MACOS_TEAM_ID", self.sign.split("Download the staged tree", 1)[0])

    def test_the_staged_tree_travels_as_a_checked_tar_and_no_artifact_value_reaches_a_script(self):
        self.assertIn("shasum -a 256 -c stage.tar.sha256", self.sign)
        self.assertIn("packaging/macos/package --stage-release", self.stage)
        self.assertIn("packaging/macos/package --sign-release", self.sign)
        self.assertNotIn("--sign-release", self.stage)
        self.assertNotIn("--stage-release", self.sign)
        self.assertNotIn("--development", RELEASE)
        self.assertIn("entries outside", self.sign)
        self.assertIn("parent-directory component", self.sign)
        for job in (self.sign, self.verify):
            self.assertNotIn("steps.stage.outputs", job)

    def test_the_keychain_is_always_removed_and_nothing_runs_between(self):
        remove = self.sign.split("- name: Remove ephemeral signing keychain", 1)[1].split("\n      - ", 1)[0]
        self.assertIn("if: always()", remove)
        create = self.sign.index("name: Create ephemeral signing keychain")
        removal = self.sign.index("name: Remove ephemeral signing keychain")
        self.assertEqual(self.sign[create:removal].count("- name:"), 1)

    def test_the_verify_job_checks_the_signed_bytes_and_cannot_write(self):
        self.assertIn("verify-signed --notarized", self.verify)
        self.assertIn("--signing developer-id", self.verify)
        self.assertIn("RUNNER_TEMP/extracted", self.verify)
        self.assertIn("contents: read", self.verify)
        self.assertNotIn("contents: write", self.verify)
        self.assertIn("vars.MACOS_TEAM_ID", self.verify)
        self.assertIn("needs: [prepare, sign-macos]", self.verify)
        self.assertIn("needs: [prepare, stage-macos]", self.sign)

    def test_the_skip_option_only_skips_signing_and_everything_after_it(self):
        self.assertIn("inputs.skip_macos_signing", self.sign)
        self.assertNotIn("skip_macos_signing", self.stage)
        self.assertNotIn("skip_macos_signing", self.verify)


class PublishTest(unittest.TestCase):
    def setUp(self):
        self.publish = RELEASE_JOBS["publish"]

    def test_only_the_publish_job_can_write_and_it_needs_every_archive_job(self):
        for name, job in RELEASE_JOBS.items():
            if name != "publish":
                self.assertNotIn("contents: write", job, name)
        self.assertIn("contents: write", self.publish)
        for needed in ("build-gui-linux", "package-web", "package-launchers", "verify-macos"):
            self.assertIn(needed, self.publish.split("runs-on:", 1)[0], needed)

    def test_the_publish_job_runs_nothing_from_an_archive(self):
        for forbidden in ("tar -x", "smoke", "cargo", "bun ", "verify-signed", "install.sh"):
            self.assertNotIn(forbidden, self.publish, forbidden)

    def test_the_asset_set_is_exact_checked_before_and_re_queried_after_publishing(self):
        for asset in (
            "pohunek-gui-${VERSION}-x86_64-unknown-linux-gnu.tar.gz",
            "pohunek-web-${VERSION}-linux-x86_64.tar.gz",
            "pohunek-launchers-${VERSION}-noarch.tar.gz",
            "pohunek-gui-${VERSION}-aarch64-apple-darwin.tar.gz",
            "pohunek-web-${VERSION}-aarch64-apple-darwin.tar.gz",
        ):
            self.assertIn(asset, self.publish)
        self.assertIn("the downloaded assets differ from the expected set", self.publish)
        self.assertIn("fail_on_unmatched_files: true", self.publish)
        after = self.publish.split("Verify the published assets", 1)[1]
        self.assertIn("gh release download", after)
        self.assertIn("sha256sum -c", after)
        self.assertIn("cmp ", after)


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

    def test_the_web_filter_covers_the_web_folder_and_the_shared_packaging(self):
        block = CI.split("            web:\n", 1)[1].split("            packaging:\n", 1)[0]
        for path in ("web/**", "packaging/**", ".github/workflows/ci.yml"):
            self.assertIn("- '%s'" % path, block)
        self.assertIn("web: ${{ steps.filter.outputs.web }}", CI)
        for name in ("web", "web-macos"):
            self.assertIn("needs.changes.outputs.web == 'true'", jobs(CI)[name], name)

    def test_pull_requests_are_still_filtered_and_other_events_run_everything(self):
        for name in ("plugin", "launchers", "native", "native-macos", "web", "web-macos", "packaging"):
            job = jobs(CI)[name]
            self.assertIn("github.event_name != 'pull_request' ||", job, name)
        changes = jobs(CI)["changes"]
        self.assertEqual(changes.count("if: ${{ github.event_name == 'pull_request' }}"), 2)


if __name__ == "__main__":
    unittest.main()
