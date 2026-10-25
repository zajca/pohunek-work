"""Behavioural checks of `packaging/changelog` against the changelog contract fixtures (stdlib only).

The contract fixtures live in `fixtures/changelog/`. The multi-surface fixture runs as published. The
single-product fixture runs as the surface `web` of a multi-surface repository: its CHANGELOG.md becomes
`web/CHANGELOG.md` and every fragment names `web`, which is the only surface in that fixture.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
CHANGELOG = ROOT / "packaging" / "changelog"
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "changelog"


def run(root, *args):
    return subprocess.run(
        [str(CHANGELOG), *args, "--root", str(root)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )


def write_config(root, repository, surfaces):
    config = {
        "repository": repository,
        "surfaces": {
            surface: {"version": f"{surface}/package.json", "changelog": f"{surface}/CHANGELOG.md"}
            for surface in surfaces
        },
    }
    (root / "packaging").mkdir(parents=True, exist_ok=True)
    (root / "packaging" / "surfaces.json").write_text(json.dumps(config))


def fragments(root):
    directory = root / "changelog.d"
    if not directory.exists():
        return {}
    return {path.name: path.read_bytes() for path in sorted(directory.iterdir())}


class MultiSurfaceFixtureTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="pohunek-changelog-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        shutil.copytree(FIXTURES / "multi" / "input", self.root, dirs_exist_ok=True)
        write_config(self.root, "example/work", ["plugin", "web"])

    def test_fold_of_one_surface_reproduces_the_contract_output_byte_for_byte(self):
        web_before = (self.root / "web" / "CHANGELOG.md").read_bytes()
        result = run(self.root, "fold", "0.8.0", "--surface", "plugin", "--date", "2026-10-24")
        self.assertEqual(result.returncode, 0, result.stderr)
        expected = FIXTURES / "multi" / "expected-plugin-0.8.0"
        self.assertEqual(
            (self.root / "plugin" / "CHANGELOG.md").read_bytes(),
            (expected / "plugin" / "CHANGELOG.md").read_bytes(),
        )
        self.assertEqual(fragments(self.root), fragments_of(expected))
        self.assertEqual((self.root / "web" / "CHANGELOG.md").read_bytes(), web_before)

    def test_a_folded_surface_is_published_as_its_marker_block_only_for_that_surface(self):
        self.assertEqual(run(self.root, "fold", "0.8.0", "--surface", "plugin", "--date", "2026-10-24").returncode, 0)
        notes = run(self.root, "notes", "0.8.0", "--surface", "plugin")
        self.assertEqual(notes.returncode, 0, notes.stderr)
        self.assertTrue(notes.stdout.startswith("<!-- pohunek-changelog:start -->\n### Changed\n"))
        self.assertTrue(notes.stdout.endswith("<!-- pohunek-changelog:end -->\n"))
        self.assertNotIn("dark mode", notes.stdout)
        self.assertIn("Both read the host list", notes.stdout)

    def test_the_folded_surface_leaves_the_changes_of_other_surfaces_for_their_release(self):
        self.assertEqual(run(self.root, "fold", "0.8.0", "--surface", "plugin", "--date", "2026-10-24").returncode, 0)
        web = run(self.root, "notes", "0.8.0", "--surface", "web")
        self.assertEqual(web.returncode, 1)
        self.assertIn("web still has unfolded fragments: 31-shared-hosts.md, 32-web-dark-mode.md", web.stderr)
        self.assertEqual(sorted(fragments(self.root)), ["31-shared-hosts.md", "32-web-dark-mode.md"])

    def test_a_surface_is_required_and_must_be_declared(self):
        for args in (["fold", "0.8.0", "--date", "2026-10-24"], ["notes", "0.8.0"]):
            self.assertNotEqual(run(self.root, *args).returncode, 0, args)
        result = run(self.root, "fold", "0.8.0", "--surface", "docs", "--date", "2026-10-24")
        self.assertEqual(result.returncode, 1)
        self.assertIn("the surface must be one of plugin, web", result.stderr)

    def test_an_invalid_fragment_aborts_the_fold_without_writing_anything(self):
        (self.root / "changelog.d" / "40-broken.md").write_text("---\nkind: feature\nsurfaces: plugin\n---\nText.\n")
        before = fragments(self.root)
        changelog = (self.root / "plugin" / "CHANGELOG.md").read_bytes()
        result = run(self.root, "fold", "0.8.0", "--surface", "plugin", "--date", "2026-10-24")
        self.assertEqual(result.returncode, 1)
        self.assertIn("unknown kind feature", result.stderr)
        self.assertEqual(fragments(self.root), before)
        self.assertEqual((self.root / "plugin" / "CHANGELOG.md").read_bytes(), changelog)

    def test_a_version_with_a_section_is_never_folded_twice(self):
        self.assertEqual(run(self.root, "fold", "0.8.0", "--surface", "plugin", "--date", "2026-10-24").returncode, 0)
        result = run(self.root, "fold", "0.8.0", "--surface", "plugin", "--date", "2026-10-25")
        self.assertEqual(result.returncode, 1)
        self.assertIn("already has a section for 0.8.0", result.stderr)

    def test_only_release_and_prerelease_versions_are_folded(self):
        for version in ("0.8.0", "0.8.0-pre.1"):
            result = run(self.root, "notes", version, "--surface", "plugin")
            self.assertEqual(result.returncode, 1)
            self.assertNotIn("the version must be", result.stderr)
        for version in ("0.8", "v0.8.0", "0.8.0-rc1", "0.8.0-pre.01", "0.8.0-pre"):
            result = run(self.root, "fold", version, "--surface", "plugin", "--date", "2026-10-24")
            self.assertEqual(result.returncode, 1, version)
            self.assertIn("the version must be X.Y.Z or X.Y.Z-pre.N", result.stderr)
        self.assertEqual(run(self.root, "fold", "0.8.0-pre.1", "--surface", "plugin", "--date", "2026-10-24").returncode, 0)

    def test_a_fragment_body_line_that_looks_like_the_header_is_left_alone(self):
        (self.root / "changelog.d" / "33-header-like.md").write_text(
            "---\nkind: fixed\nsurfaces: plugin, web\n---\nsurfaces: plugin, web\n"
        )
        self.assertEqual(run(self.root, "fold", "0.8.0", "--surface", "plugin", "--date", "2026-10-24").returncode, 0)
        self.assertEqual(
            (self.root / "changelog.d" / "33-header-like.md").read_text(),
            "---\nkind: fixed\nsurfaces: web\n---\nsurfaces: plugin, web\n",
        )

    def test_a_fold_that_cannot_write_changes_nothing(self):
        if os.geteuid() == 0:
            self.skipTest("root writes into read-only directories")
        (self.root / "changelog.d" / "2-open.md").write_text("---\nkind: fixed\nsurfaces: plugin\n---\nOpen.\n")
        before = fragments(self.root)
        changelog = (self.root / "plugin" / "CHANGELOG.md").read_bytes()
        plugin = self.root / "plugin"
        plugin.chmod(0o555)
        self.addCleanup(plugin.chmod, 0o755)
        result = run(self.root, "fold", "0.8.0", "--surface", "plugin", "--date", "2026-10-24")
        self.assertEqual(result.returncode, 1)
        self.assertIn("nothing was changed", result.stderr)
        self.assertEqual(fragments(self.root), before)
        self.assertEqual((self.root / "plugin" / "CHANGELOG.md").read_bytes(), changelog)
        self.assertEqual(list(plugin.glob("*.fold-tmp")), [])

    def test_an_unreadable_fragment_is_reported_as_a_changelog_line(self):
        (self.root / "changelog.d" / "3-dir.md").mkdir()
        result = run(self.root, "check")
        self.assertEqual(result.returncode, 1)
        self.assertTrue(result.stderr.startswith("changelog: "), result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_a_section_with_no_content_is_not_published(self):
        (self.root / "plugin" / "CHANGELOG.md").write_text("# Changelog\n\n## 0.8.0 - 2026-10-24\n\n## 0.7.0 - 2026-10-01\n\n### Fixed\n\n- Old.\n")
        for path in (self.root / "changelog.d").iterdir():
            path.unlink()
        result = run(self.root, "notes", "0.8.0", "--surface", "plugin")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertIn("has an empty section for 0.8.0", result.stderr)

    def test_notes_refuse_a_surface_with_fragments_left_after_its_fold(self):
        self.assertEqual(run(self.root, "fold", "0.8.0", "--surface", "plugin", "--date", "2026-10-24").returncode, 0)
        (self.root / "changelog.d" / "33-late.md").write_text("---\nkind: fixed\nsurfaces: plugin\n---\nA late fix.\n")
        result = run(self.root, "notes", "0.8.0", "--surface", "plugin")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertIn("plugin still has unfolded fragments: 33-late.md", result.stderr)

    def test_the_repository_declares_a_valid_changelog_set(self):
        result = run(ROOT, "check")
        self.assertEqual(result.returncode, 0, result.stderr)


class SingleProductFixtureTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="pohunek-changelog-single-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        single = FIXTURES / "single"
        (self.root / "web").mkdir()
        shutil.copyfile(single / "input" / "CHANGELOG.md", self.root / "web" / "CHANGELOG.md")
        (self.root / "changelog.d").mkdir()
        for path in (single / "input" / "changelog.d").iterdir():
            # The surface of a single-product fixture is `web`; the fragment names it as a multi-surface fragment does.
            lines = path.read_text().split("\n")
            closing = lines.index("---", 1)
            lines.insert(closing, "surfaces: web")
            (self.root / "changelog.d" / path.name).write_text("\n".join(lines))
        write_config(self.root, "example/app", ["web"])

    def test_the_folds_and_notes_reproduce_the_single_product_fixture_byte_for_byte(self):
        expected = FIXTURES / "single"
        fold = run(self.root, "fold", "0.37.0", "--surface", "web", "--date", "2026-10-24")
        self.assertEqual(fold.returncode, 0, fold.stderr)
        self.assertEqual(
            (self.root / "web" / "CHANGELOG.md").read_bytes(),
            (expected / "expected-0.37.0" / "CHANGELOG.md").read_bytes(),
        )
        self.assertEqual(fragments(self.root), {})
        notes = run(self.root, "notes", "0.37.0", "--surface", "web")
        self.assertEqual(notes.returncode, 0, notes.stderr)
        self.assertEqual(notes.stdout.encode(), (expected / "expected-0.37.0" / "notes.md").read_bytes())

        fold = run(self.root, "fold", "0.37.1", "--surface", "web", "--date", "2026-10-25")
        self.assertEqual(fold.returncode, 0, fold.stderr)
        self.assertEqual(
            (self.root / "web" / "CHANGELOG.md").read_bytes(),
            (expected / "expected-0.37.1" / "CHANGELOG.md").read_bytes(),
        )
        notes = run(self.root, "notes", "0.37.1", "--surface", "web")
        self.assertEqual(notes.returncode, 0, notes.stderr)
        self.assertEqual(notes.stdout.encode(), (expected / "expected-0.37.1" / "notes.md").read_bytes())


class InvalidFragmentTest(unittest.TestCase):
    """Every invalid input of the contract is rejected by `check`, and nothing is written."""

    CASES = {
        "no opening rule": ("12-case.md", "kind: added\nsurfaces: web\n---\nText.\n"),
        "no closing rule": ("12-case.md", "---\nkind: added\nsurfaces: web\nText.\n"),
        "unknown key": ("12-case.md", "---\nkind: added\nsurfaces: web\nowner: me\n---\nText.\n"),
        "duplicate key": ("12-case.md", "---\nkind: added\nkind: fixed\nsurfaces: web\n---\nText.\n"),
        "missing kind": ("12-case.md", "---\nsurfaces: web\n---\nText.\n"),
        "unknown kind": ("12-case.md", "---\nkind: feature\nsurfaces: web\n---\nText.\n"),
        "breaking not a boolean": ("12-case.md", "---\nkind: added\nbreaking: yes\nsurfaces: web\n---\nText.\n"),
        "empty body": ("12-case.md", "---\nkind: added\nsurfaces: web\n---\n\n"),
        "blank line in the body": ("12-case.md", "---\nkind: added\nsurfaces: web\n---\nFirst.\n\nSecond.\n"),
        "heading in the body": ("12-case.md", "---\nkind: added\nsurfaces: web\n---\n# Title\nText.\n"),
        "file name x-foo": ("x-foo.md", "---\nkind: added\nsurfaces: web\n---\nText.\n"),
        "file name leading zero": ("012-foo.md", "---\nkind: added\nsurfaces: web\n---\nText.\n"),
        "file name uppercase": ("12-Foo.md", "---\nkind: added\nsurfaces: web\n---\nText.\n"),
        "file name underscore": ("12_foo.md", "---\nkind: added\nsurfaces: web\n---\nText.\n"),
        "missing surfaces": ("12-case.md", "---\nkind: added\n---\nText.\n"),
        "unknown surface": ("12-case.md", "---\nkind: added\nsurfaces: docs\n---\nText.\n"),
        "duplicate surface": ("12-case.md", "---\nkind: added\nsurfaces: web, web\n---\nText.\n"),
        "surfaces without the separator space": ("12-case.md", "---\nkind: added\nsurfaces: plugin,web\n---\nText.\n"),
        "CRLF line endings": ("12-case.md", "---\r\nkind: added\r\nsurfaces: web\r\n---\r\nText.\r\n"),
    }

    def test_every_invalid_input_is_rejected_by_check(self):
        for case, (name, content) in self.CASES.items():
            with self.subTest(case=case):
                root = Path(tempfile.mkdtemp(prefix="pohunek-changelog-invalid-"))
                self.addCleanup(shutil.rmtree, root, ignore_errors=True)
                write_config(root, "example/work", ["plugin", "web"])
                (root / "changelog.d").mkdir()
                (root / "changelog.d" / name).write_bytes(content.encode())
                result = run(root, "check")
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertTrue(result.stderr.startswith("changelog: changelog.d/"), result.stderr)

    def test_a_valid_fragment_passes_check(self):
        root = Path(tempfile.mkdtemp(prefix="pohunek-changelog-valid-"))
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        write_config(root, "example/work", ["plugin", "web"])
        (root / "changelog.d").mkdir()
        (root / "changelog.d" / "12-case.md").write_text(
            "---\nkind: added\nbreaking: false\nsurfaces: plugin, web\n---\nA line\nthat wraps.\n"
        )
        (root / "changelog.d" / ".gitkeep").write_text("")
        result = run(root, "check")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "changelog: 1 fragment(s) valid\n")


def fragments_of(expected):
    directory = expected / "changelog.d"
    if not directory.exists():
        return {}
    return {path.name: path.read_bytes() for path in sorted(directory.iterdir())}


if __name__ == "__main__":
    unittest.main()
