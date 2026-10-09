"""Regression checks for `packaging/resolve-release` (stdlib only)."""

import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
RESOLVE = ROOT / "packaging" / "resolve-release"

VERSIONS = {"web": "0.5.1", "launchers": "0.6.2", "plugin": "0.7.3"}


def resolve(root, *args):
    return subprocess.run(
        [str(RESOLVE), "--root", str(root), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )


class ResolveReleaseTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="pohunek-resolve-release-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        for surface in VERSIONS:
            (self.root / surface).mkdir()
            (self.root / surface / "package.json").write_text(json.dumps({"version": VERSIONS[surface]}))

    def test_each_surface_tag_selects_only_its_own_surface_and_version(self):
        for surface, version in VERSIONS.items():
            result = resolve(self.root, "--tag", f"{surface}-v{version}")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                result.stdout.splitlines(),
                [f"surface={surface}", f"version={version}", f"tag={surface}-v{version}"],
            )

    def test_a_tag_of_one_surface_never_resolves_to_another_surface(self):
        for surface, version in VERSIONS.items():
            for other, other_version in VERSIONS.items():
                if other == surface:
                    continue
                result = resolve(self.root, "--tag", f"{surface}-v{other_version}")
                self.assertEqual(result.returncode, 1, f"{surface}-v{other_version}")
                self.assertEqual(result.stdout, "")

    def test_a_gui_tag_is_an_unknown_surface(self):
        (self.root / "native").mkdir()
        (self.root / "native" / "Cargo.toml").write_text('[workspace.package]\nversion = "0.4.0"\n')
        for tag in ("gui-v0.4.0", "gui-v9.9.9"):
            result = resolve(self.root, "--tag", tag)
            self.assertEqual(result.returncode, 1, repr(tag))
            self.assertEqual(result.stdout, "")
            self.assertIn("surface must be one of web, launchers, plugin", result.stderr)
        result = resolve(self.root, "--surface", "gui", "--version", "0.4.0")
        self.assertEqual(result.returncode, 1)
        self.assertIn("surface must be one of web, launchers, plugin", result.stderr)

    def test_a_version_that_differs_from_the_source_is_refused(self):
        for surface, version in VERSIONS.items():
            result = resolve(self.root, "--tag", f"{surface}-v9.9.9")
            self.assertEqual(result.returncode, 1, surface)
            self.assertIn(f"declares {surface} version {version}", result.stderr)
            self.assertEqual(result.stdout, "")

    def test_malformed_or_unknown_tags_are_refused(self):
        for tag in (
            "",
            "v0.5.1",
            "docs-v1.0.0",
            "web",
            "web-0.5.1",
            "web-v0.5",
            "web-v0.5.1-rc1",
            "web-v0.5.1.1",
            "web-v0.5.1\nlaunchers-v0.6.2",
            "WEB-v0.5.1",
            "refs/tags/web-v0.5.1",
            "web-v0.5.1 ",
            "web-v0.5.1\n",
            "-v0.5.1",
        ):
            result = resolve(self.root, f"--tag={tag}")
            self.assertEqual(result.returncode, 1, repr(tag))
            self.assertEqual(result.stdout, "", repr(tag))

    def test_a_manual_run_needs_a_known_surface_and_a_matching_version(self):
        for surface, version in VERSIONS.items():
            result = resolve(self.root, "--surface", surface, "--version", version)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(f"tag={surface}-v{version}", result.stdout)
        for args in (
            ("--surface", "", "--version", "0.5.1"),
            ("--surface", "docs", "--version", "0.5.1"),
            ("--surface", "web", "--version", ""),
            ("--surface", "web", "--version", "0.5"),
            ("--surface", "web", "--version", "0.5.1\n"),
            ("--surface", "web", "--version", "0.6.0"),
            ("--surface", "web"),
            ("--version", "0.5.1"),
            (),
        ):
            result = resolve(self.root, *args)
            self.assertEqual(result.returncode, 1, args)
            self.assertEqual(result.stdout, "", args)

    def test_a_tag_cannot_be_combined_with_the_manual_inputs(self):
        result = resolve(self.root, "--tag", "web-v0.5.1", "--surface", "web", "--version", "0.5.1")
        self.assertEqual(result.returncode, 1)

    def test_a_missing_or_malformed_source_version_is_refused(self):
        (self.root / "plugin" / "package.json").write_text(json.dumps({"name": "x"}))
        self.assertEqual(resolve(self.root, "--tag", "plugin-v0.7.3").returncode, 1)
        (self.root / "web" / "package.json").write_text("{")
        self.assertEqual(resolve(self.root, "--tag", "web-v0.5.1").returncode, 1)
        (self.root / "launchers" / "package.json").unlink()
        self.assertEqual(resolve(self.root, "--tag", "launchers-v0.6.2").returncode, 1)


class RepositorySourcesTest(unittest.TestCase):
    def test_every_surface_declares_a_version_in_its_source(self):
        for surface in VERSIONS:
            declared = subprocess.run(
                [str(RESOLVE), "--root", str(ROOT), "--surface", surface, "--version", "0.0.0"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )
            self.assertEqual(declared.returncode, 1)
            self.assertIn(f"declares {surface} version", declared.stderr, surface)


if __name__ == "__main__":
    unittest.main()
