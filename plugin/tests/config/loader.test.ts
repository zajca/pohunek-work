import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig, loadProjectConfig } from "../../src/config/index.ts";

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "config");
const tempDirs: string[] = [];

async function copyFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pohunek-work-config-"));
  tempDirs.push(dir);
  await cp(FIXTURE_DIR, dir, { recursive: true });
  return dir;
}

async function editFile(dir: string, file: string, edit: (text: string) => string): Promise<void> {
  const path = join(dir, file);
  const before = await readFile(path, "utf8");
  const after = edit(before);
  if (after === before) throw new Error(`edit did not change ${file}`);
  await writeFile(path, after);
}

async function loadError(dir: string): Promise<ConfigError> {
  try {
    await loadConfig(dir);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected loadConfig to fail");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadConfig valid", () => {
  test("loads the full fixture to exact typed values", async () => {
    const config = await loadConfig(FIXTURE_DIR);
    expect(config.configDir).toBe(FIXTURE_DIR);
    expect(config.global).toEqual({
      identity: {
        githubLogin: "alice",
        agentIdentities: ["alice", "alice-agent"],
        reviewTeams: ["acme/reviewers"],
      },
      github: {
        endpoint: "https://api.github.example/graphql",
        ghBin: "/usr/bin/gh",
        timeoutMs: 20000,
        pullRequestPageSize: 20,
        issuePageSize: 30,
        nestedPageSize: 50,
        threadCommentPageSize: 10,
        mergedLookbackDays: 30,
      },
      linear: {
        endpoint: "https://linear.example/graphql",
        secretToolBin: "/usr/bin/secret-tool",
        keyringService: "test-service",
        keyringKey: "test-key",
        timeoutMs: 15000,
        pageSize: 40,
      },
      pohunek: { bin: "/usr/local/bin/pohunek", timeoutMs: 10000, notificationsPageSize: 25 },
      watch: { pollIntervalSecs: 300 },
      log: { maxStringLength: 2000 },
      actions: { branchPrefix: "alice", reviewBranchSegment: "review", slugMaxLength: 40, issueNumberPrefix: "issue-", issueBodyMaxLength: 2000, launchTimeoutMs: 120000, launchKillMarginMs: 10000, promptDeliveryTimeoutMs: 4000 },
      notify: { command: "/usr/bin/notify-send", timeoutMs: 5000 },
      policy: { delegable: ["review"], maxActiveTasks: 2, dailyCostCeilingUsd: 12.5 },
      profiles: { implement: "profile-a", review: "profile-b" },
      tui: {
        selfBin: "/usr/local/bin/pohunek-work",
        refreshIntervalSecs: 300,
        listTimeoutMs: 60000,
        staleAfterSecs: 900,
        stalePrDays: 30,
        initialView: "mine",
        bellOnTransition: false,
        openCommand: "/usr/bin/xdg-open",
        openUrlHosts: ["github.com", "linear.app"],
        stderrMaxLines: 10,
        detailMinWidth: 120,
      },
    });
    expect(config.projects.map((p) => p.name)).toEqual(["gadgets", "widgets"]);
    const widgets = config.projects[1];
    expect(widgets?.pohunekLabel).toBe("widgets");
    expect(widgets?.repo).toBe("acme/widgets");
    expect(widgets?.issueSource).toEqual({ kind: "linear", team: "ABC", pausedStates: ["On hold"] });
    expect(widgets?.branchPatternSource).toBe("^alice/(?P<key>ABC-[0-9]+)/");
    expect(widgets?.ignoredChecks).toEqual(["CI / Flaky"]);
    expect(widgets?.policyChecks).toEqual(["Policy / Label"]);
    expect(widgets?.aiReviewers).toEqual(["review-bot"]);
    expect(widgets?.reviews).toBe("session");
    expect(widgets?.policy).toBeNull();
    expect(widgets?.profiles).toBeNull();
  });

  test("ignore_label is absent by default and loads as written when present", async () => {
    const dir = await copyFixture();
    expect((await loadProjectConfig(dir, "widgets")).ignoreLabel).toBeNull();
    await editFile(dir, "projects/widgets.toml", (t) => `${t}ignore_label = "Pohunek:Ignore"\n`);
    expect((await loadProjectConfig(dir, "widgets")).ignoreLabel).toBe("Pohunek:Ignore");
  });

  test.each([
    ['""', "must not be empty"],
    ['"   "', "must not be empty"],
    ["5", "must be a string"],
    ['["x"]', "must be a string"],
  ])("ignore_label = %s is rejected naming file and key", async (value, problem) => {
    const dir = await copyFixture();
    await editFile(dir, "projects/widgets.toml", (t) => `${t}ignore_label = ${value}\n`);
    const error = await loadError(dir);
    expect(error.file).toBe("projects/widgets.toml");
    expect(error.key).toBe("project.ignore_label");
    expect(error.message).toContain(`[project] ignore_label ${problem}`);
  });

  test("per-project policy and profiles replace the global tables whole", async () => {
    const config = await loadConfig(FIXTURE_DIR);
    const gadgets = config.projects[0];
    expect(gadgets?.policy).toEqual({ delegable: [], maxActiveTasks: 0, dailyCostCeilingUsd: 0 });
    expect(gadgets?.profiles).toEqual({ implement: "profile-c" });
    expect(config.global.profiles).toHaveProperty("review");
  });

  test("(?P<key>...) pattern compiles and extracts the key from a branch", async () => {
    const dir = await copyFixture();
    await editFile(dir, "projects/widgets.toml", (t) => t.replace("ABC", "DMD").replace("ABC", "DMD"));
    await editFile(dir, "projects/widgets.toml", (t) => t.replace("alice", "zajca"));
    const project = await loadProjectConfig(dir, "widgets");
    const match = project.branchPattern.exec("zajca/DMD-12/x");
    expect(match?.groups?.["key"]).toBe("DMD-12");
    expect(project.branchPattern.exec("other/DMD-12/x")).toBeNull();
  });

  test("empty arrays are accepted when the key exists", async () => {
    const dir = await copyFixture();
    await editFile(dir, "config.toml", (t) => t.replace('review_teams = ["acme/reviewers"]', "review_teams = []"));
    const config = await loadConfig(dir);
    expect(config.global.identity.reviewTeams).toEqual([]);
  });
});

describe("loadConfig missing keys", () => {
  test.each([
    ["config.toml", "timeout_ms = 20000\n", "github.timeout_ms", "[github] timeout_ms is required"],
    ["config.toml", 'keyring_service = "test-service"\n', "linear.keyring_service", "[linear] keyring_service is required"],
    ["config.toml", "poll_interval_secs = 300\n", "watch.poll_interval_secs", "[watch] poll_interval_secs is required"],
    ["config.toml", "max_string_length = 2000\n", "log.max_string_length", "[log] max_string_length is required"],
    ["config.toml", 'review_branch_segment = "review"\n', "actions.review_branch_segment", "[actions] review_branch_segment is required"],
    ["config.toml", "slug_max_length = 40\n", "actions.slug_max_length", "[actions] slug_max_length is required"],
    ["config.toml", 'issue_number_prefix = "issue-"\n', "actions.issue_number_prefix", "[actions] issue_number_prefix is required"],
    ["config.toml", "issue_body_max_length = 2000\n", "actions.issue_body_max_length", "[actions] issue_body_max_length is required"],
    ["config.toml", "launch_timeout_ms = 120000\n", "actions.launch_timeout_ms", "[actions] launch_timeout_ms is required"],
    ["config.toml", "launch_kill_margin_ms = 10000\n", "actions.launch_kill_margin_ms", "[actions] launch_kill_margin_ms is required"],
    ["config.toml", "prompt_delivery_timeout_ms = 4000\n", "actions.prompt_delivery_timeout_ms", "[actions] prompt_delivery_timeout_ms is required"],
    ["config.toml", 'review_teams = ["acme/reviewers"]\n', "identity.review_teams", "[identity] review_teams is required"],
    ["projects/widgets.toml", 'ignored_checks = ["CI / Flaky"]\n', "project.ignored_checks", "[project] ignored_checks is required"],
    ["projects/widgets.toml", 'policy_checks = ["Policy / Label"]\n', "project.policy_checks", "[project] policy_checks is required"],
    ["projects/widgets.toml", 'ai_reviewers = ["review-bot"]\n', "project.ai_reviewers", "[project] ai_reviewers is required"],
    ["projects/widgets.toml", 'paused_states = ["On hold"]\n', "project.paused_states", "[project] paused_states is required"],
  ])("%s without a line fails naming file and key", async (file, line, key, fragment) => {
    const dir = await copyFixture();
    await editFile(dir, file, (t) => t.replace(line, ""));
    const error = await loadError(dir);
    expect(error.file).toBe(file);
    expect(error.key).toBe(key);
    expect(error.message).toContain(file);
    expect(error.message).toContain(fragment);
  });

  test("an invalid actions.branch_prefix fails naming the key", async () => {
    const dir = await copyFixture();
    await editFile(dir, "config.toml", (t) => t.replace('branch_prefix = "alice"', 'branch_prefix = "Al/ice"'));
    const error = await loadError(dir);
    expect(error.key).toBe("actions.branch_prefix");
  });

  test("an invalid actions.review_branch_segment fails naming the key", async () => {
    const dir = await copyFixture();
    await editFile(dir, "config.toml", (t) => t.replace('review_branch_segment = "review"', 'review_branch_segment = "re/view"'));
    const error = await loadError(dir);
    expect(error.key).toBe("actions.review_branch_segment");
  });

  test("actions.issue_number_prefix may be empty", async () => {
    const dir = await copyFixture();
    await editFile(dir, "config.toml", (t) => t.replace('issue_number_prefix = "issue-"', 'issue_number_prefix = ""'));
    expect((await loadConfig(dir)).global.actions.issueNumberPrefix).toBe("");
  });

  for (const bad of ["Issue-", "is/sue", "issue ", "1.2"]) {
    test(`actions.issue_number_prefix ${JSON.stringify(bad)} fails naming the key`, async () => {
      const dir = await copyFixture();
      await editFile(dir, "config.toml", (t) => t.replace('issue_number_prefix = "issue-"', `issue_number_prefix = ${JSON.stringify(bad)}`));
      expect((await loadError(dir)).key).toBe("actions.issue_number_prefix");
    });
  }

  for (const bad of ["0", "-5", '"x"', "1.5"]) {
    test(`actions.issue_body_max_length ${bad} fails naming the key`, async () => {
      const dir = await copyFixture();
      await editFile(dir, "config.toml", (t) => t.replace("issue_body_max_length = 2000", `issue_body_max_length = ${bad}`));
      expect((await loadError(dir)).key).toBe("actions.issue_body_max_length");
    });
  }

  test("missing table fails naming the table", async () => {
    const dir = await copyFixture();
    await editFile(dir, "config.toml", (t) => t.replace(/\[notify\]\ncommand = .*\ntimeout_ms = .*\n/, ""));
    const error = await loadError(dir);
    expect(error.key).toBe("notify");
    expect(error.message).toBe("config.toml: notify is required");
  });
});

describe("loadConfig github page sizes", () => {
  test.each(["pull_request_page_size = 20", "issue_page_size = 30", "nested_page_size = 50", "thread_comment_page_size = 10"])(
    "%s above 100 fails naming the key",
    async (line) => {
      const dir = await copyFixture();
      const key = line.split(" = ")[0] ?? "";
      await editFile(dir, "config.toml", (t) => t.replace(line, `${key} = 101`));
      const error = await loadConfig(dir).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).key).toBe(`github.${key}`);
      expect((error as ConfigError).message).toContain("100");
    },
  );

  test("100 is accepted when the node budget allows it", async () => {
    const dir = await copyFixture();
    await editFile(dir, "config.toml", (t) =>
      t.replace("pull_request_page_size = 20", "pull_request_page_size = 100").replace("nested_page_size = 50", "nested_page_size = 5").replace("thread_comment_page_size = 10", "thread_comment_page_size = 5"),
    );
    expect((await loadConfig(dir)).global.github.pullRequestPageSize).toBe(100);
  });
});

