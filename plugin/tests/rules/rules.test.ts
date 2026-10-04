import { describe, expect, test } from "bun:test";
import { evaluateOnTurn, isAiReviewer, isLiveSession, summarizeChecks } from "../../src/rules.ts";
import {
  T0,
  T1,
  T2,
  T3,
  actor,
  allOk,
  check,
  commit,
  deliveredPr,
  input,
  issue,
  mergedPr,
  item,
  notification,
  pr,
  project,
  review,
  session,
  thread,
  user,
} from "./builders.ts";

function onTurn(...args: Parameters<typeof input>): ReturnType<typeof evaluateOnTurn>["onTurn"] {
  return evaluateOnTurn(input(...args)).onTurn;
}

describe("helpers", () => {
  test("isLiveSession requires running and a runtime that is not lost", () => {
    expect(isLiveSession(session())).toBe(true);
    expect(isLiveSession(session({ runtimeState: null }))).toBe(true);
    expect(isLiveSession(session({ runtimeState: "lost" }))).toBe(false);
    expect(isLiveSession(session({ state: "stopped" }))).toBe(false);
    expect(isLiveSession(session({ state: "done" }))).toBe(false);
  });

  test("summarizeChecks", () => {
    const ignored = ["ignored"];
    expect(summarizeChecks([], ignored)).toBe("none");
    expect(summarizeChecks([check("ignored", "failure")], ignored)).toBe("none");
    expect(summarizeChecks([check("a", "success"), check("b", "neutral")], ignored)).toBe("success");
    expect(summarizeChecks([check("a", "pending"), check("b", "success")], ignored)).toBe("pending");
    expect(summarizeChecks([check("a", "pending"), check("b", "failure")], ignored)).toBe("failure");
    expect(summarizeChecks([check("Ignored", "failure")], ignored)).toBe("failure");
  });

  test("isAiReviewer is case-insensitive and ignores the bot suffix", () => {
    expect(isAiReviewer(actor("AI-Helper"), ["ai-helper"])).toBe(true);
    expect(isAiReviewer(actor("ai-helper", true), ["ai-helper[bot]"])).toBe(true);
    expect(isAiReviewer(actor("someone"), ["ai-helper"])).toBe(false);
    expect(isAiReviewer(null, ["ai-helper"])).toBe(false);
  });
});

