"""Regression checks for the macOS ad-hoc signing tooling (stdlib only).

The tools need a Mac, so these tests run them against a `codesign` shim that
records arguments and prints canned output. They prove that each Mach-O file is
signed ad-hoc with a stable identifier and no certificate, runtime flag,
timestamp, or entitlement. The real `codesign` runs in the macOS CI job.
"""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
MACOS = ROOT / "packaging" / "macos"
CORE_REF = "v0.31.6"

MACHO = bytes.fromhex("cffaedfe") + b"\0" * 12
BUNDLE_ID = "org.example.tool"

ADHOC_DETAILS = """Executable=/x/pohunek
Identifier=io.github.zajca.pohunek.pohunek
Format=Mach-O thin (arm64)
CodeDirectory v=20400 size=900 flags=0x2(adhoc) hashes=20+7 location=embedded
Signature=adhoc
TeamIdentifier=not set
"""

CERTIFICATE_DETAILS = """Executable=/x/pohunek
Identifier=io.github.zajca.pohunek.pohunek
Format=Mach-O thin (arm64)
CodeDirectory v=20500 size=900 flags=0x10000(runtime) hashes=20+7 location=embedded
Authority=Certificate Authority Example
Authority=Root Example
Timestamp=Oct 1, 2026 at 10:00:00
TeamIdentifier=ABCDE12345
"""

# Records every call as one line; prints canned output chosen by environment
# variables the test sets. SHIM_CODESIGN_VERIFY_FAILS names a path whose
# verification fails; unset means every verification passes.
CODESIGN = """#!/bin/sh
printf 'codesign %s\\n' "$*" >> "$SHIM_LOG"
for arg in "$@"; do
  if [ "$arg" = -dvv ]; then
    for last; do :; done
    case "$last" in
      *"${SHIM_CODESIGN_UNDESCRIBABLE:-@@none@@}") exit 1 ;;
      *"${SHIM_CODESIGN_CERTIFICATE_FOR:-@@none@@}") cat "$SHIM_CODESIGN_CERTIFICATE_DETAILS" >&2 ;;
      *) cat "$SHIM_CODESIGN_DETAILS" >&2 ;;
    esac
    exit 0
  fi
done
case " $* " in
  *" --verify "*)
    for last; do :; done
    case "$last" in
      *"${SHIM_CODESIGN_VERIFY_FAILS:-@@none@@}") echo "$last: invalid signature" >&2; exit 1 ;;
    esac
    exit 0 ;;
esac
exit 0
"""

PLUTIL = """#!/usr/bin/env python3
import re, sys
key, file = sys.argv[2], sys.argv[-1]
match = re.search(r"<key>%s</key>\\s*<string>(.*?)</string>" % re.escape(key), open(file).read(), re.S)
if not match:
    sys.exit(1)
print(match.group(1))
"""

INFO_PLIST = "<plist><dict><key>CFBundleIdentifier</key><string>%s</string></dict></plist>" % BUNDLE_ID


def write_shim(directory, name, text):
    path = directory / name
    path.write_text(text)
    path.chmod(0o755)