describe("loadConfig github node budget", () => {
  test("page sizes above the GitHub node limit fail naming the key", async () => {
    const dir = await copyFixture();
    await editFile(dir, "config.toml", (t) =>
      t.replace("pull_request_page_size = 20", "pull_request_page_size = 50")
        .replace("nested_page_size = 50", "nested_page_size = 100")
        .replace("thread_comment_page_size = 10", "thread_comment_page_size = 100"),
    );
    const error = await loadConfig(dir).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).key).toBe("github.pull_request_page_size");
    expect((error as ConfigError).message).toContain("500000");
  });
});

describe("loadConfig github issue page size", () => {
  test("issue_page_size is required", async () => {
    const dir = await copyFixture();
    await editFile(dir, "config.toml", (t) => t.replace("issue_page_size = 30\n", ""));
    const error = await loadError(dir);
    expect(error.file).toBe("config.toml");
    expect(error.key).toBe("github.issue_page_size");
  });

  test("issue_page_size must be positive", async () => {
    const dir = await copyFixture();
    await editFile(dir, "config.toml", (t) => t.replace("issue_page_size = 30", "issue_page_size = 0"));
    expect((await loadError(dir)).key).toBe("github.issue_page_size");
  });

  test("page sizes that fit only without the closing issue references fail naming the key", async () => {
    // Two searches of 50 pull requests: 490,200 possible nodes without the references, 500,200 with them.
    const dir = await copyFixture();
    await editFile(dir, "config.toml", (t) =>
      t.replace("pull_request_page_size = 20", "pull_request_page_size = 50")
        .replace("nested_page_size = 50", "nested_page_size = 100")
        .replace("thread_comment_page_size = 10", "thread_comment_page_size = 44"),
    );
    const error = await loadError(dir);
    expect(error.key).toBe("github.pull_request_page_size");
    expect(error.message).toContain("500000");
  });
});