describe("rules one per rule", () => {
  test("rule 1: unread agent_blocked on a linked session", () => {
    const it = item({ sessions: [session()], notifications: [notification()] });
    expect(onTurn(it)).toEqual({ actor: "me", reason: "answer agent", rule: 1 });
  });

  test("rule 1: read approval_required matches, acknowledged and other kinds do not", () => {
    const sessions = [session()];
    expect(
      onTurn(item({ sessions, notifications: [notification({ kind: "approval_required", status: "read" })] })).rule,
    ).toBe(1);
    expect(onTurn(item({ sessions, notifications: [notification({ status: "acknowledged" })] })).rule).not.toBe(1);
    expect(onTurn(item({ sessions, notifications: [notification({ kind: "turn_completed" })] })).rule).not.toBe(1);
  });

  test("rule 1: a notification of an unlinked session does not match", () => {
    const it = item({ sessions: [session()], notifications: [notification({ sessionId: "other" })] });
    expect(onTurn(it).rule).not.toBe(1);
  });

  test("rule 2: live working session", () => {
    const it = item({ sessions: [session({ activity: "working" })] });
    expect(onTurn(it)).toEqual({ actor: "agent", reason: "working", rule: 2 });
  });

  test("rule 2: idle live session does not match", () => {
    const it = item({ sessions: [session({ activity: "idle" })], pullRequest: pr({ reviewRequests: [user("x")] }) });
    expect(onTurn(it)).toEqual({ actor: "reviewer", reason: "waiting", rule: 10 });
  });

  test("rule 2: working session with lost runtime is not live", () => {
    const it = item({ sessions: [session({ activity: "working", runtimeState: "lost" })] });
    expect(onTurn(it).rule).not.toBe(2);
  });

  test("rule 3: review requested", () => {
    const it = item({ pullRequest: pr({ relation: "review_requested", author: actor("someone") }) });
    expect(onTurn(it)).toEqual({ actor: "me", reason: "review", rule: 3 });
  });

  test("non-authored PR skips rules 4-9 and lands in rule 10 only via rule 3", () => {
    const it = item({ pullRequest: pr({ relation: "review_requested", isDraft: true, mergeable: "CONFLICTING" }) });
    expect(onTurn(it).rule).toBe(3);
  });

  test("rule 4: changes requested without delivery", () => {
    const it = item({
      pullRequest: pr({ reviews: [review("rev-one", "CHANGES_REQUESTED", T1)], reviewDecision: "CHANGES_REQUESTED" }),
    });
    expect(onTurn(it)).toEqual({ actor: "me", reason: "respond", rule: 4 });
  });

  test("rule 5: failing check gives fix CI", () => {
    const it = item({ pullRequest: pr({ checks: [check("build", "failure")] }) });
    expect(onTurn(it)).toEqual({ actor: "me", reason: "fix CI", rule: 5 });
  });

  test("rule 5: conflict gives rebase", () => {
    const it = item({ pullRequest: pr({ mergeable: "CONFLICTING" }) });
    expect(onTurn(it)).toEqual({ actor: "me", reason: "rebase", rule: 5 });
  });

  test("rule 5: a conflict reports rebase before a failing CI or policy check", () => {
    const failures = [check("build", "failure"), check("Require label", "failure")];
    const it = item({ pullRequest: pr({ mergeable: "CONFLICTING", checks: failures }) });
    expect(onTurn(it)).toEqual({ actor: "me", reason: "rebase", rule: 5 });
  });

  test("rule 5: a policy-only failure names the check once", () => {
    const runs = [check("Require label", "failure"), check("Require label", "failure"), check("Require label", "failure")];
    const it = item({ pullRequest: pr({ checks: [...runs, check("build", "success")] }) });
    expect(onTurn(it)).toEqual({ actor: "me", reason: "policy check: Require label", rule: 5 });
  });

  test("rule 5: a policy failure with pending CI is still the policy reason", () => {
    const it = item({ pullRequest: pr({ checks: [check("Require label", "failure"), check("build", "pending")] }) });
    expect(onTurn(it)).toEqual({ actor: "me", reason: "policy check: Require label", rule: 5 });
  });

  test("rule 5: several failing policy checks are named in configuration order", () => {
    const policyChecks = ["Require label", "Require milestone"];
    const it = item({ pullRequest: pr({ checks: [check("Require milestone", "failure"), check("Require label", "failure")] }) });
    expect(onTurn(it, allOk, { ...project, policyChecks })).toEqual({
      actor: "me",
      reason: "policy check: Require label, Require milestone",
      rule: 5,
    });
  });

  test("rule 5: a policy and a CI failure report fix CI", () => {
    const it = item({ pullRequest: pr({ checks: [check("Require label", "failure"), check("build", "failure")] }) });
    expect(onTurn(it)).toEqual({ actor: "me", reason: "fix CI", rule: 5 });
  });

  test("rule 5: ignored failing check does not trigger", () => {
    const it = item({ pullRequest: pr({ checks: [check("CD / Enqueue E2E", "failure")], reviewRequests: [user("x")] }) });
    expect(onTurn(it).rule).toBe(10);
  });

  test("mergeable UNKNOWN is neither conflict (rule 5) nor mergeable (rule 7)", () => {
    const base = { reviewDecision: "APPROVED" as const, checks: [check("build", "success")] };
    const result = onTurn(item({ pullRequest: pr({ ...base, mergeable: "UNKNOWN" }) }));
    expect(result.rule).not.toBe(5);
    expect(result.rule).not.toBe(7);
  });

  test("an approved green PR with mergeable UNKNOWN is unknown, never reviewer", () => {
    const base = { reviewDecision: "APPROVED" as const, checks: [check("build", "success")] };
    expect(onTurn(item({ pullRequest: pr({ ...base, mergeable: "UNKNOWN" }) }))).toEqual({
      actor: "unknown",
      reason: "github:mergeable_unknown",
      rule: null,
    });
  });

  test("mergeable UNKNOWN does not hide an earlier rule or a pending check", () => {
    const approved = { reviewDecision: "APPROVED" as const, mergeable: "UNKNOWN" as const };
    expect(onTurn(item({ pullRequest: pr({ ...approved, isDraft: true }) })).rule).toBe(6);
    expect(onTurn(item({ pullRequest: pr({ ...approved, checks: [check("build", "failure")] }) })).rule).toBe(5);
    expect(onTurn(item({ pullRequest: pr({ ...approved, checks: [check("build", "pending")] }) })).rule).toBe(10);
  });

  test("rule 6: draft", () => {
    expect(onTurn(item({ pullRequest: pr({ isDraft: true }) }))).toEqual({
      actor: "me",
      reason: "leave draft",
      rule: 6,
    });
  });

  test("rule 7: approved, green, mergeable", () => {
    const it = item({ pullRequest: pr({ reviewDecision: "APPROVED", checks: [check("build", "success")] }) });
    expect(onTurn(it)).toEqual({ actor: "me", reason: "merge", rule: 7 });
  });

  test("rule 7: neutral counts as green and no checks counts as green", () => {
    expect(onTurn(item({ pullRequest: pr({ reviewDecision: "APPROVED", checks: [check("a", "neutral")] }) })).rule).toBe(7);
    expect(onTurn(item({ pullRequest: pr({ reviewDecision: "APPROVED" }) })).rule).toBe(7);
  });

  test("rule 7: pending checks do not merge", () => {
    const it = item({ pullRequest: pr({ reviewDecision: "APPROVED", checks: [check("build", "pending")] }) });
    expect(onTurn(it).rule).toBe(10);
  });

  test("rule 8: started issue assigned to me with nothing running", () => {
    const it = item({ key: "linear:ABC-1", issue: issue(), pullRequest: null });
    expect(onTurn(it)).toEqual({ actor: "me", reason: "nothing runs", rule: 8 });
  });

  test("rule 13: a merged pull request replaces rule 8 and rule 8 stays without one", () => {
    const base = { key: "linear:ABC-1", issue: issue(), pullRequest: null };
    expect(onTurn(item({ ...base, mergedPullRequest: mergedPr() }))).toEqual({ actor: "me", reason: "close or follow up", rule: 13 });
    expect(onTurn(item({ ...base, mergedPullRequest: null })).rule).toBe(8);
  });

  test("rule 13: an idle live session keeps rule 11, other state or assignee give nothing", () => {
    const base = { key: "linear:ABC-1", issue: issue(), pullRequest: null, mergedPullRequest: mergedPr() };
    expect(onTurn(item({ ...base, sessions: [session()] })).rule).toBe(11);
    expect(onTurn(item({ ...base, issue: issue({ started: false }) })).rule).toBe(10);
    expect(onTurn(item({ ...base, issue: issue({ assigneeIsMe: false }) })).rule).toBe(10);
  });

  test("rule 13: a failed merged lookup makes only an issue row without PR and session unknown", () => {
    const down = { ...allOk, github_merged: "rate_limited" } as const;
    const issueRow = item({ key: "linear:ABC-1", issue: issue(), pullRequest: null });
    expect(onTurn(issueRow, down)).toEqual({ actor: "unknown", reason: "github_merged:rate_limited", rule: null });
    expect(onTurn(item({ pullRequest: pr({ isDraft: true }) }), down).rule).toBe(6);
    expect(onTurn(item({ ...issueRow, sessions: [session()] }), down).rule).toBe(11);
    expect(onTurn(item({ ...issueRow, issue: issue({ started: false }) }), down).rule).toBe(10);
  });

  test("rule 13: an open pull request wins over a merged one", () => {
    const it = item({ key: "linear:ABC-1", issue: issue(), pullRequest: pr({ isDraft: true }), mergedPullRequest: mergedPr() });
    expect(onTurn(it).rule).toBe(6);
  });

  test("rule 11: started issue assigned to me with an idle live session and no PR", () => {
    const base = { key: "linear:ABC-1", issue: issue(), pullRequest: null };
    expect(onTurn(item({ ...base, sessions: [session()] }))).toEqual({ actor: "me", reason: "check agent", rule: 11 });
    expect(onTurn(item({ ...base, sessions: [session({ activity: "working" })] })).rule).toBe(2);
    expect(onTurn(item({ ...base, sessions: [session({ state: "stopped" })] })).rule).toBe(8);
  });

  test("rule 11: needs a started issue assigned to me and no PR", () => {
    const base = { key: "linear:ABC-1", issue: issue(), sessions: [session()] };
    expect(onTurn(item({ ...base, pullRequest: null, issue: issue({ started: false }) })).rule).toBe(10);
    expect(onTurn(item({ ...base, pullRequest: null, issue: issue({ assigneeIsMe: false }) })).rule).toBe(10);
    expect(onTurn(item({ ...base, pullRequest: pr({ reviewRequests: [user("x")] }) })).rule).toBe(10);
  });

  test("rule 8: a lost session, a PR, other state or other assignee do not block or give it", () => {
    const base = { key: "linear:ABC-1", issue: issue(), pullRequest: null };
    expect(onTurn(item({ ...base, sessions: [session({ runtimeState: "lost" })] })).rule).toBe(8);
    expect(onTurn(item({ ...base, issue: issue({ started: false }) })).rule).toBe(10);
    expect(onTurn(item({ ...base, issue: issue({ assigneeIsMe: false }) })).rule).toBe(10);
    expect(onTurn(item({ ...base, pullRequest: pr({ reviewRequests: [user("x")] }) })).rule).toBe(10);
  });

  test("rule 9: open PR without review request or decision", () => {
    expect(onTurn(item())).toEqual({ actor: "me", reason: "request review", rule: 9 });
  });

  test("rule 9: a team review request counts as pending request", () => {
    const it = item({ pullRequest: pr({ reviewRequests: [{ kind: "team", slug: "reviewers" }] }) });
    expect(onTurn(it).rule).toBe(10);
  });

  test("rule 10: waiting on reviewer", () => {
    const it = item({ pullRequest: pr({ reviewRequests: [user("rev-one")] }) });
    expect(onTurn(it)).toEqual({ actor: "reviewer", reason: "waiting", rule: 10 });
  });

  test("rule 9: REVIEW_REQUIRED without a pending request is no decision yet", () => {
    expect(onTurn(item({ pullRequest: pr({ reviewDecision: "REVIEW_REQUIRED" }) }))).toEqual({
      actor: "me",
      reason: "request review",
      rule: 9,
    });
  });

  test("rule 10: REVIEW_REQUIRED with a pending request waits on the reviewer", () => {
    const it = item({ pullRequest: pr({ reviewDecision: "REVIEW_REQUIRED", reviewRequests: [user("rev-one")] }) });
    expect(onTurn(it).rule).toBe(10);
  });
});

