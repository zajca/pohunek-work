<script lang="ts">
  import type { SessionInfo } from "@pohunek/protocol";

  interface Props {
    session: SessionInfo;
  }

  let { session }: Props = $props();

  const hasId = $derived(typeof session.native_session_id === "string"
    && session.native_session_id.length > 0
    && session.native_session_path === undefined);
  const hasPath = $derived(typeof session.native_session_path === "string"
    && session.native_session_path.length > 0
    && session.native_session_id === undefined);
  const targetKind = $derived(hasId ? " (ID)" : hasPath ? " (path)" : "");
  const target = $derived(hasId ? session.native_session_id : hasPath ? session.native_session_path : "Unknown");
</script>

<dl class="recovery-target">
  <div><dt>Recovery target{targetKind}</dt><dd>{target}</dd></div>
  <div><dt>Last native activity</dt><dd>{session.native_last_activity_at ?? "Unknown"}</dd></div>
</dl>

<style>
  .recovery-target {
    display: grid;
    gap: 0.25rem;
    margin: 0;
  }

  .recovery-target div {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .recovery-target dt {
    font-weight: 600;
  }

  .recovery-target dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
