import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SpicyClient } from "@spicyapi/sdk";

import { runCli, type CliDependencies } from "../src/cli/index.js";
import { formatBytes, type CliIo } from "../src/cli/io.js";

const API = "http://127.0.0.1:4021/api/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

interface Harness {
  calls: Call[];
  stdout: string[];
  stderr: string[];
  run: (...args: string[]) => Promise<number>;
}

function harness(
  responses: Array<Response | ((call: Call) => Response)>,
  ioOverrides: Partial<CliIo> = {},
): Harness {
  const calls: Call[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fetchImplementation: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const raw = init?.body;
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof raw === "string" ? JSON.parse(raw) : raw,
    };
    calls.push(call);
    const next = responses.shift();
    assert.ok(next, `unexpected request to ${url}`);
    return Promise.resolve(typeof next === "function" ? next(call) : next);
  };
  const io: CliIo = {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    stdinIsTTY: false,
    readStdin: () => Promise.resolve(""),
    confirm: () => Promise.resolve(false),
    env: {},
    ...ioOverrides,
  };
  const dependencies: CliDependencies = {
    io,
    createClient: (options) =>
      new SpicyClient({
        ...options,
        apiKey: "sk_cli_assets",
        apiBaseUrl: API,
        serviceBaseUrl: "http://127.0.0.1:4021",
        fetch: fetchImplementation,
        maxRetries: 0,
      }),
  };
  return {
    calls,
    stdout,
    stderr,
    run: (...args) => runCli(["node", "spicyapi", ...args], dependencies),
  };
}

function envelope(data: unknown): Response {
  return Response.json({ code: 200, msg: "success", data, request_id: "req_cli_asset" });
}

function failure(status: number, reason?: string): Response {
  return Response.json(
    {
      code: status,
      msg: "refused by the asset library",
      request_id: "req_cli_fail",
      ...(reason === undefined ? {} : { data: { reason } }),
    },
    { status },
  );
}

function asset(id: string, name = "Hero portrait", bytes = 1843201, favorite = false) {
  return {
    favorite,
    model: "bytedance/seedream-5.0-pro/text-to-image",
    modelName: "Seedream 5.0 Pro",
    id,
    uri: `spicy://a/${id}`,
    name,
    kind: "image",
    contentType: "image/png",
    bytes,
    source: "task_output",
    sourceId: "job_1",
    createdAt: "2026-10-11T08:20:11Z",
    updatedAt: "2026-10-11T08:20:11Z",
    previewUrl: "https://preview.example/private",
  };
}

void test("assets list sends every filter and prints the raw page with --json", async () => {
  const cli = harness([envelope({ items: [asset("ast_1")], nextCursor: "c2" })]);

  const code = await cli.run(
    "--json",
    "assets",
    "list",
    "--kind",
    "image",
    "--source",
    "task_output, url",
    "--search",
    "hero",
    "--limit",
    "5",
    "--cursor",
    "c1",
  );

  assert.equal(code, 0);
  const url = new URL(cli.calls[0]?.url ?? "");
  assert.equal(url.pathname, "/api/v1/assets");
  assert.equal(url.searchParams.get("kind"), "image");
  assert.equal(url.searchParams.get("source"), "task_output,url");
  assert.equal(url.searchParams.get("q"), "hero");
  assert.equal(url.searchParams.get("limit"), "5");
  assert.equal(url.searchParams.get("cursor"), "c1");
  const page = JSON.parse(cli.stdout.join("")) as {
    items: Array<{ id: string }>;
    nextCursor: string;
  };
  assert.equal(page.items[0]?.id, "ast_1");
  assert.equal(page.nextCursor, "c2");
});

void test("assets list prints one line per asset, led by its reference", async () => {
  const cli = harness([
    envelope({ items: [asset("ast_1"), asset("ast_2", "Logo", 4096)], nextCursor: "c2" }),
    envelope({ items: [] }),
  ]);

  assert.equal(await cli.run("assets", "list"), 0);
  const lines = cli.stdout.join("").trimEnd().split("\n");
  assert.deepEqual(lines, [
    "spicy://a/ast_1  image  1.8 MB  Hero portrait",
    "spicy://a/ast_2  image  4 KB  Logo",
    "More assets: run the same command with --cursor c2, or add --all.",
  ]);

  cli.stdout.length = 0;
  assert.equal(await cli.run("assets", "list"), 0);
  assert.equal(cli.stdout.join(""), "No saved assets match.\n");
});