describe("rule precedence", () => {
  const blocked = { sessions: [session({ activity: "working" })], notifications: [notification()] };

  test("1 beats 2", () => {
    expect(onTurn(item(blocked)).rule).toBe(1);
  });

  test("2 beats 3", () => {
    const it = item({
      sessions: [session({ activity: "working" })],
      pullRequest: pr({ relation: "review_requested" }),
    });
    expect(onTurn(it).rule).toBe(2);
  });

  test("3 beats 4", () => {
    const it = item({
      pullRequest: pr({ relation: "review_requested", reviews: [review("rev-one", "CHANGES_REQUESTED", T1)] }),
    });
    expect(onTurn(it).rule).toBe(3);
  });

  test("4 beats 5", () => {
    const it = item({
      pullRequest: pr({
        reviews: [review("rev-one", "CHANGES_REQUESTED", T1)],
        checks: [check("build", "failure")],
        mergeable: "CONFLICTING",
      }),
    });
    expect(onTurn(it).rule).toBe(4);
  });

  test("5 beats 6", () => {
    expect(onTurn(item({ pullRequest: pr({ isDraft: true, checks: [check("build", "failure")] }) })).rule).toBe(5);
  });

  test("6 beats 7", () => {
    const it = item({ pullRequest: pr({ isDraft: true, reviewDecision: "APPROVED" }) });
    expect(onTurn(it).rule).toBe(6);
  });

  test("7 beats 9 and 10", () => {
    expect(onTurn(item({ pullRequest: pr({ reviewDecision: "APPROVED" }) })).rule).toBe(7);
  });
});