describe("loadConfig invalid values", () => {
  test.each([
    ["wrong type", "timeout_ms = 20000", 'timeout_ms = "20000"', "github.timeout_ms"],
    ["zero prompt delivery timeout", "prompt_delivery_timeout_ms = 4000", "prompt_delivery_timeout_ms = 0", "actions.prompt_delivery_timeout_ms"],
    ["zero timeout", "timeout_ms = 20000", "timeout_ms = 0", "github.timeout_ms"],
    ["negative page size", "page_size = 40", "page_size = -1", "linear.page_size"],
    ["fractional page size", "nested_page_size = 50", "nested_page_size = 1.5", "github.nested_page_size"],
    ["zero poll interval", "poll_interval_secs = 300", "poll_interval_secs = 0", "watch.poll_interval_secs"],
    ["relative gh_bin", 'gh_bin = "/usr/bin/gh"', 'gh_bin = "gh"', "github.gh_bin"],
    ["relative secret_tool_bin", 'secret_tool_bin = "/usr/bin/secret-tool"', 'secret_tool_bin = "secret-tool"', "linear.secret_tool_bin"],
    ["relative pohunek bin", 'bin = "/usr/local/bin/pohunek"', 'bin = "pohunek"', "pohunek.bin"],
    ["zero notify timeout", "timeout_ms = 5000", "timeout_ms = 0", "notify.timeout_ms"],
    ["relative notify command", 'command = "/usr/bin/notify-send"', 'command = "notify-send"', "notify.command"],
    ["http endpoint", 'endpoint = "https://api.github.example/graphql"', 'endpoint = "http://api.github.example/graphql"', "github.endpoint"],
    ["non-url endpoint", 'endpoint = "https://linear.example/graphql"', 'endpoint = "not a url"', "linear.endpoint"],
    ["empty keyring_service", 'keyring_service = "test-service"', 'keyring_service = ""', "linear.keyring_service"],
    ["empty keyring_key", 'keyring_key = "test-key"', 'keyring_key = ""', "linear.keyring_key"],
    ["empty github_login", 'github_login = "alice"', 'github_login = ""', "identity.github_login"],
    ["array item not a string", 'agent_identities = ["alice", "alice-agent"]', "agent_identities = [1]", "identity.agent_identities"],
    ["empty array item", 'delegable = ["review"]', 'delegable = [""]', "policy.delegable"],
    ["negative cost ceiling", "daily_cost_ceiling_usd = 12.5", "daily_cost_ceiling_usd = -1", "policy.daily_cost_ceiling_usd"],
    ["string max_active_tasks", "max_active_tasks = 2", 'max_active_tasks = "2"', "policy.max_active_tasks"],
    ["fractional max_active_tasks", "max_active_tasks = 2", "max_active_tasks = 1.5", "policy.max_active_tasks"],
    ["negative max_active_tasks", "max_active_tasks = 2", "max_active_tasks = -1", "policy.max_active_tasks"],
    ["non-string profile", 'review = "profile-b"', "review = 3", "profiles.review"],
    ["empty profile value", 'review = "profile-b"', 'review = ""', "profiles.review"],
  ])("%s", async (_name, from, to, key) => {
    const dir = await copyFixture();
    await editFile(dir, "config.toml", (t) => t.replace(from, to));
    const error = await loadError(dir);
    expect(error.file).toBe("config.toml");
    expect(error.key).toBe(key);
    expect(error.message).toContain("config.toml");
    expect(error.message).toContain(key.split(".").pop() ?? "");
  });

  test("zero is allowed for max_active_tasks and daily_cost_ceiling_usd", async () => {
    const dir = await copyFixture();
    await editFile(dir, "config.toml", (t) => t.replace("max_active_tasks = 2", "max_active_tasks = 0"));
    await editFile(dir, "config.toml", (t) => t.replace("daily_cost_ceiling_usd = 12.5", "daily_cost_ceiling_usd = 0"));
    const config = await loadConfig(dir);
    expect(config.global.policy.maxActiveTasks).toBe(0);
    expect(config.global.policy.dailyCostCeilingUsd).toBe(0);
  });

  test("invalid TOML syntax names the file", async () => {
    const dir = await copyFixture();
    await writeFile(join(dir, "config.toml"), "[identity\n");
    const error = await loadError(dir);
    expect(error.file).toBe("config.toml");
    expect(error.message).toContain("config.toml");
  });
});

