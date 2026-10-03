"""Regression checks for `packaging/core-pin` (stdlib only).

The tag-to-commit comparison runs against a real local git repository through
`git ls-remote`, so no network is involved.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
CORE_PIN = ROOT / "packaging" / "core-pin"

CRATES = ("protocol", "client", "paths")
LOCAL_BASE = "http://127.0.0.1:47321/releases/download"

CARGO = """[workspace]
members = ["crates/gui"]

[workspace.dependencies]
{dependencies}
pohunek-gui-core = {{ path = "crates/gui-core" }}
serde = {{ version = "1" }}

[workspace.package]
version = "{version}"
"""


def git(cwd, *args):
    subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=dict(
            os.environ,
            GIT_AUTHOR_NAME="t",
            GIT_AUTHOR_EMAIL="t@example.invalid",
            GIT_COMMITTER_NAME="t",
            GIT_COMMITTER_EMAIL="t@example.invalid",
            GIT_CONFIG_GLOBAL="/dev/null",
            GIT_CONFIG_SYSTEM="/dev/null",
        ),
    )


def head(cwd):
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=cwd, check=True, stdout=subprocess.PIPE, text=True
    ).stdout.strip()


class CorePinTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="pohunek-core-pin-"))
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.core = self.dir / "core"
        self.core.mkdir()
        git(self.core, "init", "-q", "-b", "main")
        (self.core / "f").write_text("1")
        git(self.core, "add", "f")
        git(self.core, "commit", "-q", "-m", "one")
        self.first = head(self.core)
        git(self.core, "tag", "-a", "-m", "release", "v1.2.3")
        (self.core / "f").write_text("2")
        git(self.core, "commit", "-q", "-am", "two")
        self.second = head(self.core)
        git(self.core, "tag", "v1.2.4")
        self.url = f"file://{self.core}"

    def native(self, *, version="0.1.0", pins=None):
        pins = pins if pins is not None else [{"rev": self.first}] * len(CRATES)
        lines = []
        for crate, pin in zip(CRATES, pins):
            fields = ", ".join(f'{key} = "{value}"' for key, value in pin.items())
            lines.append(f'pohunek-{crate} = {{ git = "{self.url}", {fields} }}')
        path = self.dir / "Cargo.toml"
        path.write_text(CARGO.format(dependencies="\n".join(lines), version=version))
        return path

    def web(self, rev, *, version="0.0.0-core.test", base=LOCAL_BASE, repo="https://github.com/zajca/pohunek", **extra):
        path = self.dir / "core-sdk.json"
        pin = {"coreRepository": repo, "coreRev": rev, "sdkVersion": version, "assetBaseUrl": base}
        path.write_text(json.dumps({**pin, **extra}))
        return path

    def release_base(self, repo="zajca/pohunek"):
        return f"https://github.com/{repo}/releases/download"

    def pin(self, *args):
        result = subprocess.run(
            [str(CORE_PIN), *map(str, args)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        values = dict(line.split("=", 1) for line in result.stdout.splitlines())
        return result, values

    def test_a_commit_pin_without_web_pins_reports_the_commit(self):
        result, values = self.pin("--native", self.native(), "--web", self.dir / "absent.json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            values, {"core_ref": self.first, "core_rev": self.first, "native_version": "0.1.0"}
        )

    def test_a_tag_pin_reports_the_tag_and_no_commit(self):
        native = self.native(pins=[{"tag": "v1.2.3"}] * 3)
        result, values = self.pin("--native", native, "--web", self.dir / "absent.json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(values["core_ref"], "v1.2.3")
        self.assertEqual(values["core_rev"], "")

    def test_a_local_web_pin_agrees_by_commit(self):
        result, values = self.pin("--native", self.native(), "--web", self.web(self.first), "--require-web")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(values["core_ref"], self.first)
        self.assertEqual(values["core_rev"], self.first)

    def test_a_native_tag_matches_the_web_commit(self):
        native = self.native(pins=[{"tag": "v1.2.3"}] * 3)
        result, values = self.pin("--native", native, "--web", self.web(self.first))
        self.assertEqual(result.returncode, 0, result.stderr)
        # The annotated tag is peeled to the commit it points at.
        self.assertEqual(values["core_ref"], "v1.2.3")

    def test_matching_release_tags_agree(self):
        native = self.native(pins=[{"tag": "v1.2.3"}] * 3)
        web = self.web(self.first, version="1.2.3", base=self.release_base())
        result, values = self.pin("--native", native, "--web", web, "--require-web")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(values["core_ref"], "v1.2.3")

    def test_a_release_web_pin_names_the_tag_of_a_native_commit(self):
        web = self.web(self.first, version="1.2.3", base=self.release_base())
        result, values = self.pin("--native", self.native(), "--web", web)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(values["core_ref"], "v1.2.3")
        self.assertEqual(values["core_rev"], self.first)

    def test_a_lightweight_release_tag_resolves_to_its_commit(self):
        native = self.native(pins=[{"rev": self.second}] * 3)
        web = self.web(self.second, version="1.2.4", base=self.release_base())
        result, values = self.pin("--native", native, "--web", web)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(values["core_ref"], "v1.2.4")

    def test_disagreeing_pins_fail(self):
        tag_pins = [{"tag": "v1.2.3"}] * 3
        release = self.release_base()
        # The web pin file is rewritten per case, so each case is built lazily.
        cases = (
            (None, lambda: self.web(self.second), "web pins core commit"),
            (tag_pins, lambda: self.web(self.second), "web pins core commit"),
            (tag_pins, lambda: self.web(self.second, version="1.2.4", base=release), "web pins core v1.2.4"),
            (None, lambda: self.web(self.first, version="9.9.9", base=release), "does not exist"),
            (None, lambda: self.web(self.second, version="1.2.3", base=release), "but its coreRev is"),
        )
        for pins, web, message in cases:
            result, _ = self.pin("--native", self.native(pins=pins), "--web", web())
            self.assertEqual(result.returncode, 1, message)
            self.assertIn(message, result.stderr)

    def test_the_web_pin_must_name_the_github_core_repository(self):
        path = self.dir / "Cargo.toml"
        lines = "\n".join(
            f'pohunek-{crate} = {{ git = "https://github.com/zajca/pohunek.git", rev = "{self.first}" }}'
            for crate in CRATES
        )
        path.write_text(CARGO.format(dependencies=lines, version="0.1.0"))
        other_repo = self.web(self.first, repo="https://github.com/other/repo")
        result, _ = self.pin("--native", path, "--web", other_repo)
        self.assertEqual(result.returncode, 1)
        self.assertIn("names core repository other/repo, not zajca/pohunek", result.stderr)
        other_release = self.web(self.first, version="1.2.3", base=self.release_base("other/repo"))
        result, _ = self.pin("--native", path, "--web", other_release)
        self.assertEqual(result.returncode, 1)
        self.assertIn("comes from other/repo, not the core repository zajca/pohunek", result.stderr)

    def test_a_malformed_web_pin_fails(self):
        for kwargs, message in (
            ({"rev": "abc"}, "coreRev must be a 40-digit"),
            ({"rev": self.first, "version": "v1"}, "sdkVersion must be a semantic version"),
            ({"rev": self.first, "extra": "x"}, "exactly the keys"),
            ({"rev": self.first, "version": "1.2.3-rc.1", "base": self.release_base()}, "plain X.Y.Z"),
        ):
            rev = kwargs.pop("rev")
            result, _ = self.pin("--native", self.native(), "--web", self.web(rev, **kwargs))
            self.assertEqual(result.returncode, 1, message)
            self.assertIn(message, result.stderr)

    def test_the_core_crates_must_share_one_pin(self):
        native = self.native(pins=[{"rev": self.first}, {"rev": self.second}, {"rev": self.first}])
        result, _ = self.pin("--native", native, "--web", self.dir / "absent.json")
        self.assertEqual(result.returncode, 1)
        self.assertIn("not all pinned to one revision", result.stderr)

    def test_a_crate_needs_exactly_one_of_rev_or_tag(self):
        for pins in (
            [{"rev": self.first, "tag": "v1.2.3"}] * 3,
            [{"branch": "main"}] * 3,
            [{"rev": "abc"}] * 3,
            [{"tag": "1.2.3"}] * 3,
        ):
            result, _ = self.pin("--native", self.native(pins=pins), "--web", self.dir / "absent.json")
            self.assertEqual(result.returncode, 1, pins)

    def test_a_manifest_without_core_crates_fails(self):
        path = self.dir / "Cargo.toml"
        path.write_text('[workspace]\n[workspace.package]\nversion = "0.1.0"\n')
        result, _ = self.pin("--native", path, "--web", self.dir / "absent.json")
        self.assertEqual(result.returncode, 1)
        self.assertIn("no core git dependency", result.stderr)

    def test_require_web_fails_without_a_web_pin(self):
        result, _ = self.pin("--native", self.native(), "--web", self.dir / "absent.json", "--require-web")
        self.assertEqual(result.returncode, 1)
        self.assertIn("does not exist", result.stderr)

    def test_the_expected_version_must_match_the_gui_version(self):
        native = self.native(version="0.2.0")
        ok, values = self.pin("--native", native, "--web", self.dir / "absent.json", "--expect-version", "0.2.0")
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertEqual(values["native_version"], "0.2.0")
        bad, _ = self.pin("--native", native, "--web", self.dir / "absent.json", "--expect-version", "0.3.0")
        self.assertEqual(bad.returncode, 1)
        self.assertIn("is 0.2.0, but the release is 0.3.0", bad.stderr)

    def test_the_repository_pins_resolve(self):
        result, values = self.pin("--native", ROOT / "native" / "Cargo.toml", "--web", ROOT / "web" / "core-sdk.json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(values["native_version"], r"^\d+\.\d+\.\d+$")


if __name__ == "__main__":
    unittest.main()