describe("rule 12: paused issues", () => {
  const PAUSED = { state: "On hold", paused: true } as const;
  const conflicting = pr({ isDraft: true, mergeable: "CONFLICTING", checks: [check("build", "failure")] });
  const joined = { key: "linear:ABC-1", joinedBy: "branch_pattern", noIssue: false } as const;
  const pausedRow = item({ ...joined, issue: issue(PAUSED), pullRequest: conflicting });

  test("a pull request joined to a paused issue is paused, not the owner's rebase", () => {
    expect(onTurn(pausedRow)).toEqual({ actor: "paused", reason: "paused", rule: 12 });
    expect(onTurn(item({ ...joined, issue: issue(), pullRequest: conflicting }))).toEqual({ actor: "me", reason: "rebase", rule: 5 });
  });

  test("rules 3 to 9 never decide a paused row", () => {
    const prs = [
      deliveredPr({ timeline: [] }),
      pr({ checks: [check("Require label", "failure")] }),
      pr({ isDraft: true }),
      pr({ reviewDecision: "APPROVED" }),
      pr({ reviewDecision: "APPROVED", mergeable: "UNKNOWN" }),
      pr(),
      pr({ reviewRequests: [user("x")] }),
    ];
    for (const pullRequest of prs) {
      expect(onTurn(item({ ...joined, issue: issue(PAUSED), pullRequest }))).toEqual({ actor: "paused", reason: "paused", rule: 12 });
    }
    const issueOnly = item({ key: "linear:ABC-1", issue: issue(PAUSED), pullRequest: null, noIssue: false });
    expect(onTurn(issueOnly).rule).toBe(12);
    expect(onTurn(item({ ...issueOnly, sessions: [session()] })).rule).toBe(12);
  });

  test("rules 1 and 2 still win over a paused issue", () => {
    expect(onTurn(item({ ...pausedRow, sessions: [session({ activity: "working" })] }))).toEqual({
      actor: "agent",
      reason: "working",
      rule: 2,
    });
    expect(onTurn(item({ ...pausedRow, sessions: [session()], notifications: [notification()] }))).toEqual({
      actor: "me",
      reason: "answer agent",
      rule: 1,
    });
    expect(onTurn(item({ ...pausedRow, sessions: [session()] })).rule).toBe(12);
  });

  test("a paused row is decided without github and is unknown without pohunek", () => {
    expect(onTurn(pausedRow, { ...allOk, github: "rate_limited" }).rule).toBe(12);
    expect(onTurn(pausedRow, { ...allOk, pohunek: "timeout" })).toEqual({ actor: "unknown", reason: "pohunek:timeout", rule: null });
  });

  test("a row joined to an issue Linear did not return is unknown while Linear is down", () => {
    const missing = item({ ...joined, issue: null, pullRequest: conflicting });
    expect(onTurn(missing, { ...allOk, linear: "timeout" })).toEqual({ actor: "unknown", reason: "linear:timeout", rule: null });
    expect(onTurn(missing).rule).toBe(5);
    expect(onTurn(missing, { ...allOk, linear: "timeout" }, { ...project, issueSource: { kind: "linear", team: "ABC", pausedStates: [] } }).rule).toBe(5);
    expect(onTurn(item({ pullRequest: conflicting }), { ...allOk, linear: "timeout" }).rule).toBe(5);
  });

  test("only a configured paused state pauses, matched exactly", () => {
    expect(onTurn(pausedRow, allOk, { ...project, issueSource: { kind: "linear", team: "ABC", pausedStates: [] } }).rule).toBe(5);
    expect(onTurn(item({ ...pausedRow, issue: issue({ state: "on hold" }) })).rule).toBe(5);
  });
});

