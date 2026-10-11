const API_ROOT = "https://api.github.com/";

export type JsonObject = Record<string, unknown>;
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface GithubApi {
  get<T>(path: string): Promise<T>;
  getAll<T>(path: string): Promise<readonly T[]>;
  getAllFrom<T>(path: string, collectionKey: string): Promise<readonly T[]>;
  post<T>(path: string, body: JsonObject): Promise<T>;
  patch<T>(path: string, body: JsonObject): Promise<T>;
}

export class GithubRestApi implements GithubApi {
  private readonly token: string;
  private readonly fetcher: FetchLike;

  public constructor(token?: string, fetcher: FetchLike = fetch) {
    if (token !== undefined && token.trim().length === 0) {
      throw new Error("GitHub token must not be empty");
    }
    this.token = token ?? "";
    this.fetcher = fetcher;
  }

  public async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  public async getAll<T>(path: string): Promise<readonly T[]> {
    return this.getAllFrom<T>(path, "");
  }

  public async getAllFrom<T>(path: string, collectionKey: string): Promise<readonly T[]> {
    const values: T[] = [];
    let next: string | null = this.url(path);
    const visited = new Set<string>();
    while (next !== null) {
      if (visited.has(next)) {
        throw new Error("GitHub API pagination repeated a page");
      }
      visited.add(next);
      const response = await this.send("GET", next);
      const page = await this.readJson<unknown>(response, "GET");
      const collection = collectionKey === ""
        ? page
        : typeof page === "object" && page !== null && !Array.isArray(page)
          ? (page as Record<string, unknown>)[collectionKey]
          : undefined;
      if (!Array.isArray(collection)) {
        throw new Error("GitHub API returned an invalid paginated response");
      }
      values.push(...(collection as T[]));
      next = this.nextPage(response.headers.get("link"));
    }
    return values;
  }

  public async post<T>(path: string, body: JsonObject): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  public async patch<T>(path: string, body: JsonObject): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  private async request<T>(method: string, path: string, body?: JsonObject): Promise<T> {
    const url = this.url(path);
    const response = await this.send(method, url, body);
    return this.readJson<T>(response, method);
  }

  private url(path: string): string {
    const url = new URL(path, API_ROOT);
    if (url.origin !== new URL(API_ROOT).origin || !url.pathname.startsWith("/repos/")) {
      throw new Error("GitHub API request escaped the repository API");
    }
    return url.toString();
  }

  private nextPage(link: string | null): string | null {
    if (link === null) {
      return null;
    }
    for (const part of link.split(",")) {
      const match = /^\s*<([^>]+)>;\s*rel="next"\s*$/.exec(part);
      if (match?.[1] !== undefined) {
        return this.url(match[1]);
      }
    }
    return null;
  }

  private async send(method: string, url: string, body?: JsonObject): Promise<Response> {
    const headers = new Headers({
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "pohunek-red-main-reporter",
    });
    if (this.token !== "") {
      headers.set("authorization", `Bearer ${this.token}`);
    }
    if (body !== undefined) {
      headers.set("content-type", "application/json");
    }
    return this.fetcher(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  private async readJson<T>(response: Response, method: string): Promise<T> {
    if (!response.ok) {
      throw new Error(`GitHub API ${method} request failed with status ${response.status}`);
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new Error(`GitHub API ${method} request returned invalid JSON`);
    }
  }
}
