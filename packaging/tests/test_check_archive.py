"""Regression checks for `packaging/check-archive` (stdlib only)."""

import hashlib
import io
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

from test_packaging import CORE_REF, EPOCH, PACKAGING, TARGET, VERSION, Workspace, run


class CheckArchiveTest(unittest.TestCase):
    def build(self, component="web", target=TARGET):
        ws = Workspace(self)
        name = run(
            [PACKAGING / "make-archive", component, VERSION, target, ws.web if component == "web" else ws.launchers, ws.out],
            cwd=ws.root,
            env={"SOURCE_DATE_EPOCH": EPOCH, "POHUNEK_CORE_REF": CORE_REF},
        ).stdout.strip()
        return ws, Path(name)

    def check(self, archive, *extra, component="web"):
        return subprocess.run(
            [str(PACKAGING / "check-archive"), str(archive), "--component", component, "--version", VERSION, *extra],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    def rewrite(self, archive, edit):
        """Rebuilds the archive with `edit(members: dict name -> bytes)` applied."""
        with tarfile.open(archive) as tar:
            members = {m.name: tar.extractfile(m).read() for m in tar.getmembers() if m.isfile()}
        edit(members)
        with tarfile.open(archive, "w:gz") as tar:
            for name, data in members.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))

    def refresh_checksum(self, archive):
        Path(f"{archive}.sha256").write_text(f"{hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}\n")

    def test_a_fresh_archive_passes_with_every_expectation(self):
        _, archive = self.build()
        result = self.check(archive, "--target", TARGET, "--signing", "none", "--core", CORE_REF)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("member(s) verified", result.stdout)

    def test_the_launchers_archive_passes(self):
        _, archive = self.build("launchers", "noarch")
        self.assertEqual(self.check(archive, "--target", "noarch", component="launchers").returncode, 0)

    def test_a_wrong_expectation_fails(self):
        _, archive = self.build()
        for extra, message in (
            (("--core", "v9.9.9"), "MANIFEST core"),
            (("--target", "aarch64-apple-darwin"), "MANIFEST target"),
            (("--signing", "adhoc"), "MANIFEST signing"),
        ):
            result = self.check(archive, *extra)
            self.assertEqual(result.returncode, 1, extra)
            self.assertIn(message, result.stderr)
        result = self.check(archive, component="launchers")
        self.assertIn("MANIFEST component", result.stderr)

    def test_an_adhoc_archive_passes_only_when_adhoc_is_expected(self):
        _, archive = self.build()
        key = f"{archive.name[: -len('.tar.gz')]}/MANIFEST"
        self.rewrite(archive, lambda m: m.update({key: m[key].replace(b"signing none\n", b"signing adhoc\n")}))
        self.refresh_checksum(archive)
        ok = self.check(archive, "--signing", "adhoc")
        self.assertEqual(ok.returncode, 0, ok.stderr)
        for extra in ((), ("--signing", "none")):
            result = self.check(archive, *extra)
            self.assertEqual(result.returncode, 1, extra)
            self.assertIn("MANIFEST signing", result.stderr)

    def test_signing_states_other_than_none_and_adhoc_are_not_accepted(self):
        _, archive = self.build()
        for state in ("developer-id", "notarized", "unsigned-development"):
            result = self.check(archive, "--signing", state)
            self.assertEqual(result.returncode, 2, state)

    def test_a_missing_or_wrong_checksum_fails(self):
        _, archive = self.build()
        Path(f"{archive}.sha256").write_text("0" * 64 + f"  {archive.name}\n")
        self.assertIn("does not match", self.check(archive).stderr)
        Path(f"{archive}.sha256").unlink()
        self.assertIn("missing checksum file", self.check(archive).stderr)

    def test_a_modified_member_fails_even_with_a_fresh_checksum(self):
        _, archive = self.build()
        name = archive.name[: -len(".tar.gz")]
        self.rewrite(archive, lambda members: members.__setitem__(f"{name}/pohunek-web", b"tampered"))
        self.refresh_checksum(archive)
        result = self.check(archive)
        self.assertEqual(result.returncode, 1)
        self.assertIn("digest mismatch: pohunek-web", result.stderr)

    def test_an_unlisted_member_fails(self):
        _, archive = self.build()
        name = archive.name[: -len(".tar.gz")]
        self.rewrite(archive, lambda members: members.__setitem__(f"{name}/extra", b"x"))
        self.refresh_checksum(archive)
        self.assertIn("missing from the MANIFEST: " + name + "/extra", self.check(archive).stderr)

    def test_unsafe_member_paths_fail(self):
        for bad in ("../escape", "/abs", "other/file"):
            _, archive = self.build()
            self.rewrite(archive, lambda members, bad=bad: members.__setitem__(bad, b"x"))
            self.refresh_checksum(archive)
            self.assertEqual(self.check(archive).returncode, 1, bad)

    def test_a_symbolic_link_member_fails(self):
        _, archive = self.build()
        name = archive.name[: -len(".tar.gz")]
        with tarfile.open(archive) as tar:
            members = [(m, tar.extractfile(m).read() if m.isfile() else None) for m in tar.getmembers()]
        with tarfile.open(archive, "w:gz") as tar:
            for member, data in members:
                tar.addfile(member, io.BytesIO(data) if data is not None else None)
            link = tarfile.TarInfo(f"{name}/link")
            link.type = tarfile.SYMTYPE
            link.linkname = "pohunek-web"
            tar.addfile(link)
        self.refresh_checksum(archive)
        self.assertIn("neither a file nor a directory", self.check(archive).stderr)

    def test_an_archive_without_a_manifest_fails(self):
        _, archive = self.build()
        name = archive.name[: -len(".tar.gz")]
        self.rewrite(archive, lambda members: members.pop(f"{name}/MANIFEST"))
        self.refresh_checksum(archive)
        self.assertIn("no MANIFEST", self.check(archive).stderr)

    def test_a_file_that_is_not_a_targz_fails(self):
        directory = Path(tempfile.mkdtemp(prefix="pohunek-check-"))
        self.addCleanup(shutil.rmtree, directory, ignore_errors=True)
        junk = directory / "pohunek-web-1.2.3-x.tar.gz"
        junk.write_text("not a tarball")
        self.refresh_checksum(junk)
        self.assertEqual(self.check(junk).returncode, 1)
        self.assertEqual(self.check(directory / "other.zip").returncode, 1)


if __name__ == "__main__":
    unittest.main()