describe("rule 4 sub-conditions", () => {
  const run = (pullRequest: ReturnType<typeof pr>): ReturnType<typeof evaluateOnTurn> =>
    evaluateOnTurn(input(item({ pullRequest })));

  test("all three hold: turn passes on (rule 10) and progress is all true", () => {
    const result = run(deliveredPr());
    expect(result.onTurn).toEqual({ actor: "reviewer", reason: "waiting", rule: 10 });
    expect(result.progress).toEqual({ fixDelivered: true, threadsAnswered: true, rerequested: true });
  });

  test("fix not delivered alone", () => {
    const result = run(deliveredPr({ timeline: [commit(T0)] }));
    expect(result.onTurn.rule).toBe(4);
    expect(result.progress).toEqual({ fixDelivered: false, threadsAnswered: true, rerequested: true });
  });

  test("a commit at exactly R.submittedAt is not after it", () => {
    expect(run(deliveredPr({ timeline: [commit(T1)] })).progress?.fixDelivered).toBe(false);
  });

  test("force push counts as a fix", () => {
    const result = run(deliveredPr({ timeline: [{ kind: "force_push", at: T2 }] }));
    expect(result.progress?.fixDelivered).toBe(true);
  });

  test("timestamps compare as instants, not strings", () => {
    const result = run(
      deliveredPr({
        reviews: [review("rev-one", "CHANGES_REQUESTED", "2026-05-01T12:00:00+02:00")],
        timeline: [commit("2026-05-01T11:00:00Z")],
        threads: [],
      }),
    );
    // 12:00+02:00 is 10:00Z, so the 11:00Z commit is after it.
    expect(result.progress?.fixDelivered).toBe(true);
  });

  test("threads not answered alone: last comment by the reviewer", () => {
    const result = run(
      deliveredPr({
        threads: [thread([{ login: "rev-one", at: T1 }, { login: "owner-me", at: T2 }, { login: "rev-one", at: T3 }])],
      }),
    );
    expect(result.onTurn.rule).toBe(4);
    expect(result.progress).toEqual({ fixDelivered: true, threadsAnswered: false, rerequested: true });
  });

  test("thread whose last comment is by someone else does not count", () => {
    const result = run(
      deliveredPr({ threads: [thread([{ login: "rev-one", at: T1 }, { login: "third-party", at: T2 }])] }),
    );
    expect(result.progress?.threadsAnswered).toBe(false);
  });

  test("stale reply before R.submittedAt does not count", () => {
    const result = run(
      deliveredPr({
        reviews: [review("rev-one", "CHANGES_REQUESTED", T2)],
        timeline: [commit(T3)],
        threads: [thread([{ login: "rev-one", at: T0 }, { login: "owner-me", at: T1 }])],
      }),
    );
    expect(result.progress?.threadsAnswered).toBe(false);
  });

  test("reply by a configured agent identity counts", () => {
    const result = run(
      deliveredPr({ threads: [thread([{ login: "rev-one", at: T1 }, { login: "Agent-Bot-Me", at: T2 }])] }),
    );
    expect(result.progress?.threadsAnswered).toBe(true);
  });

  test("resolved threads and threads without a comment by R.author are ignored", () => {
    const result = run(
      deliveredPr({
        threads: [
          thread([{ login: "rev-one", at: T1 }], true),
          thread([{ login: "other-human", at: T1 }]),
        ],
      }),
    );
    expect(result.progress?.threadsAnswered).toBe(true);
  });

  test("not re-requested alone", () => {
    const result = run(deliveredPr({ reviewRequests: [] }));
    expect(result.onTurn).toEqual({ actor: "me", reason: "respond", rule: 4 });
    expect(result.progress).toEqual({ fixDelivered: true, threadsAnswered: true, rerequested: false });
  });

  test("a team request does not re-request the reviewer", () => {
    const result = run(deliveredPr({ reviewRequests: [{ kind: "team", slug: "rev-one" }] }));
    expect(result.progress?.rerequested).toBe(false);
  });

  test("a newer COMMENTED review does not count as a re-request", () => {
    const result = run(
      deliveredPr({
        reviewRequests: [],
        reviews: [review("rev-one", "CHANGES_REQUESTED", T1), review("rev-one", "COMMENTED", T3)],
      }),
    );
    expect(result.progress?.rerequested).toBe(false);
    expect(result.onTurn).toEqual({ actor: "me", reason: "respond", rule: 4 });
  });

  test("a newer approval ends the changes request", () => {
    const result = run(
      deliveredPr({
        reviewRequests: [],
        reviews: [review("rev-one", "CHANGES_REQUESTED", T1), review("rev-one", "APPROVED", T3)],
      }),
    );
    expect(result.progress).toBeNull();
  });

  test("a pending review is ignored", () => {
    const result = run(
      deliveredPr({ reviewRequests: [], reviews: [review("rev-one", "CHANGES_REQUESTED", T1), review("rev-one", "PENDING", null)] }),
    );
    expect(result.progress?.rerequested).toBe(false);
  });

  test("multiple reviewers where only one is incomplete", () => {
    const result = run(
      deliveredPr({
        reviews: [review("rev-one", "CHANGES_REQUESTED", T1), review("rev-two", "CHANGES_REQUESTED", T1)],
        reviewRequests: [user("rev-one")],
      }),
    );
    expect(result.onTurn.rule).toBe(4);
    expect(result.progress).toEqual({ fixDelivered: true, threadsAnswered: true, rerequested: false });
  });

  test("AI reviewer CHANGES_REQUESTED never creates an R", () => {
    const result = run(
      pr({ reviews: [review("AI-Helper", "CHANGES_REQUESTED", T1)], reviewRequests: [user("x")] }),
    );
    expect(result.progress).toBeNull();
    expect(result.onTurn.rule).toBe(10);
  });

  test("bot reviewer CHANGES_REQUESTED never creates an R", () => {
    const result = run(
      pr({ reviews: [review("some-ci", "CHANGES_REQUESTED", T1, true)], reviewRequests: [user("x")] }),
    );
    expect(result.progress).toBeNull();
  });

  test("logins compare case-insensitively across reviews, threads and requests", () => {
    const result = run(
      deliveredPr({
        reviews: [review("Rev-One", "CHANGES_REQUESTED", T1)],
        threads: [thread([{ login: "REV-ONE", at: T1 }, { login: "OWNER-ME", at: T2 }])],
        reviewRequests: [user("rev-ONE")],
      }),
    );
    expect(result.progress).toEqual({ fixDelivered: true, threadsAnswered: true, rerequested: true });
  });

  test("progress is null without a changes-requested reviewer", () => {
    expect(run(pr()).progress).toBeNull();
  });

  test("DMD-2115 case: delivered and re-requested with green checks goes to the reviewer", () => {
    const result = run(deliveredPr({ checks: [check("build", "success"), check("lint", "success")] }));
    expect(result.onTurn).toEqual({ actor: "reviewer", reason: "waiting", rule: 10 });
  });

  test("DMD-2115 case without the re-request goes back to me", () => {
    const result = run(deliveredPr({ reviewRequests: [], checks: [check("build", "success")] }));
    expect(result.onTurn).toEqual({ actor: "me", reason: "respond", rule: 4 });
  });
});

