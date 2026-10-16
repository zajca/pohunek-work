import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { ControlGovernance, ControlHostCapabilities } from "../../control/index.ts";
import { safeText, Section } from "../components.tsx";

/** The host overlay: the daemon's capabilities and the governance of the host. */
export function HostOverlay({ capabilities, governance }: { readonly capabilities: ControlHostCapabilities | null; readonly governance: ControlGovernance | null }): ReactNode {
  return <Box flexDirection="column">
    <Section title="Host capabilities"><Text>{safeText(capabilities === null ? "Unavailable" : `Daemon ${capabilities.daemonVersion}; protocol ${capabilities.protocolVersion}; agents ${capabilities.supportedAgents.join(", ")}`)}</Text></Section>
    <Section title="Governance"><Text>{safeText(governance === null ? "Unavailable" : `Host ${governance.hostId}; enrollment ${governance.enrollment?.status ?? "never enrolled"}; owner ${governance.owner?.id ?? "none"}; quarantine ${governance.quarantine ?? "none"}`)}</Text></Section>
  </Box>;
}
