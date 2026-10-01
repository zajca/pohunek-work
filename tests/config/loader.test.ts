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
        nestedPageSize: 50,
        threadCommentPageSize: 10,
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
      notify: { command: "/usr/bin/notify-send" },
      policy: { delegable: ["review"], maxActiveTasks: 2, dailyCostCeilingUsd: 12.5 },
      profiles: { implement: "profile-a", review: "profile-b" },
    });
    expect(config.projects.map((p) => p.name)).toEqual(["gadgets", "widgets"]);
    const widgets = config.projects[1];
    expect(widgets?.pohunekLabel).toBe("widgets");
    expect(widgets?.repo).toBe("acme/widgets");
    expect(widgets?.linearTeam).toBe("ABC");
    expect(widgets?.branchPatternSource).toBe("^alice/(?P<key>ABC-[0-9]+)/");
    expect(widgets?.ignoredChecks).toEqual(["CI / Flaky"]);
    expect(widgets?.aiReviewers).toEqual(["review-bot"]);
    expect(widgets?.pausedStates).toEqual(["On hold"]);
    expect(widgets?.policy).toBeNull();
    expect(widgets?.profiles).toBeNull();
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
    ["config.toml", 'review_teams = ["acme/reviewers"]\n', "identity.review_teams", "[identity] review_teams is required"],
    ["projects/widgets.toml", 'ignored_checks = ["CI / Flaky"]\n', "project.ignored_checks", "[project] ignored_checks is required"],
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

  test("missing table fails naming the table", async () => {
    const dir = await copyFixture();
    await editFile(dir, "config.toml", (t) => t.replace(/\[notify\]\ncommand = .*\n/, ""));
    const error = await loadError(dir);
    expect(error.key).toBe("notify");
    expect(error.message).toBe("config.toml: notify is required");
  });
});

describe("loadConfig github page sizes", () => {
  test.each(["pull_request_page_size = 20", "nested_page_size = 50", "thread_comment_page_size = 10"])(
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

describe("loadConfig invalid values", () => {
  test.each([
    ["wrong type", "timeout_ms = 20000", 'timeout_ms = "20000"', "github.timeout_ms"],
    ["zero timeout", "timeout_ms = 20000", "timeout_ms = 0", "github.timeout_ms"],
    ["negative page size", "page_size = 40", "page_size = -1", "linear.page_size"],
    ["fractional page size", "nested_page_size = 50", "nested_page_size = 1.5", "github.nested_page_size"],
    ["zero poll interval", "poll_interval_secs = 300", "poll_interval_secs = 0", "watch.poll_interval_secs"],
    ["relative gh_bin", 'gh_bin = "/usr/bin/gh"', 'gh_bin = "gh"', "github.gh_bin"],
    ["relative secret_tool_bin", 'secret_tool_bin = "/usr/bin/secret-tool"', 'secret_tool_bin = "secret-tool"', "linear.secret_tool_bin"],
    ["relative pohunek bin", 'bin = "/usr/local/bin/pohunek"', 'bin = "pohunek"', "pohunek.bin"],
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
