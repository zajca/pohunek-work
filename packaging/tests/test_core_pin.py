"""Regression checks for `packaging/core-pin` (stdlib only).

The pin is read from web/core-sdk.json; tag-to-commit comparisons run against a
real local git repository through `git ls-remote`, so no network is involved.
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
RELEASE_BASE = "https://github.com/zajca/pohunek/releases/download"
LOCAL_BASE = "http://127.0.0.1:47321/releases/download"


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
        (self.dir / "package.json").write_text(json.dumps({"version": "0.5.1"}))

    def web(self, rev=None, *, version="1.2.3", base=RELEASE_BASE, repo="https://github.com/zajca/pohunek", **extra):
        rev = rev if rev is not None else self.first
        pin = {"coreRepository": repo, "coreRev": rev, "sdkVersion": version, "assetBaseUrl": base}
        path = self.dir / "core-sdk.json"
        path.write_text(json.dumps({**pin, **extra}))
        return path

    def pin(self, *args, cwd=None, env=None):
        git_config = dict(
            os.environ,
            GIT_CONFIG_COUNT="1",
            GIT_CONFIG_KEY_0=f"url.{self.url}.insteadOf",
            GIT_CONFIG_VALUE_0="https://github.com/zajca/pohunek",
        )
        if env:
            git_config.update(env)
        result = subprocess.run(
            [str(CORE_PIN), *map(str, args)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=cwd,
            env=git_config,
        )
        values = dict(line.split("=", 1) for line in result.stdout.splitlines())
        return result, values

    def released(self, **kwargs):
        """A release-URL pin resolved against the local git repository."""
        return self.pin("--web", self.web(**kwargs))

    def test_a_release_pin_reports_the_tag_and_the_commit(self):
        result, values = self.released()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(values, {"core_ref": "v1.2.3", "core_rev": self.first, "web_version": "0.5.1"})

    def test_a_lightweight_release_tag_resolves_to_its_commit(self):
        result, values = self.released(rev=self.second, version="1.2.4")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(values, {"core_ref": "v1.2.4", "core_rev": self.second, "web_version": "0.5.1"})

    def test_a_pre_release_sdk_version_on_a_loopback_pin_names_no_tag(self):
        result, values = self.pin("--web", self.web(version="1.2.3-rc.1", base=LOCAL_BASE))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(values, {"core_ref": self.first, "core_rev": self.first, "web_version": "0.5.1"})

    def test_a_loopback_pin_names_the_commit_and_needs_no_tag_resolution(self):
        result, values = self.pin("--web", self.web(base=LOCAL_BASE))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(values, {"core_ref": self.first, "core_rev": self.first, "web_version": "0.5.1"})

    def test_a_release_tag_must_point_at_the_pin_s_commit(self):
        result, _ = self.pin("--web", self.web(rev=self.second))
        self.assertEqual(result.returncode, 1)
        self.assertIn(f"pins core v1.2.3 = {self.first}, but its coreRev is {self.second}", result.stderr)

    def test_a_release_tag_that_does_not_exist_fails(self):
        result, _ = self.pin("--web", self.web(version="9.9.9"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("core tag v9.9.9 does not exist", result.stderr)

    def test_an_unlistable_repository_fails(self):
        result, _ = self.pin("--web", self.web(), env={"GIT_CONFIG_KEY_0": f"url.file://{self.dir / 'no-such-repo'}.insteadOf"})
        self.assertEqual(result.returncode, 1)
        self.assertIn("cannot list tags", result.stderr)

    def test_the_web_pin_must_name_the_repository_the_assets_come_from(self):
        other_host = self.web(repo="https://gitlab.com/other/repo")
        result, _ = self.pin("--web", other_host)
        self.assertEqual(result.returncode, 1)
        self.assertIn("coreRepository must be https://github.com/<owner>/<repo>", result.stderr)
        other_release = self.web(base=RELEASE_BASE.replace("zajca/pohunek", "other/repo"))
        result, _ = self.pin("--web", other_release)
        self.assertEqual(result.returncode, 1)
        self.assertIn("must be the release download URL", result.stderr)

    def test_a_malformed_web_pin_fails(self):
        for kwargs, message in (
            ({"rev": "abc"}, "coreRev must be a 40-digit"),
            ({"rev": self.first, "version": "v1"}, "sdkVersion must be a semantic version"),
            ({"rev": self.first, "extra": "x"}, "exactly the keys"),
            ({"rev": self.first, "version": "1.2.3-rc.1", "base": RELEASE_BASE}, "plain X.Y.Z"),
            ({"rev": self.first, "base": "https://example.com/releases/download"}, "must be the release download URL"),
            ({"rev": self.first, "base": "http://example.com:47321/releases/download"}, "must be http://127.0.0.1"),
            ({"rev": self.first, "base": "file:///tmp/releases/download"}, "not an absolute URL"),
            ({"rev": self.first, "base": f"{RELEASE_BASE}?token=secret"}, "must not carry credentials"),
        ):
            rev = kwargs.pop("rev")
            result, _ = self.pin("--web", self.web(rev, **kwargs))
            self.assertEqual(result.returncode, 1, message)
            self.assertIn(message, result.stderr)

    def test_a_missing_or_unreadable_web_pin_fails(self):
        result, _ = self.pin("--web", self.dir / "absent.json")
        self.assertEqual(result.returncode, 1)
        self.assertIn("does not exist", result.stderr)
        unreadable = self.dir / "core-sdk-unreadable.json"
        unreadable.write_text("{")
        result, _ = self.pin("--web", unreadable)
        self.assertEqual(result.returncode, 1)
        self.assertIn("cannot read", result.stderr)

    def test_a_missing_or_malformed_web_version_fails(self):
        web = self.web(base=LOCAL_BASE)
        package = self.dir / "package.json"
        package.unlink()
        missing, _ = self.pin("--web", web)
        self.assertEqual(missing.returncode, 1)
        self.assertIn("cannot read", missing.stderr)
        for value in ({"version": "1.2"}, {"version": 2}, []):
            package.write_text(json.dumps(value))
            malformed, _ = self.pin("--web", web)
            self.assertEqual(malformed.returncode, 1)
            self.assertIn("must declare a version X.Y.Z", malformed.stderr)

    def test_the_default_web_path_resolves_from_repository_root(self):
        web_dir = self.dir / "web"
        web_dir.mkdir()
        (web_dir / "core-sdk.json").write_bytes(self.web().read_bytes())
        (web_dir / "package.json").write_text(json.dumps({"version": "0.5.1"}))
        result, values = self.pin(cwd=self.dir)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(values["core_ref"], "v1.2.3")

    def test_web_path_resolves_from_a_sibling_surface(self):
        web_dir = self.dir / "web"
        web_dir.mkdir()
        (web_dir / "core-sdk.json").write_bytes(self.web().read_bytes())
        (web_dir / "package.json").write_text(json.dumps({"version": "0.5.1"}))
        launchers = self.dir / "launchers"
        launchers.mkdir()
        result, values = self.pin("--web", "../web/core-sdk.json", cwd=launchers)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(values["web_version"], "0.5.1")

    def test_retired_arguments_are_refused(self):
        for args in (
            ("--native", self.dir / "Cargo.toml", "--web", self.web()),
            ("--expect-version", "0.1.0", "--web", self.web()),
            ("--require-web", "--web", self.web()),
            ("--repository", self.url, "--web", self.web()),
        ):
            result, _ = self.pin(*args)
            self.assertNotEqual(result.returncode, 0, args)


if __name__ == "__main__":
    unittest.main()