describe("loadConfig unknown keys", () => {
  test("unknown top-level key", async () => {
    const dir = await copyFixture();
    await editFile(dir, "config.toml", (t) => `extra = 1\n${t}`);
    const error = await loadError(dir);
    expect(error.file).toBe("config.toml");
    expect(error.key).toBe("extra");
    expect(error.message).toBe("config.toml: extra is not a known key");
  });

  test("unknown key inside a table", async () => {
    const dir = await copyFixture();
    await editFile(dir, "config.toml", (t) => t.replace("[watch]\n", "[watch]\nextra = 1\n"));
    const error = await loadError(dir);
    expect(error.key).toBe("watch.extra");
    expect(error.message).toBe("config.toml: [watch] extra is not a known key");
  });

  test("unknown key in a project file", async () => {
    const dir = await copyFixture();
    await editFile(dir, "projects/widgets.toml", (t) => `${t}extra = "x"\n`);
    const error = await loadError(dir);
    expect(error.file).toBe("projects/widgets.toml");
    expect(error.key).toBe("project.extra");
  });

  test("unknown top-level table in a project file", async () => {
    const dir = await copyFixture();
    await editFile(dir, "projects/widgets.toml", (t) => `${t}\n[extra]\nx = 1\n`);
    const error = await loadError(dir);
    expect(error.file).toBe("projects/widgets.toml");
    expect(error.key).toBe("extra");
  });

  test("a check named in both ignored_checks and policy_checks", async () => {
    const dir = await copyFixture();
    await editFile(dir, "projects/widgets.toml", (t) => t.replace('policy_checks = ["Policy / Label"]', 'policy_checks = ["Policy / Label", "CI / Flaky"]'));
    const error = await loadError(dir);
    expect(error.file).toBe("projects/widgets.toml");
    expect(error.key).toBe("project.policy_checks");
    expect(error.message).toContain('must not repeat "CI / Flaky" from ignored_checks');
  });

  test("a duplicate policy_checks entry", async () => {
    const dir = await copyFixture();
    await editFile(dir, "projects/widgets.toml", (t) => t.replace('policy_checks = ["Policy / Label"]', 'policy_checks = ["Policy / Label", "Policy / Label"]'));
    const error = await loadError(dir);
    expect(error.file).toBe("projects/widgets.toml");
    expect(error.key).toBe("project.policy_checks");
    expect(error.message).toContain('must not list "Policy / Label" twice');
  });

  test("project policy table with an unknown key", async () => {
    const dir = await copyFixture();
    await editFile(dir, "projects/gadgets.toml", (t) => t.replace("[policy]\n", "[policy]\nextra = 1\n"));
    const error = await loadError(dir);
    expect(error.file).toBe("projects/gadgets.toml");
    expect(error.key).toBe("policy.extra");
  });
});

describe("loadConfig project files", () => {
  test("missing config.toml names the path", async () => {
    const dir = await copyFixture();
    await rm(join(dir, "config.toml"));
    const error = await loadError(dir);
    expect(error.file).toBe("config.toml");
    expect(error.message).toContain(join(dir, "config.toml"));
  });

  test("missing projects directory names the path", async () => {
    const dir = await copyFixture();
    await rm(join(dir, "projects"), { recursive: true });
    const error = await loadError(dir);
    expect(error.file).toBe("projects");
    expect(error.message).toContain(join(dir, "projects"));
  });

  test("empty projects directory names the path", async () => {
    const dir = await copyFixture();
    await rm(join(dir, "projects", "widgets.toml"));
    await rm(join(dir, "projects", "gadgets.toml"));
    const error = await loadError(dir);
    expect(error.file).toBe("projects");
    expect(error.message).toContain(join(dir, "projects"));
  });

  test("label mismatch", async () => {
    const dir = await copyFixture();
    await editFile(dir, "projects/widgets.toml", (t) => t.replace('pohunek_label = "widgets"', 'pohunek_label = "other"'));
    const error = await loadError(dir);
    expect(error.file).toBe("projects/widgets.toml");
    expect(error.key).toBe("project.pohunek_label");
    expect(error.message).toContain("file name");
  });

  test.each(["widgets", "acme/widgets/x", "acme/ widgets", "/widgets"])("repo %p is rejected", async (repo) => {
    const dir = await copyFixture();
    await editFile(dir, "projects/widgets.toml", (t) => t.replace("acme/widgets", repo));
    const error = await loadError(dir);
    expect(error.key).toBe("project.repo");
    expect(error.message).toContain("owner/name");
  });

  test("invalid regex names file and branch_pattern", async () => {
    const dir = await copyFixture();
    await editFile(dir, "projects/widgets.toml", (t) => t.replace('"^alice/(?P<key>ABC-[0-9]+)/"', '"^alice/(?P<key>ABC-[0-9]+/"'));
    const error = await loadError(dir);
    expect(error.file).toBe("projects/widgets.toml");
    expect(error.key).toBe("project.branch_pattern");
    expect(error.message).toContain("branch_pattern");
  });

  test("regex without a key group", async () => {
    const dir = await copyFixture();
    await editFile(dir, "projects/widgets.toml", (t) => t.replace("(?P<key>ABC-[0-9]+)", "(?P<ticket>ABC-[0-9]+)"));
    const error = await loadError(dir);
    expect(error.key).toBe("project.branch_pattern");
    expect(error.message).toContain("named group");
  });

  test("loadProjectConfig names the expected file when it is missing", async () => {
    const dir = await copyFixture();
    try {
      await loadProjectConfig(dir, "nope");
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).file).toBe("projects/nope.toml");
      expect((error as ConfigError).message).toContain(join(dir, "projects", "nope.toml"));
    }
  });
});

describe("error messages never carry values", () => {
  test("a secret-looking value in a rejected key is not echoed", async () => {
    const dir = await copyFixture();
    const fake = "fake-token-not-real";
    await editFile(dir, "config.toml", (t) => t.replace('keyring_service = "test-service"', `keyring_service = ["${fake}"]`));
    await editFile(dir, "config.toml", (t) => t.replace('gh_bin = "/usr/bin/gh"', `gh_bin = "${fake}"`));
    const first = await loadError(dir);
    expect(first.message).not.toContain(fake);
    await editFile(dir, "config.toml", (t) => t.replace(`gh_bin = "${fake}"`, 'gh_bin = "/usr/bin/gh"'));
    const second = await loadError(dir);
    expect(second.message).not.toContain(fake);
    expect(second.key).toBe("linear.keyring_service");
  });

  test("unknown-key, regex and syntax errors do not echo values", async () => {
    const fake = "fake-token-not-real";
    const dir = await copyFixture();
    await editFile(dir, "projects/widgets.toml", (t) => t.replace('"^alice/(?P<key>ABC-[0-9]+)/"', `"(${fake}"`));
    expect((await loadError(dir)).message).not.toContain(fake);
    await writeFile(join(dir, "config.toml"), `[identity\n${fake} = `);
    expect((await loadError(dir)).message).not.toContain(fake);
  });
});