void test("assets list --all walks every page", async () => {
  const cli = harness([
    envelope({ items: [asset("ast_1")], nextCursor: "c2" }),
    envelope({ items: [asset("ast_2")] }),
  ]);

  assert.equal(await cli.run("--json", "assets", "list", "--all", "--kind", "video"), 0);

  const result = JSON.parse(cli.stdout.join("")) as { items: Array<{ id: string }> };
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["ast_1", "ast_2"],
  );
  assert.equal(new URL(cli.calls[1]?.url ?? "").searchParams.get("cursor"), "c2");
  assert.equal(new URL(cli.calls[1]?.url ?? "").searchParams.get("kind"), "video");
});

void test("assets list rejects an unknown kind or source before any request", async () => {
  const cli = harness([]);
  assert.notEqual(await cli.run("assets", "list", "--kind", "document"), 0);
  assert.notEqual(await cli.run("assets", "list", "--source", "task_output,disk"), 0);
  assert.equal(cli.calls.length, 0);
  assert.match(cli.stderr.join(""), /must be one of: image, video, audio/);
  assert.match(cli.stderr.join(""), /comma-separated list of: task_output, upload, url/);
});

void test("assets save --task picks the first output by default and adds an Idempotency-Key", async () => {
  const cli = harness([envelope(asset("ast_1")), envelope(asset("ast_2"))]);

  assert.equal(await cli.run("assets", "save", "--task", "job_1", "--name", "Hero"), 0);
  assert.equal(
    await cli.run(
      "assets",
      "save",
      "--task",
      "job_1",
      "--key",
      "out/2.png",
      "--idempotency-key",
      "keep-hero-2",
    ),
    0,
  );

  assert.equal(cli.calls[0]?.method, "POST");
  assert.equal(cli.calls[0]?.url, `${API}/assets`);
  assert.deepEqual(cli.calls[0]?.body, {
    source: "task_output",
    taskId: "job_1",
    index: 0,
    name: "Hero",
  });
  assert.match(cli.calls[0]?.headers.get("idempotency-key") ?? "", UUID);
  assert.deepEqual(cli.calls[1]?.body, {
    source: "task_output",
    taskId: "job_1",
    key: "out/2.png",
  });
  assert.equal(cli.calls[1]?.headers.get("idempotency-key"), "keep-hero-2");
  const out = cli.stdout.join("");
  assert.match(out, /Saved: spicy:\/\/a\/ast_1 {2}image/);
  assert.match(out, /Put spicy:\/\/a\/ast_1 in any media field of a model input/);
});

void test("assets save --url and --file-id send their own source", async () => {
  const cli = harness([envelope(asset("ast_1")), envelope(asset("ast_2"))]);

  assert.equal(
    await cli.run("--json", "assets", "save", "--url", "https://cdn.example/still.png"),
    0,
  );
  assert.equal(await cli.run("--json", "assets", "save", "--file-id", "spicy://f/fil_7"), 0);

  assert.deepEqual(cli.calls[0]?.body, { source: "url", url: "https://cdn.example/still.png" });
  assert.deepEqual(cli.calls[1]?.body, { source: "upload", fileId: "spicy://f/fil_7" });
});

void test("assets save needs exactly one source and fails before any request", async () => {
  const cli = harness([]);

  assert.equal(await cli.run("assets", "save"), 1);
  assert.equal(
    await cli.run("assets", "save", "--task", "job_1", "--url", "https://cdn.example/a.png"),
    1,
  );
  assert.equal(
    await cli.run("assets", "save", "--url", "https://x.example/a.png", "--index", "1"),
    1,
  );
  assert.equal(
    await cli.run("assets", "save", "--task", "job_1", "--index", "1", "--key", "a.png"),
    1,
  );

  assert.equal(cli.calls.length, 0);
  const stderr = cli.stderr.join("");
  assert.match(stderr, /choose exactly one source/);
  assert.match(stderr, /--index and --key pick a task output/);
  assert.match(stderr, /use either --index or --key/);
});

