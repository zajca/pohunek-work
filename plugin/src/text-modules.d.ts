// Text assets are imported with `with { type: "text" }` and bundled by `bun build`.
// Prompt templates:
declare module "*.tmpl" {
  const text: string;
  export default text;
}

// Launcher assets under launchers/: shell library, config template, and the
// extensionless scripts.
declare module "*.sh" {
  const text: string;
  export default text;
}

declare module "*.conf" {
  const text: string;
  export default text;
}

// A module pattern allows one wildcard, so each extensionless script is declared by name.
declare module "*/launchers/pohunek-rofi" {
  const text: string;
  export default text;
}

declare module "*/launchers/pohunek-new-session" {
  const text: string;
  export default text;
}

declare module "*/launchers/pohunek-rofi-issue" {
  const text: string;
  export default text;
}

declare module "*/launchers/pohunek-launch-issue" {
  const text: string;
  export default text;
}

declare module "*/launchers/pohunek-launch-pr" {
  const text: string;
  export default text;
}
