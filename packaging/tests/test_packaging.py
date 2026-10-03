"""Regression checks for the release packaging scripts (stdlib only).

The scripts are POSIX sh and run on Linux and macOS, so everything here runs on
any host: staging, the archive manifest, the deterministic archive, and the
combined `make-archive` step.
"""

import hashlib
import os
from pathlib import Path
import shutil
import re
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
PACKAGING = ROOT / "packaging"
EPOCH = "1700000000"
TARGET = "x86_64-unknown-linux-gnu"
VERSION = "1.2.3"

CORE_REF = "v0.31.6"
CORE_COMMIT = "30f679a1c1d1b55d5f4d3b85da8a74547fe12039"

LAUNCHER_FILES = (
    "lib.sh",
    "pohunek-launch-issue",
    "pohunek-launch-pr",
    "pohunek-rofi",
    "pohunek-rofi-issue",
    "templates/launcher.conf",
    "templates/sway-dropin.conf.tmpl",
    "templates/prompts/issue.tmpl",
    "templates/prompts/pr.tmpl",
    "templates/prompts/review.tmpl",
    "docs/launcher.md",
    "docs/debug-launcher.md",
)

# The launcher files that plugin/src/setup/assets.ts imports as text.
PLUGIN_LAUNCHER_FILES = (
    "lib.sh",
    "pohunek-launch-issue",
    "pohunek-launch-pr",
    "pohunek-rofi",
    "pohunek-rofi-issue",
    "templates/launcher.conf",
    "templates/sway-dropin.conf.tmpl",
    "templates/sway-issue-binding.conf.tmpl",
    "templates/prompts/issue.tmpl",
    "templates/prompts/pr.tmpl",
    "templates/prompts/review.tmpl",
)
PLUGIN_FILES = (
    "plugin/package.json",
    "plugin/tsconfig.json",
    "plugin/README.md",
    "plugin/src/main.ts",
    "plugin/src/setup/assets.ts",
    "plugin/prompts/work-review.tmpl",
)


