import { Box, Text } from "ink";
import type { ReactNode } from "react";

/** The help overlay: the keys of every view and form. */
export function HelpOverlay(): ReactNode {
  return <Box flexDirection="column"><Text>Every list: ↑/↓ select, a click selects; Enter or a double click opens (Sessions: attaches when its side panel is visible); PgUp/PgDn scroll a detail; Esc returns.</Text><Text>Filter: / fuzzy-filters Work, Sessions, Hosts and Activity; P filters the project picker. While a filter is typed every key is text; Enter keeps it and Esc clears it.</Text><Text>Views: Tab or Shift-Tab cycles Work, Sessions, Hosts and Activity; 1–4 jump to one; ←/→ never switch views. ? help, q quit.</Text><Text>Sessions: ←/→ or [ ] jump between sections; x stops and D removes the highlighted session; l links, g branch on GitHub, u folder, b copy branch, c copy path.</Text><Text>Work: m mine, f actor, P project, h hide stale; choose an action in its detail. Activity: ←/→ or c change the scope.</Text><Text>Forms: ↑/↓ move between fields. In Host, Project, Agent and Action or Intent, typing filters the choices, ←/→ pick a match, Enter picks the highlighted match and moves on, Esc clears the query. Ctrl+Enter creates.</Text></Box>;
}
