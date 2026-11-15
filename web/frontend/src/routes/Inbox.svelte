<script lang="ts">
  import type { NotificationsSnapshot } from "@pohunek/client-core";
  import type { Readable } from "svelte/store";
  import InboxDrawer from "../components/InboxDrawer.svelte";
  import type { HistoryRouter } from "../lib";

  interface Props {
    router: HistoryRouter;
    notifications: Readable<NotificationsSnapshot>;
  }

  let { router, notifications }: Props = $props();
</script>

<InboxDrawer
  open={true}
  {notifications}
  onclose={() => router.navigate({ kind: "workspace" })}
  onopensession={(host, sessionId) => router.navigate({ kind: "terminal", host, sessionId })}
/>