def run(args, cwd=None, env=None, check=True):
    merged = dict(os.environ)
    if env:
        merged.update(env)
    result = subprocess.run(
        [str(a) for a in args],
        cwd=cwd,
        env=merged,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if check and result.returncode != 0:
        raise AssertionError(f"{args} failed: {result.stdout}{result.stderr}")
    return result


class Workspace:
    """A repository-root-like directory with a built GUI binary and launchers."""

    def __init__(self, test):
        self.root = Path(tempfile.mkdtemp(prefix="pohunek-packaging-"))
        test.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.bindir = self.root / "bin"
        self.out = self.root / "dist"
        self.launchers = self.root / "launchers"
        for directory in (self.bindir, self.out, self.launchers):
            directory.mkdir(parents=True)
        path = self.bindir / "pohunek-gui"
        path.write_text("#!/bin/sh\nexit 0\n")
        path.chmod(0o755)
        for member in LAUNCHER_FILES:
            file = self.launchers / member
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("#!/bin/sh\n" if "/" not in member else "text\n")
            file.chmod(0o755)
        (self.root / "README.md").write_text("readme\n")
        (self.root / "LICENSES").mkdir()
        (self.root / "LICENSES" / "pohunek-core-MIT.txt").write_text("license\n")
        (self.root / "packaging").mkdir()
        shutil.copy(PACKAGING / "verify-archive", self.root / "packaging")

    def stage(self, component, target=TARGET, input_dir=None):
        if input_dir is None:
            input_dir = self.launchers if component == "launchers" else self.bindir
        result = run(
            [PACKAGING / "stage-archive", component, VERSION, target, input_dir, self.out],
            cwd=self.root,
        )
        return result.stdout.strip()


def plugin_workspace(test):
    ws = Workspace(test)
    for member in PLUGIN_LAUNCHER_FILES:
        file = ws.launchers / member
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text("text\n")
    for member in PLUGIN_FILES:
        file = ws.root / member
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text("text\n")
    (ws.root / "plugin" / "tests").mkdir()
    (ws.root / "plugin" / "tests" / "list.test.ts").write_text("x\n")
    (ws.root / "plugin" / "bun.lock").write_text("x\n")
    (ws.root / "plugin" / "docs").mkdir()
    (ws.root / "plugin" / "docs" / "rfc.md").write_text("x\n")
    return ws


class StageArchiveTest(unittest.TestCase):
    def test_gui_archive_holds_the_binary_the_readme_and_the_licenses(self):
        ws = Workspace(self)
        name = ws.stage("gui")
        self.assertEqual(name, f"pohunek-gui-{VERSION}-{TARGET}")
        staging = ws.out / name
        for member in ("pohunek-gui", "README.md", "LICENSES/pohunek-core-MIT.txt"):
            self.assertTrue((staging / member).is_file(), member)
        self.assertFalse((staging / "docs").exists())

    def test_macos_gui_archive_holds_the_app_bundle(self):
        ws = Workspace(self)
        app = ws.bindir / "Pohunek.app" / "Contents" / "MacOS"
        app.mkdir(parents=True)
        (app / "pohunek-gui").write_text("binary\n")
        staging = ws.out / ws.stage("gui", "aarch64-apple-darwin")
        self.assertTrue((staging / "Pohunek.app/Contents/MacOS/pohunek-gui").is_file())
        self.assertFalse((staging / "pohunek-gui").exists())

    def test_macos_gui_archive_without_a_bundle_is_refused(self):
        ws = Workspace(self)
        result = run(
            [PACKAGING / "stage-archive", "gui", VERSION, "aarch64-apple-darwin", ws.bindir, ws.out],
            cwd=ws.root,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("built app bundle is missing", result.stderr)

    def test_launchers_archive_holds_the_scripts_templates_and_guides_only(self):
        ws = Workspace(self)
        (ws.launchers / "package.json").write_text("{}\n")
        (ws.launchers / "tests").mkdir()
        (ws.launchers / "tests" / "helpers.ts").write_text("x\n")
        name = ws.stage("launchers", "noarch")
        self.assertEqual(name, f"pohunek-launchers-{VERSION}-noarch")
        staging = ws.out / name
        for member in LAUNCHER_FILES + ("README.md", "LICENSES/pohunek-core-MIT.txt"):
            self.assertTrue((staging / member).is_file(), member)
        self.assertTrue(os.access(staging / "pohunek-rofi", os.X_OK))
        self.assertFalse((staging / "package.json").exists())
        self.assertFalse((staging / "tests").exists())

    def test_plugin_archive_keeps_the_plugin_and_launchers_sibling_layout(self):
        ws = plugin_workspace(self)
        name = ws.stage("plugin", "noarch", ws.root)
        self.assertEqual(name, f"pohunek-work-plugin-{VERSION}-noarch")
        staging = ws.out / name
        members = PLUGIN_FILES + tuple(f"launchers/{m}" for m in PLUGIN_LAUNCHER_FILES)
        for member in members + ("README.md", "LICENSES/pohunek-core-MIT.txt"):
            self.assertTrue((staging / member).is_file(), member)
        for absent in ("plugin/tests", "plugin/bun.lock", "plugin/docs", "launchers/docs", "packaging"):
            self.assertFalse((staging / absent).exists(), absent)

    def test_a_missing_plugin_input_is_refused(self):
        ws = plugin_workspace(self)
        (ws.launchers / "templates" / "sway-issue-binding.conf.tmpl").unlink()
        result = run(
            [PACKAGING / "stage-archive", "plugin", VERSION, "noarch", ws.root, ws.out],
            cwd=ws.root,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("required input file is missing", result.stderr)
        shutil.rmtree(ws.root / "plugin" / "src")
        result = run(
            [PACKAGING / "stage-archive", "plugin", VERSION, "noarch", ws.root, ws.out],
            cwd=ws.root,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)

    def test_the_real_plugin_archive_resolves_every_relative_import(self):
        out = Path(tempfile.mkdtemp(prefix="pohunek-plugin-stage-"))
        self.addCleanup(shutil.rmtree, out, ignore_errors=True)
        name = run([PACKAGING / "stage-archive", "plugin", VERSION, "noarch", ROOT, out], cwd=ROOT).stdout.strip()
        staging = out / name
        statement = re.compile(r"""(?:from|import\()\s*["'](\.{1,2}/[^"']+)["']""")
        checked = 0
        for source in sorted((ROOT / "plugin" / "src").rglob("*.ts")):
            for target in statement.findall(source.read_text()):
                resolved = (source.parent / target).resolve()
                found = [c for c in (resolved, resolved.with_name(resolved.name + ".ts"), resolved / "index.ts") if c.is_file()]
                self.assertTrue(found, f"{source}: {target} does not exist in the repository")
                self.assertTrue((staging / found[0].relative_to(ROOT)).is_file(), f"{source}: {target} is not in the archive")
                checked += 1
        self.assertGreater(checked, 0)

    def test_a_missing_launcher_file_is_refused(self):
        ws = Workspace(self)
        (ws.launchers / "lib.sh").unlink()
        result = run(
            [PACKAGING / "stage-archive", "launchers", VERSION, "noarch", ws.launchers, ws.out],
            cwd=ws.root,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("required input file is missing", result.stderr)

    def test_web_archive_wraps_the_input_tree_with_the_verifier_and_the_licenses(self):
        ws = Workspace(self)
        web = ws.root / "web-input"
        (web / "frontend").mkdir(parents=True)
        (web / "pohunek-web").write_text("binary\n")
        (web / "frontend" / "index.html").write_text("<html></html>\n")
        (web / "install.sh").write_text("#!/bin/sh\n")
        (web / "README.md").write_text("installer guide\n")
        name = ws.stage("web", "aarch64-apple-darwin", web)
        self.assertEqual(name, "pohunek-web-%s-aarch64-apple-darwin" % VERSION)
        staging = ws.out / name
        for member in (
            "pohunek-web",
            "frontend/index.html",
            "install.sh",
            "packaging/verify-archive",
            "LICENSES/pohunek-core-MIT.txt",
        ):
            self.assertTrue((staging / member).is_file(), member)
        self.assertEqual((staging / "README.md").read_text(), "installer guide\n")

    def test_the_output_directory_is_created_when_missing(self):
        ws = Workspace(self)
        out = ws.root / "fresh" / "dist"
        run(
            [PACKAGING / "stage-archive", "gui", VERSION, TARGET, ws.bindir, out],
            cwd=ws.root,
        )
        self.assertTrue((out / ("pohunek-gui-%s-%s" % (VERSION, TARGET)) / "pohunek-gui").is_file())

    def test_a_missing_binary_or_bad_argument_is_refused(self):
        ws = Workspace(self)
        (ws.bindir / "pohunek-gui").unlink()
        result = run(
            [PACKAGING / "stage-archive", "gui", VERSION, TARGET, ws.bindir, ws.out],
            cwd=ws.root,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("required input file is missing", result.stderr)
        for args in (("cli", VERSION, TARGET), ("gui", "1.2", TARGET), ("gui", VERSION, "X/Y")):
            result = run(
                [PACKAGING / "stage-archive", *args, ws.bindir, ws.out],
                cwd=ws.root,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0, args)

    def test_a_run_outside_the_repository_root_is_refused(self):
        ws = Workspace(self)
        (ws.root / "LICENSES" / "pohunek-core-MIT.txt").unlink()
        (ws.root / "LICENSES").rmdir()
        result = run(
            [PACKAGING / "stage-archive", "gui", VERSION, TARGET, ws.bindir, ws.out],
            cwd=ws.root,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("LICENSES", result.stderr)


class WriteManifestTest(unittest.TestCase):
    def manifest(self, ws, name, *args, check=True):
        return run(
            [PACKAGING / "write-manifest", ws.out / name, *args],
            check=check,
        )

    def test_manifest_lists_every_file_with_its_digest(self):
        ws = Workspace(self)
        name = ws.stage("gui")
        self.manifest(ws, name, "gui", VERSION, TARGET, "none")
        lines = (ws.out / name / "MANIFEST").read_text().splitlines()
        self.assertEqual(
            lines[:5],
            [
                "pohunek-archive-manifest 1",
                "component gui",
                f"version {VERSION}",
                f"target {TARGET}",
                "signing none",
            ],
        )
        entries = {}
        for line in lines[5:]:
            tag, digest, path = line.split(" ", 2)
            self.assertEqual(tag, "sha256")
            entries[path] = digest
        paths = list(entries)
        self.assertEqual(paths, sorted(paths))
        self.assertNotIn("MANIFEST", entries)
        for path, digest in entries.items():
            data = (ws.out / name / path).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), digest, path)
        self.assertIn("pohunek-gui", entries)

    def test_darwin_manifest_records_the_minimum_os(self):
        ws = Workspace(self)
        name = ws.stage("gui")
        self.manifest(ws, name, "gui", VERSION, "aarch64-apple-darwin", "unsigned-development", "14.0")
        text = (ws.out / name / "MANIFEST").read_text()
        self.assertIn("signing unsigned-development\n", text)
        self.assertIn("minimum-macos 14.0\n", text)

    def test_an_adhoc_manifest_records_the_signing_state(self):
        ws = Workspace(self)
        name = ws.stage("gui")
        self.manifest(ws, name, "gui", VERSION, "aarch64-apple-darwin", "adhoc", "14.0")
        text = (ws.out / name / "MANIFEST").read_text()
        self.assertIn("signing adhoc\n", text)
        self.assertIn("minimum-macos 14.0\n", text)

    def test_signing_states_that_no_tool_produces_are_refused(self):
        ws = Workspace(self)
        name = ws.stage("gui")
        for state in ("developer-id", "notarized"):
            result = self.manifest(ws, name, "gui", VERSION, "aarch64-apple-darwin", state, "14.0", check=False)
            self.assertNotEqual(result.returncode, 0, state)
            self.assertIn("unsupported signing state", result.stderr)
        self.assertFalse((ws.out / name / "MANIFEST").exists())

    def test_invalid_input_is_refused_and_leaves_no_manifest(self):
        ws = Workspace(self)
        name = ws.stage("gui")
        for args, message in (
            (("gui", VERSION, "aarch64-apple-darwin", "none"), "needs <minimum-macos>"),
            (("gui", VERSION, TARGET, "none", "14.0"), "applies only to an apple-darwin"),
            (("gui", "1.2", TARGET, "none"), "version must be"),
            (("gui", VERSION, TARGET, "signed"), "unsupported signing state"),
            (("nope", VERSION, TARGET, "none"), "unsupported component"),
        ):
            result = self.manifest(ws, name, *args, check=False)
            self.assertNotEqual(result.returncode, 0, args)
            self.assertIn(message, result.stderr)
        self.assertFalse((ws.out / name / "MANIFEST").exists())
        self.assertFalse((ws.out / name / "MANIFEST.tmp").exists())

    def test_symlinks_and_unsafe_names_are_refused(self):
        ws = Workspace(self)
        name = ws.stage("gui")
        link = ws.out / name / "link"
        link.symlink_to("pohunek-gui")
        result = self.manifest(ws, name, "gui", VERSION, TARGET, "none", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("symbolic link", result.stderr)
        link.unlink()
        (ws.out / name / "bad name").write_text("x")
        result = self.manifest(ws, name, "gui", VERSION, TARGET, "none", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsupported character", result.stderr)

    def test_rewriting_replaces_the_previous_manifest(self):
        ws = Workspace(self)
        name = ws.stage("gui")
        self.manifest(ws, name, "gui", VERSION, TARGET, "none")
        first = (ws.out / name / "MANIFEST").read_text()
        self.manifest(ws, name, "gui", VERSION, TARGET, "none")
        self.assertEqual((ws.out / name / "MANIFEST").read_text(), first)


class CoreVersionTest(unittest.TestCase):
    def manifest(self, ws, name, core, *, check=True):
        return run(
            [PACKAGING / "write-manifest", "--core", core, ws.out / name, "gui", VERSION, TARGET, "none"],
            check=check,
        )

    def test_the_manifest_records_a_core_tag_or_commit_after_the_signing_state(self):
        for core in (CORE_REF, CORE_COMMIT):
            ws = Workspace(self)
            name = ws.stage("gui")
            self.manifest(ws, name, core)
            lines = (ws.out / name / "MANIFEST").read_text().splitlines()
            self.assertEqual(lines[4:6], ["signing none", f"core {core}"])

    def test_a_manifest_without_the_option_has_no_core_line(self):
        ws = Workspace(self)
        name = ws.stage("gui")
        run([PACKAGING / "write-manifest", ws.out / name, "gui", VERSION, TARGET, "none"])
        self.assertNotIn("\ncore ", (ws.out / name / "MANIFEST").read_text())

    def test_a_malformed_core_version_is_refused(self):
        ws = Workspace(self)
        name = ws.stage("gui")
        for core in ("", "main", "v1.2", "v1.2.x", CORE_COMMIT[:39], CORE_COMMIT.upper(), "../v1.2.3"):
            result = self.manifest(ws, name, core, check=False)
            self.assertNotEqual(result.returncode, 0, core)
            self.assertIn("core ref must be", result.stderr)
        self.assertFalse((ws.out / name / "MANIFEST").exists())
        result = run([PACKAGING / "write-manifest", "--core"], check=False)
        self.assertNotEqual(result.returncode, 0)


@unittest.skipUnless(
    (os.uname().sysname, os.uname().machine) == ("Linux", "x86_64"),
    "verify-archive accepts Linux x86_64 and macOS arm64 hosts only",
)
class VerifyArchiveTest(unittest.TestCase):
    def extract(self, core):
        ws = Workspace(self)
        name = ws.stage("web", TARGET, ws.launchers)
        args = ["--core", core] if core else []
        run([PACKAGING / "write-manifest", *args, ws.out / name, "web", VERSION, TARGET, "none"])
        run([PACKAGING / "archive", ws.out, name, ws.out], env={"SOURCE_DATE_EPOCH": EPOCH})
        home = Path(tempfile.mkdtemp(prefix="pohunek-verify-"))
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)
        with tarfile.open(ws.out / f"{name}.tar.gz") as tar:
            tar.extractall(home)
        return home / name

    def verify(self, directory):
        return run([directory / "packaging" / "verify-archive", directory, "web", "lib.sh"], check=False)

    def test_a_manifest_with_a_valid_core_version_verifies(self):
        for core in (CORE_REF, CORE_COMMIT, None):
            directory = self.extract(core)
            result = self.verify(directory)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_an_unlisted_file_is_refused(self):
        for relative in ("extra", "templates/extra.js"):
            directory = self.extract(CORE_REF)
            (directory / relative).write_text("x")
            result = self.verify(directory)
            self.assertEqual(result.returncode, 1, relative)
            self.assertIn("does not list: " + relative, result.stderr)

    def test_a_missing_listed_file_is_refused(self):
        directory = self.extract(CORE_REF)
        (directory / "templates" / "launcher.conf").unlink()
        result = self.verify(directory)
        self.assertEqual(result.returncode, 1)
        self.assertIn("missing or not a regular file: templates/launcher.conf", result.stderr)

    def test_a_special_file_is_refused(self):
        directory = self.extract(CORE_REF)
        os.mkfifo(directory / "pipe")
        result = self.verify(directory)
        self.assertEqual(result.returncode, 1)
        self.assertIn("special file", result.stderr)

    def test_a_manifest_with_a_malformed_core_version_is_refused(self):
        directory = self.extract(CORE_REF)
        manifest = directory / "MANIFEST"
        manifest.write_text(manifest.read_text().replace(f"core {CORE_REF}\n", "core not-a-version\n"))
        result = self.verify(directory)
        self.assertEqual(result.returncode, 1)
        self.assertIn("invalid core version", result.stderr)


class MakeArchiveTest(unittest.TestCase):
    def make(self, ws, component, target, input_dir, **env):
        merged = {"SOURCE_DATE_EPOCH": EPOCH, "POHUNEK_CORE_REF": CORE_REF}
        merged.update(env)
        return run(
            [PACKAGING / "make-archive", component, VERSION, target, input_dir, ws.out],
            cwd=ws.root,
            env=merged,
            check=False,
        )

    def test_it_stages_seals_and_archives_with_a_matching_checksum(self):
        ws = Workspace(self)
        result = self.make(ws, "launchers", "noarch", ws.launchers)
        self.assertEqual(result.returncode, 0, result.stderr)
        name = f"pohunek-launchers-{VERSION}-noarch"
        archive = Path(result.stdout.strip())
        self.assertEqual(archive, ws.out / f"{name}.tar.gz")
        checksum = (ws.out / f"{name}.tar.gz.sha256").read_text()
        self.assertEqual(checksum, f"{hashlib.sha256(archive.read_bytes()).hexdigest()}  {name}.tar.gz\n")
        with tarfile.open(archive) as tar:
            manifest = tar.extractfile(f"{name}/MANIFEST").read().decode()
            names = tar.getnames()
        self.assertIn(f"core {CORE_REF}\n", manifest)
        self.assertIn("component launchers\n", manifest)
        self.assertIn(f"{name}/pohunek-rofi", names)

    def test_a_plugin_archive_is_sealed_with_the_plugin_component(self):
        ws = plugin_workspace(self)
        result = self.make(ws, "plugin", "noarch", ws.root)
        self.assertEqual(result.returncode, 0, result.stderr)
        name = f"pohunek-work-plugin-{VERSION}-noarch"
        archive = Path(result.stdout.strip())
        self.assertEqual(archive, ws.out / f"{name}.tar.gz")
        with tarfile.open(archive) as tar:
            manifest = tar.extractfile(f"{name}/MANIFEST").read().decode()
            names = tar.getnames()
        self.assertIn("component plugin\n", manifest)
        self.assertIn("target noarch\n", manifest)
        self.assertIn(f"core {CORE_REF}\n", manifest)
        self.assertIn(f"{name}/plugin/src/main.ts", names)
        check = run(
            [PACKAGING / "check-archive", archive, "--component", "plugin", "--version", VERSION,
             "--target", "noarch", "--core", CORE_REF],
            check=False,
        )
        self.assertEqual(check.returncode, 0, check.stderr)

    def test_the_archive_is_reproducible(self):
        first, second = Workspace(self), Workspace(self)
        a = Path(self.make(first, "gui", TARGET, first.bindir).stdout.strip()).read_bytes()
        b = Path(self.make(second, "gui", TARGET, second.bindir).stdout.strip()).read_bytes()
        self.assertEqual(a, b)

    def test_a_missing_core_pin_is_refused_and_leaves_no_archive(self):
        ws = Workspace(self)
        env = {k: v for k, v in os.environ.items() if k != "POHUNEK_CORE_REF"}
        result = subprocess.run(
            [str(PACKAGING / "make-archive"), "gui", VERSION, TARGET, str(ws.bindir), str(ws.out)],
            cwd=ws.root,
            env=dict(env, SOURCE_DATE_EPOCH=EPOCH),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("POHUNEK_CORE_REF", result.stderr)
        self.assertEqual(list(ws.out.iterdir()), [])


class HashFailureTest(unittest.TestCase):
    """A hashing tool that fails or prints garbage never yields an entry."""

    def shims(self, body):
        root = Path(tempfile.mkdtemp(prefix="pohunek-hash-"))
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        for name in ("sha256sum", "shasum"):
            path = root / name
            path.write_text("#!/bin/sh\n" + body)
            path.chmod(0o755)
        return {"PATH": "%s:%s" % (root, os.environ["PATH"])}

    def test_a_failing_hash_tool_fails_the_manifest_and_the_archive(self):
        ws = Workspace(self)
        name = ws.stage("gui")
        for body in ("exit 3\n", "echo not-a-digest file\n"):
            env = self.shims(body)
            result = run(
                [PACKAGING / "write-manifest", ws.out / name, "gui", VERSION, TARGET, "none"],
                env=env,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0, body)
            self.assertFalse((ws.out / name / "MANIFEST").exists())
        run([PACKAGING / "write-manifest", ws.out / name, "gui", VERSION, TARGET, "none"])
        result = run(
            [PACKAGING / "archive", ws.out, name, ws.out],
            env=dict(self.shims("exit 3\n"), SOURCE_DATE_EPOCH=EPOCH),
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((ws.out / (name + ".tar.gz.sha256")).exists())


class ArchiveTest(unittest.TestCase):
    def build(self, ws, name, out, umask=0o022, epoch=EPOCH):
        out.mkdir(exist_ok=True)
        previous = os.umask(umask)
        try:
            run(
                [PACKAGING / "archive", ws.out, name, out],
                env={"SOURCE_DATE_EPOCH": epoch},
            )
        finally:
            os.umask(previous)
        return out / f"{name}.tar.gz"

    def test_equal_trees_give_byte_identical_archives_whatever_the_host_state(self):
        first = Workspace(self)
        name = first.stage("gui")
        run([PACKAGING / "write-manifest", first.out / name, "gui", VERSION, TARGET, "none"])
        second = Workspace(self)
        second.stage("gui")
        run([PACKAGING / "write-manifest", second.out / name, "gui", VERSION, TARGET, "none"])
        # Different file times and modes on the way in must not show.
        for path in (second.out / name).rglob("*"):
            os.utime(path, (1_000_000_000, 1_000_000_000))
        (second.out / name / "README.md").chmod(0o600)
        a = self.build(first, name, first.root / "a", umask=0o022)
        b = self.build(second, name, second.root / "b", umask=0o077)
        self.assertEqual(a.read_bytes(), b.read_bytes())
        self.assertEqual(
            (a.parent / f"{name}.tar.gz.sha256").read_text(),
            f"{hashlib.sha256(a.read_bytes()).hexdigest()}  {name}.tar.gz\n",
        )

    def test_members_are_sorted_root_owned_dated_and_mode_normalized(self):
        ws = Workspace(self)
        name = ws.stage("gui")
        archive = self.build(ws, name, ws.root / "o")
        with tarfile.open(archive) as tar:
            members = tar.getmembers()
        names = [m.name for m in members]
        self.assertEqual(names, sorted(names))
        self.assertEqual(names[0], name)
        for member in members:
            self.assertEqual((member.uid, member.gid), (0, 0), member.name)
            self.assertEqual(member.mtime, int(EPOCH), member.name)
            if member.isdir():
                self.assertEqual(member.mode, 0o755, member.name)
        modes = {m.name.rsplit("/", 1)[-1]: m.mode for m in members if m.isfile()}
        self.assertEqual(modes["pohunek-gui"], 0o755)
        self.assertEqual(modes["README.md"], 0o644)
        # No AppleDouble or extended-header members.
        self.assertFalse([n for n in names if "/._" in n or "PaxHeaders" in n])

    def test_relative_arguments_mean_the_callers_directory(self):
        # The release workflow calls `archive dist "$name" dist` from the
        # repository root.
        ws = Workspace(self)
        name = ws.stage("gui")
        run([PACKAGING / "write-manifest", ws.out / name, "gui", VERSION, TARGET, "none"])
        run(
            [PACKAGING / "archive", "dist", name, "dist"],
            cwd=ws.root,
            env={"SOURCE_DATE_EPOCH": EPOCH},
        )
        self.assertTrue((ws.root / "dist" / (name + ".tar.gz")).is_file())
        self.assertTrue((ws.root / "dist" / (name + ".tar.gz.sha256")).is_file())
        self.assertFalse((ws.root / "dist" / "dist").exists())

    def test_the_output_directory_is_created_when_missing(self):
        ws = Workspace(self)
        name = ws.stage("gui")
        out = ws.root / "new" / "out"
        run([PACKAGING / "archive", ws.out, name, out], env={"SOURCE_DATE_EPOCH": EPOCH})
        self.assertTrue((out / (name + ".tar.gz")).is_file())

    def test_a_different_commit_time_changes_the_archive(self):
        ws = Workspace(self)
        name = ws.stage("gui")
        a = self.build(ws, name, ws.root / "a").read_bytes()
        b = self.build(ws, name, ws.root / "b", epoch="1700000001").read_bytes()
        self.assertNotEqual(a, b)

    def test_a_missing_epoch_or_bad_name_is_refused(self):
        ws = Workspace(self)
        name = ws.stage("gui")
        env = {k: v for k, v in os.environ.items() if k != "SOURCE_DATE_EPOCH"}
        result = subprocess.run(
            [str(PACKAGING / "archive"), str(ws.out), name, str(ws.out)],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SOURCE_DATE_EPOCH", result.stderr)
        result = run(
            [PACKAGING / "archive", ws.out, "../x", ws.out],
            env={"SOURCE_DATE_EPOCH": EPOCH},
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
