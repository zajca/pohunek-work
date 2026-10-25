"""Checks of the `Changelog` pull request workflow (stdlib only).

The requirement step runs for real: each case builds a git history with the base and the head commits
and runs the step's script with the same environment the workflow gives it.
"""

import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = (ROOT / ".github" / "workflows" / "changelog.yml").read_text()
# The header comment names the events the workflow avoids; the checks read the code only.
CODE = "\n".join(line for line in WORKFLOW.splitlines() if not line.lstrip().startswith("#"))
PINNED = re.compile(r"@[0-9a-f]{40}$")
REQUIREMENT = "Require a fragment unless the pull request is labeled no-changelog"


def requirement_script():
    """The run block of the requirement step, dedented."""
    step = WORKFLOW.split(f"- name: {REQUIREMENT}", 1)[1].split("\n      - name:", 1)[0]
    block = step.split("run: |\n", 1)[1]
    lines = [line[10:] if line.startswith(" " * 10) else line.strip() for line in block.split("\n")]
    return "\n".join(line for line in lines if line.strip() or line == "")


def git(repo, *args):
    subprocess.run(
        ["git", "-c", "user.name=test", "-c", "user.email=test@example.invalid", *args],
        cwd=repo,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


class RequirementStepTest(unittest.TestCase):
    def setUp(self):
        self.repo = Path(tempfile.mkdtemp(prefix="pohunek-changelog-check-"))
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        git(self.repo, "init", "-q", "-b", "main")
        (self.repo / "changelog.d").mkdir()
        (self.repo / "changelog.d" / ".gitkeep").write_text("")
        (self.repo / "changelog.d" / "12-existing.md").write_text(
            "---\nkind: added\nsurfaces: web\n---\nAn earlier change.\n"
        )
        (self.repo / "README.md").write_text("base\n")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", "base")
        self.base = self.git_output("rev-parse", "HEAD")
        self.script = requirement_script()

    def git_output(self, *args):
        return subprocess.run(
            ["git", *args], cwd=self.repo, check=True, stdout=subprocess.PIPE, text=True
        ).stdout.strip()

    def commit(self, message):
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "--allow-empty", "-m", message)
        return self.git_output("rev-parse", "HEAD")

    def run_step(self, head, labels):
        env = {
            "PATH": os.environ["PATH"],
            "BASE_SHA": self.base,
            "HEAD_SHA": head,
            "LABELS": labels,
        }
        return subprocess.run(
            ["bash", "-c", self.script],
            cwd=self.repo,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )

    def test_a_pull_request_without_a_fragment_or_label_fails(self):
        (self.repo / "README.md").write_text("changed\n")
        head = self.commit("docs only")
        result = self.run_step(head, '["documentation"]')
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("this pull request adds no changelog fragment", result.stdout)

    def test_a_pull_request_adding_a_fragment_passes(self):
        (self.repo / "changelog.d" / "30-new.md").write_text("---\nkind: fixed\nsurfaces: web\n---\nA fix.\n")
        head = self.commit("add fragment")
        result = self.run_step(head, "[]")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("changelog.d/30-new.md", result.stdout)

    def test_modifying_an_existing_fragment_counts(self):
        (self.repo / "changelog.d" / "12-existing.md").write_text("---\nkind: added\nsurfaces: web\n---\nRewritten.\n")
        head = self.commit("modify fragment")
        self.assertEqual(self.run_step(head, "[]").returncode, 0)

    def test_deleting_a_fragment_does_not_count(self):
        (self.repo / "changelog.d" / "12-existing.md").unlink()
        head = self.commit("fold without a new fragment")
        self.assertEqual(self.run_step(head, "[]").returncode, 1)

    def test_a_dotfile_or_a_misnamed_file_in_the_folder_does_not_count(self):
        (self.repo / "changelog.d" / ".31-foo.md").write_text("---\nkind: fixed\nsurfaces: web\n---\nIgnored.\n")
        (self.repo / "changelog.d" / "x-foo.md").write_text("---\nkind: fixed\nsurfaces: web\n---\nBad name.\n")
        head = self.commit("dotfile and bad name")
        result = self.run_step(head, "[]")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("adds no changelog fragment", result.stdout)

    def test_the_no_changelog_label_passes_without_a_fragment(self):
        (self.repo / "README.md").write_text("ci only\n")
        head = self.commit("ci")
        result = self.run_step(head, '["ci","no-changelog"]')
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("no-changelog label is set", result.stdout)

    def test_a_label_named_like_the_flag_only_matches_exactly(self):
        (self.repo / "README.md").write_text("ci only\n")
        head = self.commit("ci")
        self.assertEqual(self.run_step(head, '["no-changelog-soon"]').returncode, 1)
        self.assertEqual(self.run_step(head, "[]").returncode, 1)


class ChangelogWorkflowTest(unittest.TestCase):
    def test_the_check_runs_on_pull_request_events_for_the_labels_too(self):
        self.assertIn(
            "pull_request:\n    types: [opened, synchronize, reopened, labeled, unlabeled, ready_for_review]\n",
            CODE,
        )
        self.assertNotIn("pull_request_target", CODE)
        self.assertNotIn("\npush:", CODE)

    def test_the_workflow_holds_read_access_and_uses_no_secret(self):
        self.assertIn("permissions:\n  contents: read\n", WORKFLOW)
        self.assertNotIn("contents: write", WORKFLOW)
        self.assertNotIn("secrets.", WORKFLOW)

    def test_every_action_is_pinned_to_a_commit(self):
        for use in re.findall(r"uses: (\S+)", WORKFLOW):
            self.assertRegex(use, PINNED, use)

    def test_the_check_validates_every_fragment_before_the_requirement(self):
        self.assertIn("run: packaging/changelog check", WORKFLOW)
        self.assertLess(WORKFLOW.index("packaging/changelog check"), WORKFLOW.index(REQUIREMENT))

    def test_the_requirement_diffs_against_the_base_with_full_history(self):
        self.assertIn("fetch-depth: 0", WORKFLOW)
        self.assertIn('git diff --name-only --diff-filter=AMR "$BASE_SHA...$HEAD_SHA"', WORKFLOW)

    def test_the_labels_and_refs_reach_the_script_only_through_env(self):
        self.assertNotIn("${{", requirement_script())
        self.assertIn("LABELS: ${{ toJSON(github.event.pull_request.labels.*.name) }}", WORKFLOW)


if __name__ == "__main__":
    unittest.main()