void test("assets save --file uploads the file and saves it under its name", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spicy-cli-assets-"));
  const filePath = join(directory, "voice sample.wav");
  await writeFile(filePath, Uint8Array.from([82, 73, 70, 70]));
  const cli = harness([
    envelope({
      fileId: "fil_3",
      key: "pending",
      uploadUrl: "https://storage.example/upload/fil_3",
      method: "PUT",
      headers: { "Content-Type": "audio/wav" },
      expiresAt: "2026-10-12T00:10:00Z",
      maxBytes: 94_371_840,
    }),
    new Response(null, { status: 204 }),
    envelope({
      fileId: "fil_3",
      status: "ready",
      bytes: 4,
      contentType: "audio/wav",
      sha256: "c".repeat(64),
      uri: "spicy://f/fil_3",
      expiresAt: "2026-10-13T00:00:00Z",
    }),
    envelope({ ...asset("ast_voice", "voice sample.wav", 4), kind: "audio", source: "upload" }),
  ]);
  try {
    assert.equal(await cli.run("--json", "assets", "save", "--file", filePath), 0);
    const ticketRequest = cli.calls[0]?.body as { contentType?: string };
    assert.equal(ticketRequest.contentType, "audio/wav");
    assert.deepEqual(cli.calls[3]?.body, {
      source: "upload",
      fileId: "fil_3",
      name: "voice sample.wav",
    });
    assert.equal((JSON.parse(cli.stdout.join("")) as { id: string }).id, "ast_voice");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("assets get, rename and usage address the right routes", async () => {
  const plan = {
    id: "plus",
    name: "Plus",
    minTopupUsd: "10",
    maxBytes: 524288000,
    maxCount: 200,
    maxFileBytes: 104857600,
  };
  const cli = harness([
    envelope(asset("ast_1")),
    envelope(asset("ast_1", "Hero v2")),
    envelope({
      tier: plan,
      usage: { count: 3, bytes: 1843201 },
      limits: {
        tier: "plus",
        maxCount: 200,
        maxBytes: 524288000,
        maxFileBytes: 104857600,
        globalMaxBytes: 0,
        nameMaxChars: 80,
      },
      full: false,
      nextTier: { ...plan, id: "pro", name: "Pro", minTopupUsd: "100", maxBytes: 1073741824 },
      topupToNextTierUsd: "75",
      tiers: [plan],
      dailyCreateLimit: 200,
      createdToday: 1,
      lifetimeTopupUsd: "25",
      scope: {
        workspaceId: "ws_me",
        personal: true,
        role: "owner",
        canWrite: true,
        canTopUp: true,
      },
    }),
  ]);

  assert.equal(await cli.run("--json", "assets", "get", "spicy://a/ast_1"), 0);
  assert.equal(await cli.run("--json", "assets", "rename", "ast_1", "Hero v2"), 0);
  cli.stdout.length = 0;
  assert.equal(await cli.run("assets", "usage"), 0);

  assert.deepEqual(
    cli.calls.map((call) => `${call.method} ${call.url}`),
    [`GET ${API}/assets/ast_1`, `PATCH ${API}/assets/ast_1`, `GET ${API}/assets/usage`],
  );
  assert.deepEqual(cli.calls[1]?.body, { name: "Hero v2" });
  assert.deepEqual(cli.stdout.join("").trimEnd().split("\n"), [
    "Library: personal",
    "Plan: Plus (500 MB, 200 items, 100 MB per file)",
    "Stored: 3 of 200 items, 1.8 MB of 500 MB",
    "Saved today: 1 of 200 (resets at 00:00 UTC)",
    "Next plan: Pro — 1 GB, 200 items, 100 MB per file, at USD 100 in lifetime top-ups (USD 75 more)",
  ]);
});

void test("assets usage on a read-only team key names the library and leaves upgrades to the owner", async () => {
  const plan = {
    id: "plus",
    name: "Plus",
    minTopupUsd: "10",
    maxBytes: 524288000,
    maxCount: 200,
    maxFileBytes: 104857600,
  };
  const cli = harness([
    envelope({
      tier: plan,
      usage: { count: 3, bytes: 1843201 },
      limits: {
        tier: "plus",
        maxCount: 200,
        maxBytes: 524288000,
        maxFileBytes: 104857600,
        globalMaxBytes: 0,
        nameMaxChars: 80,
      },
      full: false,
      nextTier: { ...plan, id: "pro", name: "Pro", minTopupUsd: "100", maxBytes: 1073741824 },
      tiers: [plan],
      dailyCreateLimit: 200,
      createdToday: 1,
      scope: {
        workspaceId: "ws_team",
        personal: false,
        role: "readonly",
        canWrite: false,
        canTopUp: false,
      },
    }),
  ]);

  assert.equal(await cli.run("assets", "usage"), 0);

  const lines = cli.stdout.join("").trimEnd().split("\n");
  assert.equal(lines[0], "Library: team workspace ws_team, acting as readonly (read and use only)");
  assert.equal(
    lines.at(-1),
    "Next plan: Pro — 1 GB, 200 items, 100 MB per file. The team owner upgrades the plan.",
  );
  // Counter-proof: without top-up rights there is no amount to print, and none is invented.
  assert.equal(cli.stdout.join("").includes("USD"), false);
});

void test("assets delete needs a confirmation and sends nothing without one", async () => {
  const refused = harness([]);
  assert.equal(await refused.run("assets", "delete", "ast_1"), 1);
  assert.equal(refused.calls.length, 0);
  assert.match(refused.stderr.join(""), /destructive command requires an interactive confirmation/);

  const declined = harness([], { stdinIsTTY: true, confirm: () => Promise.resolve(false) });
  assert.equal(await declined.run("assets", "delete", "ast_1"), 1);
  assert.equal(declined.calls.length, 0);

  const confirmed = harness([envelope({ id: "ast_1", deleted: true })]);
  assert.equal(await confirmed.run("--json", "assets", "delete", "ast_1", "--yes"), 0);
  assert.equal(confirmed.calls[0]?.method, "DELETE");
  assert.equal(confirmed.calls[0]?.url, `${API}/assets/ast_1`);
  assert.deepEqual(JSON.parse(confirmed.stdout.join("")), { id: "ast_1", deleted: true });
});

void test("a refusal's reason reaches --json output and picks the matching hint", async () => {
  const json = harness([failure(400, "asset_library_full")]);
  assert.equal(await json.run("--json", "assets", "save", "--task", "job_1"), 1);
  const details = JSON.parse(json.stderr.join("")) as { status: number; reason: string };
  assert.equal(details.status, 400);
  assert.equal(details.reason, "asset_library_full");
  assert.equal(json.stderr.join("").includes("Next:"), false);

  const human = harness([failure(400, "asset_library_full")]);
  assert.equal(await human.run("assets", "save", "--task", "job_1"), 1);
  const stderr = human.stderr.join("");
  assert.match(stderr, /Error: refused by the asset library \(request req_cli_fail\)/);
  assert.match(stderr, /Next: the plan's storage or item count is used up/);
  // Counter-proof: the generic 400 hint is about model schemas, which is the wrong advice here.
  assert.equal(stderr.includes("models get"), false);

  const unknown = harness([failure(400, "asset_reason_from_the_future")]);
  assert.equal(await unknown.run("--json", "assets", "save", "--task", "job_1"), 1);
  assert.equal(
    (JSON.parse(unknown.stderr.join("")) as { reason: string }).reason,
    "asset_reason_from_the_future",
  );
});

void test("a 403 on an asset command is reported as-is with an asset-specific hint", async () => {
  const withReason = harness([failure(403, "asset_workspace_forbidden")]);
  assert.equal(await withReason.run("assets", "list"), 1);
  assert.match(withReason.stderr.join(""), /Error: refused by the asset library/);
  assert.match(withReason.stderr.join(""), /Next: this key cannot reach that library/);
  assert.equal(withReason.calls.length, 1);

  const withoutReason = harness([failure(403)]);
  assert.equal(await withoutReason.run("assets", "usage"), 1);
  assert.match(
    withoutReason.stderr.join(""),
    /Next: this key may not do that in its asset library/,
  );

  // Counter-proof: the same 403 outside the asset commands keeps the model allowlist hint.
  const model = harness([failure(403)]);
  assert.equal(await model.run("models", "get", "maker/model/text-to-image"), 1);
  assert.match(model.stderr.join(""), /Check its model allowlist and IP allowlist/);
  assert.equal(model.stderr.join("").includes("in its asset library"), false);
});

void test("bytes print in the binary units the asset API counts in", () => {
  assert.equal(formatBytes(1), "1 byte");
  assert.equal(formatBytes(1023), "1023 bytes");
  assert.equal(formatBytes(4096), "4 KB");
  assert.equal(formatBytes(1843201), "1.8 MB");
  assert.equal(formatBytes(524288000), "500 MB");
  assert.equal(formatBytes(10 * 1024 ** 3), "10 GB");
});

function character(id: string, name: string, imageIds: string[]) {
  const images = imageIds.map((imageId) => asset(imageId, `${name} ${imageId}`));
  return {
    id,
    kind: "character",
    name,
    note: "",
    coverAssetId: imageIds[0] ?? "",
    cover: images[0] ?? null,
    assets: images,
    count: images.length,
    createdAt: "2026-10-12T08:00:00Z",
    updatedAt: "2026-10-12T08:00:00Z",
  };
}

void test("assets list sends --favorite, --folder, --character and --sort as query filters", async () => {
  const cli = harness([envelope({ items: [asset("ast_1", "Hero", 1024, true)] })]);

  const code = await cli.run(
    "assets",
    "list",
    "--favorite",
    "--folder",
    "col_moodboard",
    "--character",
    "ety_mia",
    "--search",
    "hero",
    "--sort",
    "name",
  );

  assert.equal(code, 0);
  const query = new URL(cli.calls[0]?.url ?? "").searchParams;
  assert.equal(query.get("favorite"), "true");
  assert.equal(query.get("collectionId"), "col_moodboard");
  assert.equal(query.get("entityId"), "ety_mia");
  assert.equal(query.get("q"), "hero");
  assert.equal(query.get("sort"), "name");
  assert.match(cli.stdout.join(""), /spicy:\/\/a\/ast_1 {2}image {2}1 KB {2}Hero {2}\(favorite\)/);
});

void test("assets list --no-favorite sends favorite=false and no flag sends nothing", async () => {
  const negative = harness([envelope({ items: [] })]);
  assert.equal(await negative.run("assets", "list", "--no-favorite"), 0);
  assert.equal(new URL(negative.calls[0]?.url ?? "").searchParams.get("favorite"), "false");

  // Counter-proof: without either flag the filter is absent, not "false".
  const plain = harness([envelope({ items: [] })]);
  assert.equal(await plain.run("assets", "list"), 0);
  assert.equal(plain.calls[0]?.url, `${API}/assets`);
});

void test("assets list rejects an unknown --sort before any request", async () => {
  const cli = harness([]);
  assert.equal(await cli.run("assets", "list", "--sort", "biggest"), 1);
  assert.equal(cli.calls.length, 0);
  assert.match(cli.stderr.join(""), /recent, oldest, name, size/);
});

void test("a cursor from another --sort is rejected by the server and reported unchanged", async () => {
  const cli = harness([failure(400)]);
  assert.equal(
    await cli.run("--json", "assets", "list", "--sort", "oldest", "--cursor", "name-c2"),
    1,
  );
  const sent = new URL(cli.calls[0]?.url ?? "").searchParams;
  assert.equal(sent.get("sort"), "oldest");
  assert.equal(sent.get("cursor"), "name-c2");
  const details = JSON.parse(cli.stderr.join("")) as { status: number; requestId: string };
  assert.equal(details.status, 400);
  assert.equal(details.requestId, "req_cli_fail");
  assert.equal(cli.calls.length, 1);
});

void test("an unknown --folder gets a folder hint, not the asset id or model hint", async () => {
  const folder = harness([failure(404)]);
  assert.equal(await folder.run("assets", "list", "--folder", "col_elsewhere"), 1);
  const stderr = folder.stderr.join("");
  assert.match(stderr, /Next: check the folder id/);
  assert.equal(stderr.includes("check the asset id"), false);
  assert.equal(stderr.includes("models list"), false);

  // Counter-proof: a 404 on `assets get` keeps the asset id hint.
  const get = harness([failure(404)]);
  assert.equal(await get.run("assets", "get", "ast_gone"), 1);
  assert.match(get.stderr.join(""), /Next: check the asset id/);
});

void test("assets favorite and unfavorite send only the favorite flag", async () => {
  const cli = harness([
    envelope(asset("ast_1", "Hero", 1024, true)),
    envelope(asset("ast_1", "Hero", 1024, false)),
  ]);

  assert.equal(await cli.run("assets", "favorite", "spicy://a/ast_1"), 0);
  assert.equal(await cli.run("--json", "assets", "unfavorite", "ast_1"), 0);

  assert.deepEqual(
    cli.calls.map((call) => `${call.method} ${call.url}`),
    [`PATCH ${API}/assets/ast_1`, `PATCH ${API}/assets/ast_1`],
  );
  assert.deepEqual(cli.calls[0]?.body, { favorite: true });
  assert.deepEqual(cli.calls[1]?.body, { favorite: false });
  assert.match(cli.stdout[0] ?? "", /^Marked as a favorite: spicy:\/\/a\/ast_1/);
  const json = JSON.parse(cli.stdout.slice(1).join("")) as { favorite: boolean };
  assert.equal(json.favorite, false);
});

void test("characters list prints each character with its spicy://a/ references", async () => {
  const cli = harness([
    envelope({
      items: [character("ety_mia", "Mia", ["ast_front", "ast_side"])],
      nextCursor: "ec2",
    }),
  ]);

  assert.equal(await cli.run("characters", "list", "--asset", "spicy://a/ast_front"), 0);

  const listed = new URL(cli.calls[0]?.url ?? "");
  assert.equal(listed.pathname, "/api/v1/assets/entities");
  assert.equal(listed.searchParams.get("assetId"), "ast_front");
  const stdout = cli.stdout.join("");
  assert.match(stdout, /ety_mia {2}Mia {2}2 images/);
  assert.match(stdout, /\["spicy:\/\/a\/ast_front","spicy:\/\/a\/ast_side"\]/);
  assert.match(stdout, /--cursor ec2/);
});

void test("characters list --all walks every page and --json keeps the raw shape", async () => {
  const cli = harness([
    envelope({ items: [character("ety_1", "One", ["ast_a"])], nextCursor: "ec2" }),
    envelope({ items: [character("ety_2", "Two", [])] }),
  ]);
  assert.equal(await cli.run("--json", "characters", "list", "--all", "--limit", "1"), 0);
  const parsed = JSON.parse(cli.stdout.join("")) as { items: Array<{ id: string }> };
  assert.deepEqual(
    parsed.items.map((item) => item.id),
    ["ety_1", "ety_2"],
  );
  assert.deepEqual(
    cli.calls.map((call) => new URL(call.url).searchParams.get("cursor")),
    [null, "ec2"],
  );
});

void test("characters get lists the images in order and the references to paste", async () => {
  const cli = harness([envelope(character("ety_mia", "Mia", ["ast_front", "ast_side"]))]);

  assert.equal(await cli.run("characters", "get", "ety_mia"), 0);

  assert.equal(cli.calls[0]?.url, `${API}/assets/entities/ety_mia`);
  const lines = cli.stdout.join("").split("\n");
  assert.match(lines[1] ?? "", /^1\. spicy:\/\/a\/ast_front/);
  assert.match(lines[2] ?? "", /^2\. spicy:\/\/a\/ast_side/);
  assert.equal(lines[3], 'References: ["spicy://a/ast_front","spicy://a/ast_side"]');
  assert.match(lines[4] ?? "", /reference image field/);
});

void test("an unknown character is a 404 with a character hint", async () => {
  const cli = harness([failure(404)]);
  assert.equal(await cli.run("characters", "get", "ety_gone"), 1);
  const stderr = cli.stderr.join("");
  assert.match(stderr, /Error: refused by the asset library \(request req_cli_fail\)/);
  assert.match(stderr, /Next: check the character id/);
  // Counter-proof: the generic 404 hint talks about model ids, which is the wrong advice here.
  assert.equal(stderr.includes("models list"), false);
  assert.equal(cli.calls.length, 1);
});