class Base(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="pohunek-signing-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.tools = self.root / "tools"
        self.tools.mkdir()
        for name, text in (("codesign", CODESIGN), ("plutil", PLUTIL)):
            write_shim(self.tools, name, text)
        self.log = self.root / "shim.log"
        self.log.write_text("")
        self.details = self.root / "details.txt"
        self.details.write_text(ADHOC_DETAILS)
        self.certificate_details = self.root / "certificate-details.txt"
        self.certificate_details.write_text(CERTIFICATE_DETAILS)
        self.staging = self.root / "staging"
        self.staging.mkdir()

    def env(self, **extra):
        env = {
            "PATH": "{}:{}".format(self.tools, os.environ["PATH"]),
            "SHIM_LOG": str(self.log),
            "SHIM_CODESIGN_DETAILS": str(self.details),
            "SHIM_CODESIGN_CERTIFICATE_DETAILS": str(self.certificate_details),
            "TMPDIR": str(self.root),
        }
        env.update(extra)
        return env

    def run_tool(self, name, *args, env=None):
        full = dict(self.env(), **(env or {}))
        return subprocess.run(
            [str(MACOS / name), *map(str, args)],
            env=full,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    def calls(self, prefix=""):
        return [line for line in self.log.read_text().splitlines() if line.startswith(prefix)]

    def macho(self, relative):
        path = self.staging / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(MACHO)
        path.chmod(0o755)
        return path


    def app(self):
        self.macho("Example.app/Contents/MacOS/example-tool")
        (self.staging / "Example.app/Contents/Info.plist").write_text(INFO_PLIST)
        return self.staging / "Example.app"


class SignTest(Base):
    def test_every_macho_is_signed_ad_hoc_with_a_stable_identifier_and_nothing_else(self):
        self.macho("pohunek")
        self.macho("pohunek-web")
        (self.staging / "README.md").write_text("text")
        result = self.run_tool("sign", self.staging)
        self.assertEqual(result.returncode, 0, result.stderr)
        signs = [c for c in self.calls("codesign") if "--sign" in c]
        self.assertEqual(len(signs), 2)
        for name in ("pohunek", "pohunek-web"):
            line = next(c for c in signs if c.endswith("/" + name))
            self.assertEqual(
                line,
                "codesign --force --sign - --identifier io.github.zajca.pohunek.%s %s" % (name, self.staging / name),
            )
        verifies = [c for c in self.calls("codesign") if "--verify --strict" in c]
        self.assertEqual(len(verifies), 2)

    def test_no_certificate_runtime_timestamp_or_entitlement_is_ever_requested(self):
        self.macho("pohunek-web")
        result = self.run_tool("sign", self.staging)
        self.assertEqual(result.returncode, 0, result.stderr)
        for call in self.calls("codesign"):
            for forbidden in ("--options", "--timestamp", "--entitlements", "--keychain"):
                self.assertNotIn(forbidden, call)
        for call in self.calls("codesign"):
            if "--sign" in call:
                self.assertIn("--sign -", call)
        text = (MACOS / "sign").read_text()
        for variable in ("MACOS_SIGNING_IDENTITY", "MACOS_SIGNING_KEYCHAIN"):
            self.assertNotIn(variable, text)

    def test_generic_bundle_signs_its_executable_before_the_bundle(self):
        app = self.app()
        self.macho("pohunek-web")
        result = self.run_tool("sign", self.staging)
        self.assertEqual(result.returncode, 0, result.stderr)
        signs = [c.split(" ")[-1] for c in self.calls("codesign") if "--sign" in c]
        self.assertEqual(signs, [str(self.staging / "pohunek-web"), str(app / "Contents/MacOS/example-tool"), str(app)])
        bundle = next(c for c in self.calls("codesign") if "--sign" in c and c.endswith(str(app)))
        self.assertEqual(bundle, "codesign --force --sign - --identifier %s %s" % (BUNDLE_ID, app))
        self.assertTrue(any("--verify --deep --strict" in c for c in self.calls("codesign")))
        self.assertFalse(any("--identifier" in c and c.endswith("example-tool") for c in self.calls("codesign")))

    def test_a_bundle_without_an_identifier_fails(self):
        app = self.app()
        (app / "Contents/Info.plist").write_text("<plist><dict/></plist>")
        result = self.run_tool("sign", self.staging)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("CFBundleIdentifier", result.stderr)
        self.assertFalse(any(c.endswith(str(app)) and "--sign" in c for c in self.calls("codesign")))

    def test_nothing_to_sign_fails(self):
        empty = self.root / "empty"
        empty.mkdir()
        result = self.run_tool("sign", empty)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("nothing to sign", result.stderr)
        self.assertEqual(self.calls("codesign"), [])

    def test_a_failed_verification_fails_the_signing(self):
        self.macho("pohunek")
        result = self.run_tool("sign", self.staging, env={"SHIM_CODESIGN_VERIFY_FAILS": "/pohunek"})
        self.assertNotEqual(result.returncode, 0)

    def test_a_bad_invocation_is_refused(self):
        self.assertNotEqual(self.run_tool("sign").returncode, 0)
        self.assertNotEqual(self.run_tool("sign", self.root / "missing").returncode, 0)


class VerifySignedTest(Base):
    def verify(self, *args, **env):
        return self.run_tool("verify-signed", *args, env=env)

    def test_an_ad_hoc_signed_tree_passes(self):
        self.macho("pohunek-web")
        self.app()
        result = self.verify("--adhoc", self.staging)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("2 ad-hoc signed item(s) verified", result.stdout)
        verifies = self.calls("codesign --verify")
        self.assertEqual(len(verifies), 2)
        self.assertTrue(any("--deep" in c and c.endswith("Example.app") for c in verifies))
        self.assertFalse(any("--deep" in c and c.endswith("/pohunek-web") for c in verifies))
        self.assertTrue(all("--strict" in c for c in verifies))

    def test_a_certificate_signature_is_rejected(self):
        self.macho("pohunek")
        result = self.verify("--adhoc", self.staging, SHIM_CODESIGN_CERTIFICATE_FOR="/pohunek")
        self.assertEqual(result.returncode, 1)
        self.assertIn("signed with a certificate, not ad-hoc", result.stderr)

    def test_an_authority_line_is_rejected_even_next_to_an_adhoc_marker(self):
        self.macho("pohunek")
        self.details.write_text(ADHOC_DETAILS + "Authority=Certificate Authority Example\n")
        result = self.verify("--adhoc", self.staging)
        self.assertEqual(result.returncode, 1)
        self.assertIn("signed with a certificate, not ad-hoc", result.stderr)

    def test_a_signature_that_is_not_ad_hoc_is_rejected(self):
        self.macho("pohunek")
        self.details.write_text(ADHOC_DETAILS.replace("Signature=adhoc\n", ""))
        result = self.verify("--adhoc", self.staging)
        self.assertEqual(result.returncode, 1)
        self.assertIn("not ad-hoc signed", result.stderr)

    def test_a_signature_that_does_not_verify_or_an_unsigned_file_is_rejected(self):
        self.macho("pohunek")
        result = self.verify("--adhoc", self.staging, SHIM_CODESIGN_VERIFY_FAILS="/pohunek")
        self.assertEqual(result.returncode, 1)
        self.assertIn("does not verify", result.stderr)
        self.assertIn("invalid signature", result.stderr)

    def test_an_undescribable_file_is_rejected(self):
        self.macho("pohunek")
        result = self.verify("--adhoc", self.staging, SHIM_CODESIGN_UNDESCRIBABLE="/pohunek")
        self.assertEqual(result.returncode, 1)
        self.assertIn("codesign cannot describe it", result.stderr)

    def test_a_broken_bundle_is_rejected(self):
        self.app()
        result = self.verify("--adhoc", self.staging, SHIM_CODESIGN_VERIFY_FAILS="Example.app")
        self.assertEqual(result.returncode, 1)
        self.assertIn("Example.app: code signature does not verify", result.stderr)

    def test_every_problem_is_reported_before_the_failure(self):
        self.macho("a-bad")
        self.macho("b-cert")
        self.macho("c-good")
        result = self.verify(
            "--adhoc",
            self.staging,
            SHIM_CODESIGN_VERIFY_FAILS="a-bad",
            SHIM_CODESIGN_CERTIFICATE_FOR="b-cert",
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL %s: code signature does not verify" % (self.staging / "a-bad"), result.stderr)
        self.assertIn("FAIL %s: signed with a certificate" % (self.staging / "b-cert"), result.stderr)
        self.assertIn("2 problem(s)", result.stderr)

    def test_the_adhoc_switch_is_required_and_other_options_are_refused(self):
        self.macho("pohunek")
        self.assertEqual(self.verify(self.staging).returncode, 2)
        for args in (
            ("--team-id", "ABCDE12345", self.staging),
            ("--notarized", "--adhoc", self.staging),
            ("--adhoc",),
            ("--adhoc", self.root / "missing"),
        ):
            self.assertEqual(self.verify(*args).returncode, 2, args)
        self.assertEqual(self.calls("codesign"), [])

    def test_a_tree_without_any_signable_item_is_not_a_pass(self):
        empty = self.root / "empty"
        empty.mkdir()
        (empty / "README.md").write_text("text")
        result = self.verify("--adhoc", empty)
        self.assertEqual(result.returncode, 1)
        self.assertIn("no Mach-O file or app bundle found", result.stderr)


class PackageReleaseTest(Base):
    def audit_tools(self):
        # The audit reads the tree through otool, lipo, and strings, which the
        # shims below answer for every file.
        audit_tools = self.root / "audit-tools"
        audit_tools.mkdir()
        for tool in ("otool", "lipo", "strings"):
            write_shim(
                audit_tools,
                tool,
                "#!/bin/sh\n"
                "case \"$1\" in\n"
                "  -archs) echo arm64 ;;\n"
                "  -l) printf 'Load command 1\\n      cmd LC_BUILD_VERSION\\n platform 1\\n    minos 14.0\\n' ;;\n"
                "  -L) printf 'x:\\n\\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\\n' ;;\n"
                "  -a) echo clean ;;\n"
                "esac\n",
            )
        return audit_tools

    def web_tree(self, name="pohunek-web-1.2.3-aarch64-apple-darwin"):
        staging = self.root / name
        staging.mkdir()
        program = staging / "pohunek-web"
        program.write_bytes(MACHO)
        program.chmod(0o755)
        (staging / "README.md").write_text("text\n")
        return staging

    def test_a_release_without_the_core_pin_fails_before_any_work(self):
        staging = self.root / "pohunek-web-1.2.3-aarch64-apple-darwin"
        staging.mkdir()
        for args in (
            ("--adhoc-release", "web", "1.2.3", staging),
            ("--stage-release", "web", "1.2.3", self.root, self.root),
        ):
            result = self.run_tool("package", *args)
            self.assertEqual(result.returncode, 1, args)
            self.assertIn("POHUNEK_CORE_REF is not set", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_a_development_tree_or_a_misnamed_tree_is_never_signed_as_a_release(self):
        for name in (
            "pohunek-web-1.2.3-aarch64-apple-darwin-unsigned-development",
            "pohunek-launchers-1.2.3-aarch64-apple-darwin",
        ):
            staging = self.root / name
            staging.mkdir()
            result = self.run_tool("package", "--adhoc-release", "web", "1.2.3", staging, env={"POHUNEK_CORE_REF": CORE_REF})
            self.assertEqual(result.returncode, 1, name)
            self.assertIn(
                "development staging" if name.endswith("development") else "unexpected staging directory name",
                result.stderr,
            )
        self.assertEqual(self.calls(), [])

    def test_the_old_signing_modes_and_their_options_are_gone(self):
        staging = self.root / "pohunek-web-1.2.3-aarch64-apple-darwin"
        staging.mkdir()
        result = self.run_tool("package", "--sign-release", "web", "1.2.3", staging, env={"POHUNEK_CORE_REF": CORE_REF})
        self.assertEqual(result.returncode, 1)
        self.assertIn("unsupported mode", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_the_release_step_audits_signs_verifies_and_archives_in_order_without_credentials(self):
        name = "pohunek-web-1.2.3-aarch64-apple-darwin"
        staging = self.web_tree(name)
        env = {
            "POHUNEK_CORE_REF": CORE_REF,
            "SOURCE_DATE_EPOCH": "1700000000",
            "PATH": "%s:%s:%s" % (self.audit_tools(), self.tools, os.environ["PATH"]),
        }
        result = self.run_tool("package", "--adhoc-release", "web", "1.2.3", staging, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        archive = Path(result.stdout.strip())
        self.assertEqual(archive, self.root / (name + ".tar.gz"))
        self.assertTrue(archive.is_file())
        checksum = (self.root / (name + ".tar.gz.sha256")).read_text()
        self.assertTrue(checksum.strip().endswith(name + ".tar.gz"))
        manifest = (staging / "MANIFEST").read_text()
        self.assertIn("signing adhoc\n", manifest)
        self.assertIn("minimum-macos 14.0\n", manifest)
        self.assertIn("component web\n", manifest)
        self.assertIn("core %s\n" % CORE_REF, manifest)
        calls = self.calls()
        first_sign = next(i for i, c in enumerate(calls) if c.startswith("codesign") and "--sign" in c)
        verify = next(i for i, c in enumerate(calls) if c.startswith("codesign") and "-dvv" in c)
        self.assertLess(first_sign, verify)
        self.assertTrue(
            any(c.startswith("codesign --force --sign - --identifier io.github.zajca.pohunek.pohunek-web ") for c in calls), calls
        )

    def test_a_release_whose_signature_is_not_ad_hoc_is_not_archived(self):
        name = "pohunek-web-1.2.3-aarch64-apple-darwin"
        staging = self.web_tree(name)
        self.details.write_text(CERTIFICATE_DETAILS)
        env = {
            "POHUNEK_CORE_REF": CORE_REF,
            "SOURCE_DATE_EPOCH": "1700000000",
            "PATH": "%s:%s:%s" % (self.audit_tools(), self.tools, os.environ["PATH"]),
        }
        result = self.run_tool("package", "--adhoc-release", "web", "1.2.3", staging, env=env)
        self.assertEqual(result.returncode, 1)
        self.assertIn("signed with a certificate, not ad-hoc", result.stderr)
        self.assertFalse((staging / "MANIFEST").exists())
        self.assertFalse((self.root / (name + ".tar.gz")).exists())

    def test_a_staged_tree_with_a_symlink_is_refused_before_anything_is_signed(self):
        name = "pohunek-web-1.2.3-aarch64-apple-darwin"
        staging = self.root / name
        staging.mkdir()
        (staging / "link").symlink_to("/etc/passwd")
        result = self.run_tool("package", "--adhoc-release", "web", "1.2.3", staging, env={"POHUNEK_CORE_REF": CORE_REF})
        self.assertEqual(result.returncode, 1)
        self.assertIn("symbolic link or special file", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_modes_and_components_are_validated(self):
        for args in (
            ("--sideload", "web", "1.2.3", self.root, self.root),
            ("--development", "daemon", "1.2.3", self.root, self.root),
            ("--development", "web"),
            ("--release", "web", "1.2.3", self.root, self.root),
        ):
            result = self.run_tool("package", *args)
            self.assertEqual(result.returncode, 1, args)


class RemovedToolingTest(unittest.TestCase):
    def test_no_credential_based_tooling_remains(self):
        for name in ("notarize", "signing-keychain"):
            self.assertFalse((MACOS / name).exists(), name)
        self.assertFalse((ROOT / "web" / "packaging" / "macos" / "entitlements").exists())


if __name__ == "__main__":
    unittest.main()
