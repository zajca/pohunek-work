<script lang="ts">
  import type { HostedSession, Workspace } from "@pohunek/client-core";
  import { addErrorToast, addToast, hasKnownSessionAgentBases } from "../lib";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import FormDialog from "./FormDialog.svelte";
  import RecoveryTarget from "./RecoveryTarget.svelte";

  interface Props {
    workspace: Workspace;
    entry: HostedSession;
    onfork: (host: string, sessionId: string) => void;
    onremove: () => void;
  }

  let { workspace, entry, onfork, onremove }: Props = $props();
  let renameOpen = $state(false);
  let forkOpen = $state(false);
  let confirmStop = $state(false);
  let confirmRemove = $state(false);
  let nameDraft = $state("");
  let forkCols = $state(80);
  let forkRows = $state(24);
  let pending = $state(false);
  let recoveryIntent: "resume" | "fork" | undefined = $state();
  let recoverySession: Awaited<ReturnType<Workspace["actions"]["sessionInspect"]>> | undefined = $state();
  let recoveryHost: string | undefined = $state();
  let generation = 0;

  const session = $derived(entry.session);
  // Unknown future agents are presentation-only until this client understands
  // their mutation semantics. Resume and fork remain capability-driven below.
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
  const canFork = $derived(session.capabilities.fork);

  function openRename(): void {
    nameDraft = session.name ?? "";
    renameOpen = true;
  }

  function openFork(): void {
    nameDraft = "";
    forkCols = session.cols;
    forkRows = session.rows;
    forkOpen = true;
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

  async function requestRecovery(intent: "resume" | "fork"): Promise<void> {
    if (pending) {
      return;
    }
    const host = entry.host;
    const id = entry.session.id;
    await mutate(async (): Promise<void> => {
      let inspected: Awaited<ReturnType<Workspace["actions"]["sessionInspect"]>>;
      try {
        inspected = await workspace.actions.sessionInspect(host, id);
      } catch (error: unknown) {
        forkOpen = false;
        throw error;
      }
      if (entry.host !== host || entry.session.id !== id) {
        return;
      }
      if ((intent === "resume" && !canResumeSession(inspected))
        || (intent === "fork" && !inspected.capabilities.fork)) {
        forkOpen = false;
        addToast("error", "Recovery is unavailable for the current session state");
        return;
      }
      if (inspected.id !== id) {
        forkOpen = false;
        addToast("error", "Recovery target unavailable: session.inspect returned a different session");
        return;
      }
      if (!inspected.native_session_id && !inspected.native_session_path) {
        forkOpen = false;
        addToast("error", "Recovery target unavailable: session.inspect returned no native reference");
        return;
      }
      if (!hasSingleNativeReference(inspected)) {
        forkOpen = false;
        addToast("error", "Recovery target unavailable: session.inspect returned an invalid target");
        return;
      }
      recoveryHost = host;
      recoverySession = inspected;
      recoveryIntent = intent;
      forkOpen = false;
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
    recoveryIntent = undefined;
    recoverySession = undefined;
    recoveryHost = undefined;
  }

  async function confirmRecovery(): Promise<void> {
    const intent = recoveryIntent;
    const shown = recoverySession;
    const host = recoveryHost;
    if (pending || intent === undefined || shown === undefined || host === undefined) {
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
        || (intent === "resume" && !canResumeSession(current))
        || (intent === "fork" && !current.capabilities.fork)) {
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
        if (intent === "resume") {
          await workspace.actions.sessionResume(host, shown.id);
          addToast("success", "Session resumed");
        } else {
          const result = await workspace.actions.sessionFork(host, {
            session_id: shown.id,
            cwd_mode: "same",
            cols: forkCols,
            rows: forkRows,
            ...(nameDraft.trim().length === 0 ? {} : { name: nameDraft.trim() }),
          });
          addToast("success", "Session forked");
          onfork(host, result.id);
        }
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
      <button type="button" onclick={() => void requestRecovery("resume")} disabled={pending}>Resume</button>
    {:else if canRecover && !session.capabilities.resume}
      <button type="button" disabled title="This session's agent adapter does not support native resume">
        Resume unsupported
      </button>
    {:else}
      <button type="button" disabled title="Resolve the runtime conflict or incompatibility before recovery">
        Resume unavailable
      </button>
    {/if}
    <button
      type="button"
      onclick={openFork}
      disabled={pending || !canFork}
      title={canFork ? "Fork this native agent conversation" : "This session's agent adapter does not support native fork"}
    >{canFork ? "Fork" : "Fork unsupported"}</button>
    <button class="button-danger" type="button" onclick={() => { confirmRemove = true; }} disabled={pending}>
      Remove
    </button>
  </div>
  {#if canRecover || canFork}
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
  open={renameOpen || forkOpen}
  title={renameOpen ? "Rename session" : "Fork session"}
  submitting={pending}
  onclose={() => {
    renameOpen = false;
    forkOpen = false;
  }}
  onsubmit={() => {
    if (renameOpen) {
      void rename();
    } else {
      void requestRecovery("fork");
    }
  }}
>
  {#if renameOpen}
    <label>Name<input bind:value={nameDraft} /></label>
  {:else}
    <label>Display name (optional)<input bind:value={nameDraft} /></label>
    <label>Columns<input type="number" min="1" bind:value={forkCols} /></label>
    <label>Rows<input type="number" min="1" bind:value={forkRows} /></label>
  {/if}
</FormDialog>

{#if recoveryIntent !== undefined && recoverySession !== undefined}
  <FormDialog
    open
    title={recoveryIntent === "resume" ? "Resume session?" : "Confirm fork target"}
    submitLabel={recoveryIntent === "resume" ? "Resume session" : "Fork session"}
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
