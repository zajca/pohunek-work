# Changelog

User-facing changes of the pohunek-work plugin.

## 0.8.0 - 2026-11-15

### Fixed

- **Breaking:** The plugin CLI and the web control center now speak daemon protocol 5 and are pinned to pohunek 0.43.1, so `pohunek-work list` no longer reports `protocol_mismatch` and the web backend starts against a current daemon. Protocol 4 daemons are no longer supported, and the session fork action and notification read, acknowledge, archive and policy actions are removed because the daemon no longer offers them. ([#229](https://github.com/zajca/pohunek-work/issues/229))