describe("loadConfig [tui]", () => {
  test.each([
    ['self_bin = "/usr/local/bin/pohunek-work"\n', "tui.self_bin"],
    ["refresh_interval_secs = 300\n", "tui.refresh_interval_secs"],
    ["list_timeout_ms = 60000\n", "tui.list_timeout_ms"],
    ["stale_after_secs = 900\n", "tui.stale_after_secs"],
    ["stale_pr_days = 30\n", "tui.stale_pr_days"],
    ['initial_view = "mine"\n', "tui.initial_view"],
    ["bell_on_transition = false\n", "tui.bell_on_transition"],
    ['open_command = "/usr/bin/xdg-open"\n', "tui.open_command"],
    ['open_url_hosts = ["github.com", "linear.app"]\n', "tui.open_url_hosts"],
    ["stderr_max_lines = 10\n", "tui.stderr_max_lines"],
    ["detail_min_width = 120\n", "tui.detail_min_width"],
  ])("without %p fails naming config.toml and the key", async (line, key) => {
    const dir = await copyFixture();
    await editFile(dir, "config.toml", (t) => t.replace(line, ""));
    const error = await loadError(dir);
    expect(error.file).toBe("config.toml");
    expect(error.key).toBe(key);
    expect(error.message).toContain(`config.toml: [tui] ${key.slice("tui.".length)} is required`);
  });

  test("a missing [tui] table fails naming the table", async () => {
    const dir = await copyFixture();
    await editFile(dir, "config.toml", (t) => t.slice(0, t.indexOf("[tui]")));
    const error = await loadError(dir);
    expect(error.key).toBe("tui");
    expect(error.message).toBe("config.toml: tui is required");
  });

  test.each([
    ["relative self_bin", 'self_bin = "/usr/local/bin/pohunek-work"', 'self_bin = "pohunek-work"', "tui.self_bin", "must be an absolute path"],
    ["relative open_command", 'open_command = "/usr/bin/xdg-open"', 'open_command = "xdg-open"', "tui.open_command", "must be an absolute path"],
    ["zero refresh interval", "refresh_interval_secs = 300", "refresh_interval_secs = 0", "tui.refresh_interval_secs", "must be a positive integer"],
    ["fractional list timeout", "list_timeout_ms = 60000", "list_timeout_ms = 1.5", "tui.list_timeout_ms", "must be a positive integer"],
    ["negative stale age", "stale_after_secs = 900", "stale_after_secs = -1", "tui.stale_after_secs", "must be a positive integer"],
    ["zero stderr lines", "stderr_max_lines = 10", "stderr_max_lines = 0", "tui.stderr_max_lines", "must be a positive integer"],
    ["string detail width", "detail_min_width = 120", 'detail_min_width = "120"', "tui.detail_min_width", "must be an integer"],
    ["unknown initial view", 'initial_view = "mine"', 'initial_view = "unknown"', "tui.initial_view", 'must be one of "mine", "all"'],
    ["string bell flag", "bell_on_transition = false", 'bell_on_transition = "false"', "tui.bell_on_transition", "must be true or false"],
    ["empty host list", 'open_url_hosts = ["github.com", "linear.app"]', "open_url_hosts = []", "tui.open_url_hosts", "must not be empty"],
    ["host with a scheme", 'open_url_hosts = ["github.com", "linear.app"]', 'open_url_hosts = ["https://github.com"]', "tui.open_url_hosts", "lowercase host names"],
    ["host with a port", 'open_url_hosts = ["github.com", "linear.app"]', 'open_url_hosts = ["github.com:443"]', "tui.open_url_hosts", "lowercase host names"],
    ["uppercase host", 'open_url_hosts = ["github.com", "linear.app"]', 'open_url_hosts = ["GitHub.com"]', "tui.open_url_hosts", "lowercase host names"],
  ])("%s is rejected naming the key", async (_name, from, to, key, fragment) => {
    const dir = await copyFixture();
    await editFile(dir, "config.toml", (t) => t.replace(from, to));
    const error = await loadError(dir);
    expect(error.key).toBe(key);
    expect(error.message).toContain(fragment);
  });

  test.each([
    ["prompt_delivery_timeout_ms = 4000", "prompt_delivery_timeout_ms = 8001", "actions.prompt_delivery_timeout_ms", "must not exceed 8000 (pohunek session wait limit)"],
    ["poll_interval_secs = 300", "poll_interval_secs = 2147484", "watch.poll_interval_secs", "must not exceed 2147483 (timer limit)"],
    ["timeout_ms = 5000", "timeout_ms = 2147483648", "notify.timeout_ms", "must not exceed 2147483647 (timer limit)"],
    ["refresh_interval_secs = 300", "refresh_interval_secs = 2147484", "tui.refresh_interval_secs", "must not exceed 2147483 (timer limit)"],
    ["stale_after_secs = 900", "stale_after_secs = 9999999", "tui.stale_after_secs", "must not exceed 2147483 (timer limit)"],
    ["list_timeout_ms = 60000", "list_timeout_ms = 2147483648", "tui.list_timeout_ms", "must not exceed 2147483647 (timer limit)"],
  ])("%p beyond the setTimeout limit is rejected", async (from, to, key, fragment) => {
    const dir = await copyFixture();
    await editFile(dir, "config.toml", (t) => t.replace(from, to));
    const error = await loadError(dir);
    expect(error.key).toBe(key);
    expect(error.message).toContain(fragment);
  });

  test("an unknown key in [tui] is rejected", async () => {
    const dir = await copyFixture();
    await editFile(dir, "config.toml", (t) => t.replace("detail_min_width = 120", "detail_min_width = 120\nrefresh_jitter = 3"));
    const error = await loadError(dir);
    expect(error.key).toBe("tui.refresh_jitter");
  });

  test('initial_view "all" and bell_on_transition true are accepted', async () => {
    const dir = await copyFixture();
    await editFile(dir, "config.toml", (t) =>
      t.replace('initial_view = "mine"', 'initial_view = "all"').replace("bell_on_transition = false", "bell_on_transition = true"),
    );
    const config = await loadConfig(dir);
    expect(config.global.tui.initialView).toBe("all");
    expect(config.global.tui.bellOnTransition).toBe(true);
  });
});

