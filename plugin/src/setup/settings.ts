// Fixed values of the launcher installation. They describe the contract with
// the launcher scripts and with sway, not tunable behaviour.

/** Version of the `setup` JSON payload. */
export const SETUP_CONTRACT_VERSION = 1;

/** Scripts are run directly (sway keybind, rofi spawn): owner rwx, group and other r-x. */
export const SCRIPT_MODE = 0o755;

/** File name of the sway drop-in inside `<sway dir>/config.d/`. */
export const SWAY_DROPIN_FILE = "pohunek.conf";

/** Directory of the sway config that holds drop-ins. */
export const SWAY_DROPIN_DIR = "config.d";

/** Keybind of the session switcher (`pohunek-rofi`). */
export const DEFAULT_SWAY_KEYBIND = "$mod+p";

/** Keybind of the Linear issue picker (`pohunek-rofi-issue`). */
export const DEFAULT_SWAY_ISSUE_KEYBIND = "$mod+i";

/** Obsolete script names; `setup scripts --force` deletes them from the install directory. */
export const OBSOLETE_SCRIPTS: readonly string[] = ["pohunek-session-banner"];

/** The shell library every launcher entrypoint sources from its own directory. */
export const SCRIPT_LIBRARY = "lib.sh";
