<script lang="ts">
  import type { HostedSession, Workspace } from "@pohunek/client-core";
  import { addErrorToast, addToast, hasKnownSessionAgentBases } from "../lib";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import FormDialog from "./FormDialog.svelte";
  import RecoveryTarget from "./RecoveryTarget.svelte";

  interface Props {
    workspace: Workspace;
    entry: HostedSession;
    onremove: () => void;
  }

  let { workspace, entry, onremove }: Props = $props();
  let renameOpen = $state(false);
  let confirmStop = $state(false);
  let confirmRemove = $state(false);
  let nameDraft = $state("");
  let pending = $state(false);
  let recoverySession: Awaited<ReturnType<Workspace["actions"]["sessionInspect"]>> | undefined = $state();
  let recoveryHost: string | undefined = $state();
  let generation = 0;

  const session = $derived(entry.session);
  // Unknown future agents are presentation-only until this client understands
  // their mutation semantics. Resume remains capability-driven below.
  const writable = $derived(
    session.external !== true
      && hasKnownSessionAgentBases(session.agent_base, session.active_agent_base),
  );
  const canStop = $derived(
    session.runtime === undefined
      ? session.state === "running" || session.state === "starting"
      : session.runtime.state === "starting"
        || session.runtime.state === "live"
        || session.runtime.state === "reconnecting",
  );
  const canRecover = $derived(isResumableState(session));
  const canResume = $derived(canResumeSession(session));

  function openRename(): void {
    nameDraft = session.name ?? "";
    renameOpen = true;
  }

  async function rename(): Promise<void> {
    if (nameDraft.trim().length === 0) {
      addToast("error", "Session name must not be empty");
      return;
    }
    await mutate(async (): Promise<void> => {
      await workspace.actions.sessionRename(entry.host, {
        session_id: session.id,
        name: nameDraft.trim(),
      });
      renameOpen = false;
      addToast("success", "Session renamed");
    });
  }

  async function clearName(): Promise<void> {
    await mutate(async (): Promise<void> => {
      await workspace.actions.sessionRename(entry.host, { session_id: session.id });
      addToast("success", "Session name cleared");
    });
  }

  async function stop(): Promise<void> {
    await mutate(async (): Promise<void> => {
      const result = await workspace.actions.sessionStop(entry.host, session.id);
      confirmStop = false;
      addToast("success", result.stopped ? "Session stopped" : "Session was already stopped");
    });
  }

  async function requestResume(): Promise<void> {
    if (pending) {
      return;
    }
    const host = entry.host;
    const id = entry.session.id;
    await mutate(async (): Promise<void> => {
      const inspected = await workspace.actions.sessionInspect(host, id);
      if (entry.host !== host || entry.session.id !== id) {
        return;
      }
      if (!canResumeSession(inspected)) {
        addToast("error", "Recovery is unavailable for the current session state");
        return;
      }
      if (inspected.id !== id) {
        addToast("error", "Recovery target unavailable: session.inspect returned a different session");
        return;
      }
      if (!inspected.native_session_id && !inspected.native_session_path) {
        addToast("error", "Recovery target unavailable: session.inspect returned no native reference");
        return;
      }
      if (!hasSingleNativeReference(inspected)) {
        addToast("error", "Recovery target unavailable: session.inspect returned an invalid target");
        return;
      }
      recoveryHost = host;
      recoverySession = inspected;
    });
  }

  function isResumableState(candidate: HostedSession["session"]): boolean {
    if (candidate.runtime !== undefined) {
      return candidate.runtime.state === "lost" || candidate.runtime.state === "terminal";
    }
    return candidate.state === "done" || candidate.state === "failed" || candidate.state === "stopped";
  }

  function hasSingleNativeReference(candidate: HostedSession["session"]): boolean {
    return (typeof candidate.native_session_id === "string"
      && candidate.native_session_id.length > 0
      && candidate.native_session_path === undefined)
      || (typeof candidate.native_session_path === "string"
        && candidate.native_session_path.length > 0
        && candidate.native_session_id === undefined);
  }

  function canResumeSession(candidate: HostedSession["session"]): boolean {
    return candidate.capabilities.resume && isResumableState(candidate);
  }

  function closeRecovery(): void {
    recoverySession = undefined;
    recoveryHost = undefined;
  }

  async function confirmRecovery(): Promise<void> {
    const shown = recoverySession;
    const host = recoveryHost;
    if (pending || shown === undefined || host === undefined) {
      return;
    }
    await mutate(async (): Promise<void> => {
      let current: Awaited<ReturnType<Workspace["actions"]["sessionInspect"]>>;
      try {
        current = await workspace.actions.sessionInspect(host, shown.id);
      } catch (error: unknown) {
        closeRecovery();
        throw error;
      }
      if (entry.host !== host || entry.session.id !== shown.id) {
        closeRecovery();
        return;
      }
      if (current.id !== shown.id
        || !hasSingleNativeReference(current)
        || !canResumeSession(current)) {
        closeRecovery();
        addToast("error", "Recovery target is no longer available");
        return;
      }
      if (shown.native_session_id !== current.native_session_id
        || shown.native_session_path !== current.native_session_path
        || shown.native_last_activity_at !== current.native_last_activity_at) {
        recoverySession = current;
        addToast("info", "Recovery target changed. Review and confirm the current target.");
        return;
      }
      try {
        await workspace.actions.sessionResume(host, shown.id);
        addToast("success", "Session resumed");
      } catch (error: unknown) {
        closeRecovery();
        throw error;
      }
      closeRecovery();
    });
  }

  async function remove(): Promise<void> {
    await mutate(async (): Promise<void> => {
      const result = await workspace.actions.sessionRemove(entry.host, session.id);
      confirmRemove = false;
      addToast("success", result.stopped ? "Session stopped and removed" : "Session removed");
      onremove();
    });
  }

  async function mutate(operation: () => Promise<void>): Promise<void> {
    const current = generation + 1;
    generation = current;
    pending = true;
    try {
      await operation();
    } catch (error: unknown) {
      if (current === generation) {
        addErrorToast(error);
      }
    } finally {
      if (current === generation) {
        pending = false;
      }
    }
  }
