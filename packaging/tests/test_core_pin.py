"""Regression checks for `packaging/core-pin` (stdlib only).

The pin is read from web/core-sdk.json; the plugin release and the launchers
release must name the same core. Tag-to-commit comparisons run against a real
local git repository through `git ls-remote`, so no network is involved.
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

    def plugin(self, release="v1.2.3", *, base=RELEASE_BASE, drop=()):
        pin = {"release": release, "assetBaseUrl": base}
        for key in drop:
            pin.pop(key)
        path = self.dir / "core-release.json"
        path.write_text(json.dumps(pin))
        return path

    def sdk_package(self, release="v1.2.3", *, repo="zajca/pohunek", dependencies=None):
        """A plugin package.json whose SDK dependencies are the tarballs of `release`."""
        asset = f"{release[1:]}.tgz"
        pins = dependencies if dependencies is not None else {
            "@pohunek/protocol": f"https://github.com/{repo}/releases/download/{release}/pohunek-ts-protocol-{asset}",
            "@pohunek/sdk": f"https://github.com/{repo}/releases/download/{release}/pohunek-ts-sdk-{asset}",
        }
        path = self.dir / f"package-{release}.json"
        path.write_text(json.dumps({"dependencies": pins}))
        return path

    def workflow(self, *releases):
        """A workflow file with one `POHUNEK_RELEASE` line per release given."""
        path = self.dir / "ci.yml"
        path.write_text("".join(f"    env:\n      POHUNEK_RELEASE: {release}\n" for release in releases))
        return path

    def pin(self, *args, cwd=None, env=None, plugin=None, workflow=None, package=None):
        """Runs core-pin with the plugin, its package and the workflow fixtures unless the test passes its own."""
        plugin = plugin if plugin is not None else self.plugin()
        try:
            release = json.loads(Path(plugin).read_text())["release"]
        except (OSError, json.JSONDecodeError, KeyError, TypeError):
            release = "v1.2.3"
        package = package if package is not None else self.sdk_package(release)
        extra = [] if cwd is not None else [
            "--plugin", str(plugin), "--plugin-package", str(package), "--ci-workflow", str(workflow or self.workflow("v1.2.3")),
        ]
        git_config = dict(
            os.environ,
            GIT_CONFIG_COUNT="1",
            GIT_CONFIG_KEY_0=f"url.{self.url}.insteadOf",
            GIT_CONFIG_VALUE_0="https://github.com/zajca/pohunek",
        )
        if env:
            git_config.update(env)
        result = subprocess.run(
            [str(CORE_PIN), *map(str, args), *extra],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=cwd,
            env=git_config,
        )
        values = dict(line.split("=", 1) for line in result.stdout.splitlines())
        return result, values

    def test_a_release_pin_reports_the_tag_and_the_commit(self):
        result, values = self.pin("--web", self.web())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(values, {"core_ref": "v1.2.3", "core_rev": self.first, "web_version": "0.5.1"})

    def test_a_lightweight_release_tag_resolves_to_its_commit(self):
        result, values = self.pin(
            "--web", self.web(rev=self.second, version="1.2.4"), plugin=self.plugin("v1.2.4"), workflow=self.workflow("v1.2.4")
        )
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

    def test_a_plugin_release_that_differs_from_the_web_pin_fails(self):
        result, _ = self.pin("--web", self.web(), plugin=self.plugin("v1.2.4"))
        self.assertEqual(result.returncode, 1)
        self.assertIn(f"{self.dir / 'core-release.json'} pins core v1.2.4, web pins core v1.2.3", result.stderr)

    def test_a_launchers_release_that_differs_from_the_web_pin_fails(self):
        result, _ = self.pin("--web", self.web(), workflow=self.workflow("v1.2.4"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("POHUNEK_RELEASE pins core v1.2.4, web pins core v1.2.3", result.stderr)

    def test_a_loopback_web_pin_compares_the_plugin_release_by_commit(self):
        result, _ = self.pin("--web", self.web(base=LOCAL_BASE), plugin=self.plugin("v1.2.4"), workflow=self.workflow("v1.2.4"))
        self.assertEqual(result.returncode, 1)
        self.assertIn(f"pins core v1.2.4 = {self.second}, web pins core commit {self.first}", result.stderr)

    def test_a_plugin_release_missing_from_core_fails(self):
        result, _ = self.pin("--web", self.web(base=LOCAL_BASE), plugin=self.plugin("v9.9.9"), workflow=self.workflow("v9.9.9"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("core tag v9.9.9 does not exist", result.stderr)

    def test_a_malformed_plugin_pin_fails(self):
        for make, message in (
            (lambda: self.plugin("1.2.3"), "release must look like vX.Y.Z: 1.2.3"),
            (lambda: self.plugin(base=LOCAL_BASE), "assetBaseUrl must be https://github.com/"),
            (lambda: self.plugin(drop=("release",)), "release must be a non-empty string"),
            (lambda: self.plugin(drop=("assetBaseUrl",)), "assetBaseUrl must be a non-empty string"),
            (lambda: self.dir / "absent-plugin.json", f"cannot read {self.dir / 'absent-plugin.json'}"),
        ):
            result, _ = self.pin("--web", self.web(), plugin=make())
            self.assertEqual(result.returncode, 1, message)
            self.assertIn(message, result.stderr)

    def test_the_plugin_sdk_must_be_the_tarball_of_the_plugin_release(self):
        for dependencies, message in (
            ({"@pohunek/protocol": "https://github.com/zajca/pohunek/releases/download/v1.2.4/pohunek-ts-protocol-1.2.4.tgz",
              "@pohunek/sdk": "https://github.com/zajca/pohunek/releases/download/v1.2.3/pohunek-ts-sdk-1.2.3.tgz"}, "@pohunek/protocol must be"),
            ({"@pohunek/protocol": "https://github.com/zajca/pohunek/releases/download/v1.2.3/pohunek-ts-protocol-1.2.3.tgz"}, "@pohunek/sdk must be"),
            ({"@pohunek/protocol": "https://github.com/other/repo/releases/download/v1.2.3/pohunek-ts-protocol-1.2.3.tgz",
              "@pohunek/sdk": "https://github.com/zajca/pohunek/releases/download/v1.2.3/pohunek-ts-sdk-1.2.3.tgz"}, "@pohunek/protocol must be"),
            ({"@pohunek/protocol": "0.34.2", "@pohunek/sdk": "0.34.2"}, "@pohunek/protocol must be"),
        ):
            package = self.sdk_package(dependencies=dependencies)
            result, _ = self.pin("--web", self.web(), package=package)
            self.assertEqual(result.returncode, 1, message)
            self.assertIn(message, result.stderr)
        result, _ = self.pin("--web", self.web(), package=self.dir / "absent-package.json")
        self.assertEqual(result.returncode, 1)
        self.assertIn("cannot read", result.stderr)

    def test_the_plugin_pin_must_download_from_the_core_repository(self):
        plugin = self.plugin(base="https://github.com/other/repo/releases/download")
        result, _ = self.pin("--web", self.web(), plugin=plugin)
        self.assertEqual(result.returncode, 1)
        self.assertIn("assetBaseUrl comes from other/repo, not the core repository", result.stderr)

    def test_the_workflow_must_set_one_launchers_release(self):
        result, _ = self.pin("--web", self.web(), workflow=self.workflow("v1.2.3", "v1.2.3"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("must set POHUNEK_RELEASE on exactly one line, found 2", result.stderr)
        result, _ = self.pin("--web", self.web(), workflow=self.dir / "absent-ci.yml")
        self.assertEqual(result.returncode, 1)
        self.assertIn(f"cannot read {self.dir / 'absent-ci.yml'}", result.stderr)

    def test_the_default_paths_resolve_from_repository_root(self):
        (self.dir / "web").mkdir()
        (self.dir / "web" / "core-sdk.json").write_bytes(self.web().read_bytes())
        (self.dir / "web" / "package.json").write_text(json.dumps({"version": "0.5.1"}))
        (self.dir / "plugin").mkdir()
        (self.dir / "plugin" / "core-release.json").write_bytes(self.plugin().read_bytes())
        (self.dir / "plugin" / "package.json").write_bytes(self.sdk_package().read_bytes())
        (self.dir / ".github" / "workflows").mkdir(parents=True)
        (self.dir / ".github" / "workflows" / "ci.yml").write_bytes(self.workflow("v1.2.3").read_bytes())
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
        result, values = self.pin(
            "--web", "../web/core-sdk.json", "--plugin", str(self.plugin()), "--plugin-package", str(self.sdk_package()),
            "--ci-workflow", str(self.workflow("v1.2.3")), cwd=launchers,
        )
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

    def test_the_repository_pins_resolve(self):
        result = subprocess.run(
            [str(CORE_PIN), "--web", str(ROOT / "web" / "core-sdk.json")]
            + [
                "--plugin", str(ROOT / "plugin" / "core-release.json"),
                "--plugin-package", str(ROOT / "plugin" / "package.json"),
                "--ci-workflow", str(ROOT / ".github" / "workflows" / "ci.yml"),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