describe("loadConfig issue_source", () => {
  const githubProject = (text: string): string =>
    text
      .replace('issue_source = "linear"\nlinear_team = "ABC"\n', 'issue_source = "github"\nissue_signal = "labels"\nstarted_labels = ["in-progress"]\npaused_labels = ["on-hold"]\n')
      .replace(/paused_states = .*\n/, "");
  const withoutLinearTable = (text: string): string => text.replace(/\[linear\]\n(?:.+\n)+\n/, "");

  test("a github project loads with no Linear keys", async () => {
    const dir = await copyFixture();
    await editFile(dir, "projects/gadgets.toml", githubProject);
    const config = await loadConfig(dir);
    expect(config.projects.find((p) => p.name === "gadgets")?.issueSource).toEqual({ kind: "github", signal: "labels", startedLabels: ["in-progress"], pausedLabels: ["on-hold"], projectStatus: null });
    expect(config.projects.find((p) => p.name === "widgets")?.issueSource.kind).toBe("linear");
  });

  test("[linear] may be absent when every project uses github", async () => {
    const dir = await copyFixture();
    await editFile(dir, "projects/gadgets.toml", githubProject);
    await editFile(dir, "projects/widgets.toml", githubProject);
    await editFile(dir, "config.toml", withoutLinearTable);
    const config = await loadConfig(dir);
    expect(config.global.linear).toBeNull();
    expect(config.projects.every((p) => p.issueSource.kind === "github")).toBe(true);
  });

  test("[linear] is required while a project uses linear", async () => {
    const dir = await copyFixture();
    await editFile(dir, "projects/gadgets.toml", githubProject);
    await editFile(dir, "config.toml", withoutLinearTable);
    const error = await loadError(dir);
    expect(error.file).toBe("config.toml");
    expect(error.key).toBe("linear");
    expect(error.message).toContain("projects/widgets.toml");
  });

  test("a present [linear] table is still validated when every project uses github", async () => {
    const dir = await copyFixture();
    await editFile(dir, "projects/gadgets.toml", githubProject);
    await editFile(dir, "projects/widgets.toml", githubProject);
    await editFile(dir, "config.toml", (t) => t.replace("page_size = 40", "page_size = 0"));
    const error = await loadError(dir);
    expect(error.file).toBe("config.toml");
    expect(error.key).toBe("linear.page_size");
  });

  test("[linear] page_size is bounded by Linear's complexity limit, tighter with an ignore_label", async () => {
    const setPageSize = (size: number) => (t: string): string => t.replace(/^page_size = \d+$/m, `page_size = ${size.toString()}`);
    const withIgnore = (t: string): string => `${t}ignore_label = "Pohunek:Ignore"\n`;

    const plain = await copyFixture();
    await editFile(plain, "config.toml", setPageSize(93));
    expect((await loadConfig(plain)).global.linear?.pageSize).toBe(93);
    await editFile(plain, "config.toml", setPageSize(94));
    const over = await loadError(plain);
    expect([over.file, over.key]).toEqual(["config.toml", "linear.page_size"]);

    const labelled = await copyFixture();
    await editFile(labelled, "projects/widgets.toml", withIgnore);
    await editFile(labelled, "config.toml", setPageSize(66));
    expect((await loadConfig(labelled)).global.linear?.pageSize).toBe(66);
    await editFile(labelled, "config.toml", setPageSize(67));
    const overLabelled = await loadError(labelled);
    expect([overLabelled.file, overLabelled.key]).toEqual(["config.toml", "linear.page_size"]);
    expect(overLabelled.message).toContain("ignore_label");
  });

  test("an ignore_label on a github project does not tighten [linear] page_size", async () => {
    const dir = await copyFixture();
    await editFile(dir, "projects/gadgets.toml", githubProject);
    await editFile(dir, "projects/gadgets.toml", (t) => `${t}ignore_label = "Pohunek:Ignore"\n`);
    await editFile(dir, "config.toml", (t) => t.replace("page_size = 40", "page_size = 90"));
    expect((await loadConfig(dir)).global.linear?.pageSize).toBe(90);
  });

  test("a missing issue_source is rejected", async () => {
    const dir = await copyFixture();
    await editFile(dir, "projects/widgets.toml", (t) => t.replace('issue_source = "linear"\n', ""));
    const error = await loadError(dir);
    expect(error.file).toBe("projects/widgets.toml");
    expect(error.key).toBe("project.issue_source");
  });

  test("reviews accepts session and external", async () => {
    const dir = await copyFixture();
    await editFile(dir, "projects/widgets.toml", (t) => t.replace('reviews = "session"', 'reviews = "external"'));
    const config = await loadConfig(dir);
    expect(config.projects.map((p) => [p.name, p.reviews])).toEqual([["gadgets", "session"], ["widgets", "external"]]);
  });

  test("a missing reviews is rejected", async () => {
    const dir = await copyFixture();
    await editFile(dir, "projects/widgets.toml", (t) => t.replace('reviews = "session"\n', ""));
    const error = await loadError(dir);
    expect(error.file).toBe("projects/widgets.toml");
    expect(error.key).toBe("project.reviews");
  });

  test("an unknown reviews is rejected", async () => {
    const dir = await copyFixture();
    await editFile(dir, "projects/widgets.toml", (t) => t.replace('reviews = "session"', 'reviews = "pipeline"'));
    const error = await loadError(dir);
    expect(error.file).toBe("projects/widgets.toml");
    expect(error.key).toBe("project.reviews");
    expect(error.message).not.toContain("pipeline");
  });

  test("an unknown issue_source is rejected", async () => {
    const dir = await copyFixture();
    await editFile(dir, "projects/widgets.toml", (t) => t.replace('issue_source = "linear"', 'issue_source = "jira"'));
    const error = await loadError(dir);
    expect(error.file).toBe("projects/widgets.toml");
    expect(error.key).toBe("project.issue_source");
    expect(error.message).not.toContain("jira");
  });

  test("linear_team on a github project is rejected", async () => {
    const dir = await copyFixture();
    await editFile(dir, "projects/widgets.toml", (t) => githubProject(t).replace('issue_source = "github"\n', 'issue_source = "github"\nlinear_team = "ABC"\n'));
    const error = await loadError(dir);
    expect(error.file).toBe("projects/widgets.toml");
    expect(error.key).toBe("project.linear_team");
  });

  test("paused_states on a github project is rejected", async () => {
    const dir = await copyFixture();
    await editFile(dir, "projects/widgets.toml", (t) => githubProject(t).replace('issue_source = "github"\n', 'issue_source = "github"\npaused_states = []\n'));
    const error = await loadError(dir);
    expect(error.file).toBe("projects/widgets.toml");
    expect(error.key).toBe("project.paused_states");
  });

  test("a linear project without linear_team is rejected", async () => {
    const dir = await copyFixture();
    await editFile(dir, "projects/widgets.toml", (t) => t.replace('linear_team = "ABC"\n', ""));
    const error = await loadError(dir);
    expect(error.file).toBe("projects/widgets.toml");
    expect(error.key).toBe("project.linear_team");
  });

  test("a linear project without paused_states is rejected", async () => {
    const dir = await copyFixture();
    await editFile(dir, "projects/widgets.toml", (t) => t.replace(/paused_states = .*\n/, ""));
    const error = await loadError(dir);
    expect(error.file).toBe("projects/widgets.toml");
    expect(error.key).toBe("project.paused_states");
  });

  test("branch_pattern stays required for a github project", async () => {
    const dir = await copyFixture();
    await editFile(dir, "projects/widgets.toml", (t) => githubProject(t).replace(/branch_pattern = .*\n/, ""));
    const error = await loadError(dir);
    expect(error.key).toBe("project.branch_pattern");
  });
});

