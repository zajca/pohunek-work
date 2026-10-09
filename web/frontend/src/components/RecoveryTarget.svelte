<script lang="ts">
  import type { SessionInfo } from "@pohunek/protocol";

  interface Props {
    session: SessionInfo;
  }

  let { session }: Props = $props();

  const targetKind = $derived(session.native_session_id !== undefined
    ? " (ID)"
    : session.native_session_path !== undefined ? " (path)" : "");
  const target = $derived(session.native_session_id ?? session.native_session_path ?? "Unknown");
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
