import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ForgejoPullRequest, forgejoChangeRequest } from "./forgejoPullRequestJson.ts";

const decodePullRequest = Schema.decodeUnknownSync(ForgejoPullRequest);

const branch = (ref: string) => ({ ref, sha: "abc123", repo: null });

function pullRequest(fields: Record<string, unknown>) {
  return decodePullRequest({
    number: 1,
    title: "Add the pull requests page",
    body: null,
    html_url: "https://code.example/acme/web/pulls/1",
    user: { login: "octocat" },
    state: "open",
    merged: false,
    head: branch("feat/page"),
    base: branch("main"),
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    closed_at: null,
    merged_at: null,
    labels: null,
    ...fields,
  });
}

describe("forgejoChangeRequest", () => {
  it("reads assignees apart from requested reviewers", () => {
    const item = forgejoChangeRequest(
      pullRequest({
        assignees: [{ login: "Bilal" }, { login: "hubot" }],
        requested_reviewers: [{ login: "julius" }],
      }),
    );

    expect(item.assigneeLogins).toEqual(["Bilal", "hubot"]);
    expect(item.reviewRequestLogins).toEqual(["julius"]);
  });

  it("reads no assignees where the server sent none", () => {
    expect(forgejoChangeRequest(pullRequest({ assignees: null })).assigneeLogins).toEqual([]);
    expect(forgejoChangeRequest(pullRequest({})).assigneeLogins).toEqual([]);
  });
});