describe("loadConfig github issue labels", () => {
  const githubProject = (extra: string): ((text: string) => string) => (text) =>
    text
      .replace('issue_source = "linear"\nlinear_team = "ABC"\n', `issue_source = "github"\n${extra}`)
      .replace(/paused_states = .*\n/, "");
  const labelsOf = async (dir: string): Promise<unknown> =>
    (await loadConfig(dir)).projects.find((p) => p.name === "gadgets")?.issueSource;

  test("started_labels and paused_labels are read as written", async () => {
    const dir = await copyFixture();
    await editFile(dir, "projects/gadgets.toml", githubProject('issue_signal = "labels"\nstarted_labels = ["In Progress", "wip"]\npaused_labels = []\n'));
    expect(await labelsOf(dir)).toEqual({ kind: "github", signal: "labels", startedLabels: ["In Progress", "wip"], pausedLabels: [], projectStatus: null });
  });

  test.each([
    ["started_labels is missing", 'issue_signal = "labels"\npaused_labels = []\n', "project.started_labels"],
    ["started_labels is empty", 'issue_signal = "labels"\nstarted_labels = []\npaused_labels = []\n', "project.started_labels"],
    ["paused_labels is missing", 'issue_signal = "labels"\nstarted_labels = ["wip"]\n', "project.paused_labels"],
    ["started_labels repeats a label by case", 'issue_signal = "labels"\nstarted_labels = ["wip", "WIP"]\npaused_labels = []\n', "project.started_labels"],
    ["paused_labels repeats a started label", 'issue_signal = "labels"\nstarted_labels = ["wip"]\npaused_labels = ["Wip"]\n', "project.paused_labels"],
  ])("%s", async (_name, extra, key) => {
    const dir = await copyFixture();
    await editFile(dir, "projects/gadgets.toml", githubProject(extra));
    const error = await loadError(dir);
    expect(error.file).toBe("projects/gadgets.toml");
    expect(error.key).toBe(key);
  });

  test.each(["started_labels", "paused_labels"])("%s on a linear project is rejected", async (key) => {
    const dir = await copyFixture();
    await editFile(dir, "projects/widgets.toml", (t) => t.replace('issue_source = "linear"\n', `issue_source = "linear"\n${key} = ["wip"]\n`));
    const error = await loadError(dir);
    expect(error.file).toBe("projects/widgets.toml");
    expect(error.key).toBe(`project.${key}`);
  });
});