</script>

{#if writable}
  <div class="session-lifecycle-actions" aria-label="Session actions">
    <button type="button" onclick={openRename} disabled={pending}>Rename</button>
    {#if session.name !== undefined}
      <button type="button" onclick={() => void clearName()} disabled={pending}>Clear name</button>
    {/if}
    {#if canStop}
      <button type="button" onclick={() => { confirmStop = true; }} disabled={pending}>Stop</button>
    {:else if canResume}
      <button type="button" onclick={() => void requestResume()} disabled={pending}>Resume</button>
    {:else if canRecover && !session.capabilities.resume}
      <button type="button" disabled title="This session's agent adapter does not support native resume">
        Resume unsupported
      </button>
    {:else}
      <button type="button" disabled title="Resolve the runtime conflict or incompatibility before recovery">
        Resume unavailable
      </button>
    {/if}
    <button class="button-danger" type="button" onclick={() => { confirmRemove = true; }} disabled={pending}>
      Remove
    </button>
  </div>
  {#if canRecover}
    <RecoveryTarget {session} />
  {/if}
{/if}

<ConfirmDialog
  open={confirmStop}
  title="Stop this session?"
  message="The agent process will stop. Existing terminal views will close."
  confirmLabel="Stop session"
  onconfirm={() => void stop()}
  oncancel={() => { confirmStop = false; }}
/>

<ConfirmDialog
  open={confirmRemove}
  title="Remove this session?"
  message={session.state === "running" ? "This permanently removes the session and also stops its live PTY." : "This permanently removes the session."}
  confirmLabel="Remove session"
  onconfirm={() => void remove()}
  oncancel={() => { confirmRemove = false; }}
/>

<FormDialog
  open={renameOpen}
  title="Rename session"
  submitting={pending}
  onclose={() => { renameOpen = false; }}
  onsubmit={() => void rename()}
>
  <label>Name<input bind:value={nameDraft} /></label>
</FormDialog>

{#if recoverySession !== undefined}
  <FormDialog
    open
    title="Resume session?"
    submitLabel="Resume session"
    submitting={pending}
    onclose={closeRecovery}
    onsubmit={() => void confirmRecovery()}
  >
    <p>Review the current conversation before launching the agent.</p>
    <RecoveryTarget session={recoverySession} />
  </FormDialog>
{/if}

<style>
  .session-lifecycle-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