describe("unknown on missing sources", () => {
  test("pohunek down on a PR row", () => {
    expect(onTurn(item(), { ...allOk, pohunek: "timeout" })).toEqual({
      actor: "unknown",
      reason: "pohunek:timeout",
      rule: null,
    });
  });

  test("github down on a PR row", () => {
    expect(onTurn(item(), { ...allOk, github: "rate_limited" })).toEqual({
      actor: "unknown",
      reason: "github:rate_limited",
      rule: null,
    });
  });

  test("github down on an issue-only row", () => {
    const it = item({ key: "linear:ABC-1", issue: issue(), pullRequest: null });
    expect(onTurn(it, { ...allOk, github: "truncated" }).actor).toBe("unknown");
  });

  test("linear down matters only when the row has an issue and reaches rule 8", () => {
    const down = { ...allOk, linear: "unavailable" as const };
    expect(onTurn(item({ key: "linear:ABC-1", issue: issue(), pullRequest: null }), down)).toEqual({
      actor: "unknown",
      reason: "linear:unavailable",
      rule: null,
    });
    expect(onTurn(item(), down).rule).toBe(9);
    const decided = item({ issue: issue(), pullRequest: pr({ isDraft: true }) });
    expect(onTurn(decided, down).rule).toBe(6);
  });

  test("linear down and an issue row that reaches rule 8 with a PR is still unknown", () => {
    const it = item({ issue: issue(), pullRequest: pr({ reviewRequests: [user("x")] }) });
    expect(onTurn(it, { ...allOk, linear: "timeout" }).actor).toBe("unknown");
  });

  test("an earlier decided rule wins over a later failed source", () => {
    const it = item({ sessions: [session()], notifications: [notification()] });
    expect(onTurn(it, { ...allOk, github: "timeout", linear: "timeout" })).toEqual({
      actor: "me",
      reason: "answer agent",
      rule: 1,
    });
    const working = item({ sessions: [session({ activity: "working" })] });
    expect(onTurn(working, { ...allOk, github: "timeout" }).rule).toBe(2);
  });

  test("rule 3 and rule 6 win over a failed linear source", () => {
    const review3 = item({ pullRequest: pr({ relation: "review_requested" }) });
    expect(onTurn(review3, { ...allOk, linear: "timeout" }).rule).toBe(3);
  });

  test("unknown is never reviewer and github down leaves progress null", () => {
    const result = evaluateOnTurn(input(item({ pullRequest: deliveredPr() }), { ...allOk, github: "unavailable" }));
    expect(result.onTurn.actor).toBe("unknown");
    expect(result.progress).toBeNull();
  });

  test("reason lists only the sources the rule needs", () => {
    const all = { github: "timeout", github_merged: "timeout", linear: "timeout", pohunek: "unavailable" } as const;
    expect(onTurn(item(), all)).toEqual({ actor: "unknown", reason: "pohunek:unavailable", rule: null });
  });

  test("project config is read from the input", () => {
    const it = item({ pullRequest: pr({ checks: [check("build", "failure")] }) });
    expect(onTurn(it, allOk, { ignoredChecks: ["build"], policyChecks: [], aiReviewers: [], issueSource: { kind: "linear", team: "ABC", pausedStates: [] } }).rule).toBe(9);
    expect(onTurn(it, allOk, project).rule).toBe(5);
  });
});
