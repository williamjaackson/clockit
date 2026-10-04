import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ForgejoCli from "../sourceControl/ForgejoCli.ts";
import * as ForgejoPullRequestProvider from "./ForgejoPullRequestProvider.ts";

const REPOSITORY = { cwd: "/repo", repository: "acme/web", host: "code.example" };

const pull = (number: number, fields: Record<string, unknown> = {}) => ({
  number,
  title: `Change ${number}`,
  body: null,
  html_url: `https://code.example/acme/web/pulls/${number}`,
  user: { login: "octocat" },
  state: "open",
  merged: false,
  head: { ref: `feat/${number}`, sha: "abc123", repo: null },
  base: { ref: "main", sha: "def456", repo: null },
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-02T00:00:00Z",
  closed_at: null,
  merged_at: null,
  labels: null,
  assignees: [{ login: "a&b" }],
  ...fields,
});

const issue = (number: number, state = "open", merged?: boolean) => ({
  number,
  state,
  pull_request: merged === undefined ? {} : { merged },
});

/**
 * A host whose issues listing answers `issues` in pages of `pageSize`, and whose pull request
 * reads answer from `pulls`. Every path asked for is recorded.
 */
function forgejo(input: {
  readonly issues: ReadonlyArray<unknown>;
  readonly pulls: Record<number, unknown>;
  readonly pageSize?: number;
}) {
  const paths: string[] = [];
  const pageSize = input.pageSize ?? 50;
  const respond = (body: unknown, link = "") =>
    Effect.succeed({
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout: JSON.stringify(body),
      stderr: `HTTP/1.1 200\n${link}`,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  const layer = Layer.mock(ForgejoCli.ForgejoCli)({
    api: (request) => {
      paths.push(request.path);
      const single = /\/pulls\/(\d+)$/.exec(request.path);
      if (single) return respond(input.pulls[Number(single[1])]);
      const listed = /\/issues\?.*&page=(\d+)$/.exec(request.path);
      if (listed) {
        const page = Number(listed[1]);
        const rows = input.issues.slice((page - 1) * pageSize, page * pageSize);
        const more = page * pageSize < input.issues.length;
        // Forgejo sends no Link header at all for a lone page, only next and prev links.
        const link = more
          ? `link: <next>; rel="next"\n`
          : page > 1
            ? `link: <prev>; rel="prev"\n`
            : "";
        return respond(rows, link);
      }
      // Only the general pulls listing is left, which an assigned read must not need.
      return respond(Array.from({ length: pageSize }, (_, index) => pull(1000 + index)));
    },
  });
  return { paths, layer };
}

const listAssigned = (
  layer: Layer.Layer<ForgejoCli.ForgejoCli>,
  input: { state?: "all" | "open" | "closed" | "merged"; limit?: number; delivered?: number } = {},
) =>
  Effect.gen(function* () {
    const provider = yield* ForgejoPullRequestProvider.make;
    return yield* provider.listChangeRequests({
      ...REPOSITORY,
      state: input.state ?? "open",
      involvement: "assigned",
      viewer: "a&b",
      limit: input.limit ?? 50,
      ...(input.delivered === undefined
        ? {}
        : { cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: input.delivered } }),
    });
  }).pipe(Effect.provide(layer));

it.effect(
  "finds assigned pull requests through the issues listing, past unrelated newer ones",
  () =>
    Effect.gen(function* () {
      const host = forgejo({ issues: [issue(7)], pulls: { 7: pull(7) } });
      const page = yield* listAssigned(host.layer);
      assert.deepStrictEqual(
        page.items.map((item) => [item.number, item.assigneeLogins]),
        [[7, ["a&b"]]],
      );
      assert.deepStrictEqual(host.paths, [
        "repos/acme/web/issues?type=pulls&state=open&sort=recentupdate&assigned_by=a%26b&limit=50&page=1",
        // A lone page has no Link header, so the next page is asked for to be sure.
        "repos/acme/web/issues?type=pulls&state=open&sort=recentupdate&assigned_by=a%26b&limit=50&page=2",
        "repos/acme/web/pulls/7",
      ]);
      assert.strictEqual(page.truncated, false);
      assert.strictEqual(page.cursorAdvance, 1);
    }),
);

it.effect("reads no pull request when nothing is assigned", () =>
  Effect.gen(function* () {
    const host = forgejo({ issues: [], pulls: {} });
    const page = yield* listAssigned(host.layer, { state: "all" });
    assert.deepStrictEqual(page.items, []);
    assert.strictEqual(page.truncated, false);
    assert.deepStrictEqual(host.paths, [
      "repos/acme/web/issues?type=pulls&state=all&sort=recentupdate&assigned_by=a%26b&limit=50&page=1",
    ]);
  }),
);

it.effect("carries on from the candidates already consumed", () =>
  Effect.gen(function* () {
    const issues = [1, 2, 3, 4, 5].map((number) => issue(number));
    const pulls = Object.fromEntries([1, 2, 3, 4, 5].map((number) => [number, pull(number)]));
    const host = forgejo({ issues, pulls, pageSize: 2 });
    const first = yield* listAssigned(host.layer, { limit: 3 });
    assert.deepStrictEqual(
      first.items.map((item) => item.number),
      [1, 2, 3],
    );
    assert.strictEqual(first.truncated, true);
    assert.strictEqual(first.continues, true);
    assert.strictEqual(first.cursorAdvance, 3);
    const rest = yield* listAssigned(host.layer, { limit: 3, delivered: 3 });
    assert.deepStrictEqual(
      rest.items.map((item) => item.number),
      [4, 5],
    );
    assert.strictEqual(rest.truncated, false);
    assert.strictEqual(rest.cursorAdvance, 2);
  }),
);

it.effect("tells merged from closed by the pull request and reads on past a filtered slice", () =>
  Effect.gen(function* () {
    const closed = { state: "closed", closed_at: "2026-07-02T00:00:00Z" };
    const merged = { ...closed, merged: true, merged_at: "2026-07-02T00:00:00Z" };
    const host = forgejo({
      // An older server leaves `merged` off the issue row, so only the pull request can say.
      issues: [issue(1, "closed"), issue(2, "closed", false), issue(3, "closed", true)],
      pulls: { 1: pull(1, closed), 2: pull(2, closed), 3: pull(3, merged) },
    });
    const page = yield* listAssigned(host.layer, { state: "merged", limit: 2 });
    assert.deepStrictEqual(
      page.items.map((item) => [item.number, item.state]),
      [[3, "merged"]],
    );
    // Every candidate counts toward the cursor, kept or not.
    assert.strictEqual(page.cursorAdvance, 3);
    assert.strictEqual(page.truncated, false);
    // The issue row already said #2 was not merged, so it was never read.
    assert.isFalse(host.paths.includes("repos/acme/web/pulls/2"));
    assert.isFalse(host.paths.some((path) => path.includes("/pulls?")));

    const closedPage = yield* listAssigned(host.layer, { state: "closed" });
    assert.deepStrictEqual(
      closedPage.items.map((item) => item.number),
      [1, 2],
    );
  }),
);