describe("loadConfig github issue signal", () => {
  const LABELS = 'started_labels = ["wip"]\npaused_labels = ["hold"]\n';
  const STATUS =
    'status_project_owner = "Acme"\nstatus_project_number = 7\nstatus_field = "Status"\n' +
    'status_started_options = ["In Progress"]\nstatus_paused_options = ["Blocked"]\n';
  const githubProject = (extra: string): ((text: string) => string) => (text) =>
    text
      .replace('issue_source = "linear"\nlinear_team = "ABC"\n', `issue_source = "github"\n${extra}`)
      .replace(/paused_states = .*\n/, "");
  const sourceOf = async (dir: string): Promise<unknown> =>
    (await loadConfig(dir)).projects.find((p) => p.name === "gadgets")?.issueSource;
  const load = async (extra: string): Promise<string> => {
    const dir = await copyFixture();
    await editFile(dir, "projects/gadgets.toml", githubProject(extra));
    return dir;
  };

  test("issue_signal project reads the status keys and leaves the label lists empty", async () => {
    expect(await sourceOf(await load(`issue_signal = "project"\n${STATUS}`))).toEqual({
      kind: "github",
      signal: "project",
      startedLabels: [],
      pausedLabels: [],
      projectStatus: { owner: "Acme", number: 7, field: "Status", startedOptions: ["In Progress"], pausedOptions: ["Blocked"] },
    });
  });

  test("issue_signal both reads labels and status keys", async () => {
    expect(await sourceOf(await load(`issue_signal = "both"\n${LABELS}${STATUS}`))).toEqual({
      kind: "github",
      signal: "both",
      startedLabels: ["wip"],
      pausedLabels: ["hold"],
      projectStatus: { owner: "Acme", number: 7, field: "Status", startedOptions: ["In Progress"], pausedOptions: ["Blocked"] },
    });
  });

  test("status_paused_options may be empty", async () => {
    const extra = `issue_signal = "project"\n${STATUS.replace('["Blocked"]', "[]")}`;
    const source = (await sourceOf(await load(extra))) as { projectStatus: { pausedOptions: string[] } };
    expect(source.projectStatus.pausedOptions).toEqual([]);
  });

  test.each([
    ["issue_signal is missing", LABELS, "project.issue_signal"],
    ["issue_signal is unknown", `issue_signal = "board"\n${LABELS}`, "project.issue_signal"],
    ["issue_signal has the wrong type", `issue_signal = 1\n${LABELS}`, "project.issue_signal"],
    ["project rejects started_labels", `issue_signal = "project"\nstarted_labels = ["wip"]\n${STATUS}`, "project.started_labels"],
    ["project rejects paused_labels", `issue_signal = "project"\npaused_labels = []\n${STATUS}`, "project.paused_labels"],
    ["labels rejects status_project_owner", `issue_signal = "labels"\n${LABELS}status_project_owner = "acme"\n`, "project.status_project_owner"],
    ["labels rejects status_project_number", `issue_signal = "labels"\n${LABELS}status_project_number = 1\n`, "project.status_project_number"],
    ["labels rejects status_field", `issue_signal = "labels"\n${LABELS}status_field = "Status"\n`, "project.status_field"],
    ["labels rejects status_started_options", `issue_signal = "labels"\n${LABELS}status_started_options = ["a"]\n`, "project.status_started_options"],
    ["labels rejects status_paused_options", `issue_signal = "labels"\n${LABELS}status_paused_options = []\n`, "project.status_paused_options"],
    ["project misses status_project_owner", `issue_signal = "project"\n${STATUS.replace(/status_project_owner.*\n/, "")}`, "project.status_project_owner"],
    ["project misses status_project_number", `issue_signal = "project"\n${STATUS.replace(/status_project_number.*\n/, "")}`, "project.status_project_number"],
    ["project misses status_field", `issue_signal = "project"\n${STATUS.replace(/status_field.*\n/, "")}`, "project.status_field"],
    ["project misses status_started_options", `issue_signal = "project"\n${STATUS.replace(/status_started_options.*\n/, "")}`, "project.status_started_options"],
    ["project misses status_paused_options", `issue_signal = "project"\n${STATUS.replace(/status_paused_options.*\n/, "")}`, "project.status_paused_options"],
    ["both misses started_labels", `issue_signal = "both"\npaused_labels = []\n${STATUS}`, "project.started_labels"],
    ["both misses paused_labels", `issue_signal = "both"\nstarted_labels = ["wip"]\n${STATUS}`, "project.paused_labels"],
    ["both misses status_field", `issue_signal = "both"\n${LABELS}${STATUS.replace(/status_field.*\n/, "")}`, "project.status_field"],
    ["owner is not a login", `issue_signal = "project"\n${STATUS.replace('"Acme"', '"a/b"')}`, "project.status_project_owner"],
    ["owner is empty", `issue_signal = "project"\n${STATUS.replace('"Acme"', '""')}`, "project.status_project_owner"],
    ["owner has the wrong type", `issue_signal = "project"\n${STATUS.replace('"Acme"', "5")}`, "project.status_project_owner"],
    ["number is zero", `issue_signal = "project"\n${STATUS.replace("= 7", "= 0")}`, "project.status_project_number"],
    ["number is fractional", `issue_signal = "project"\n${STATUS.replace("= 7", "= 1.5")}`, "project.status_project_number"],
    ["number is a string", `issue_signal = "project"\n${STATUS.replace("= 7", '= "7"')}`, "project.status_project_number"],
    ["field is empty", `issue_signal = "project"\n${STATUS.replace('"Status"', '""')}`, "project.status_field"],
    ["field has the wrong type", `issue_signal = "project"\n${STATUS.replace('"Status"', "3")}`, "project.status_field"],
    ["started options are empty", `issue_signal = "project"\n${STATUS.replace('["In Progress"]', "[]")}`, "project.status_started_options"],
    ["started options have the wrong type", `issue_signal = "project"\n${STATUS.replace('["In Progress"]', '"x"')}`, "project.status_started_options"],
    ["paused options have the wrong type", `issue_signal = "project"\n${STATUS.replace('["Blocked"]', "[1]")}`, "project.status_paused_options"],
    ["started options repeat by case", `issue_signal = "project"\n${STATUS.replace('["In Progress"]', '["a", "A"]')}`, "project.status_started_options"],
    ["paused options repeat by case", `issue_signal = "project"\n${STATUS.replace('["Blocked"]', '["b", "B"]')}`, "project.status_paused_options"],
    ["paused option repeats a started option", `issue_signal = "project"\n${STATUS.replace('["Blocked"]', '["in progress"]')}`, "project.status_paused_options"],
    ["both: label overlap", `issue_signal = "both"\nstarted_labels = ["wip"]\npaused_labels = ["WIP"]\n${STATUS}`, "project.paused_labels"],
  ])("%s", async (_name, extra, key) => {
    const error = await loadError(await load(extra));
    expect(error.file).toBe("projects/gadgets.toml");
    expect(error.key).toBe(key);
  });

  test("a started label may equal a paused option because they are different signals", async () => {
    const extra = `issue_signal = "both"\nstarted_labels = ["blocked"]\npaused_labels = []\n${STATUS}`;
    expect(await sourceOf(await load(extra))).toMatchObject({ signal: "both", startedLabels: ["blocked"] });
  });

  test.each(["issue_signal", "status_project_owner", "status_project_number", "status_field", "status_started_options", "status_paused_options"])(
    "%s on a linear project is rejected",
    async (key) => {
      const dir = await copyFixture();
      await editFile(dir, "projects/widgets.toml", (t) => t.replace('issue_source = "linear"\n', `issue_source = "linear"\n${key} = "x"\n`));
      const error = await loadError(dir);
      expect(error.file).toBe("projects/widgets.toml");
      expect(error.key).toBe(`project.${key}`);
    },
  );
});
