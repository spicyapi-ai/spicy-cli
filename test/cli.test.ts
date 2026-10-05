import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli, type CliDependencies } from "../src/cli/index.js";
import { SUPPORTED_UPLOAD_CONTENT_TYPES, type CliIo } from "../src/cli/io.js";
import { readOpenApiContract, SpicyClient } from "@spicyapi/sdk";

interface CapturedIo {
  io: CliIo;
  stdout: string[];
  stderr: string[];
}

function captureIo(overrides: Partial<CliIo> = {}): CapturedIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      stdinIsTTY: false,
      readStdin: () => Promise.resolve(""),
      confirm: () => Promise.resolve(false),
      env: {},
      ...overrides,
    },
  };
}

function dependencies(io: CliIo, fetchImplementation: typeof fetch): CliDependencies {
  return {
    io,
    createClient: (options) =>
      new SpicyClient({
        ...options,
        apiKey: "sk_cli_secret",
        apiBaseUrl: "http://127.0.0.1:4020/api/v1",
        serviceBaseUrl: "http://127.0.0.1:4020",
        fetch: fetchImplementation,
        maxRetries: 0,
      }),
  };
}

void test("help exposes environment-based authentication without an API-key flag", async () => {
  const captured = captureIo();
  const code = await runCli(["node", "spicyapi", "--help"], { io: captured.io });

  assert.equal(code, 0);
  const help = captured.stdout.join("");
  assert.match(help, /Official CLI/);
  assert.equal(help.includes("--api-key"), false);
});

void test("task-create help does not require a content-mode flag", async () => {
  const captured = captureIo();
  const code = await runCli(["node", "spicyapi", "tasks", "create", "--help"], {
    io: captured.io,
  });

  assert.equal(code, 0);
  // commander wraps option descriptions to the terminal width, so flatten the whitespace before
  // asserting - otherwise this measures the layout rather than the wording.
  const help = captured.stdout.join("").replace(/\s+/g, " ");
  assert.equal(help.includes("--mature"), false);
});

void test("usage sends only the current key's date query and keeps USD precision", async () => {
  const captured = captureIo();
  const urls: string[] = [];
  const code = await runCli(
    ["node", "spicyapi", "--json", "usage", "--from", "2026-09-01", "--to", "2026-09-02"],
    dependencies(captured.io, (input) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return Promise.resolve(
        Response.json({
          code: 200,
          msg: "success",
          request_id: "req_usage",
          data: { currency: "USD", totalSpend: "0.000000001", totalCalls: 1, days: [], models: [] },
        }),
      );
    }),
  );
  assert.equal(code, 0);
  assert.deepEqual(urls, ["http://127.0.0.1:4020/api/v1/usage?from=2026-09-01&to=2026-09-02"]);
  const result = JSON.parse(captured.stdout.join("")) as { totalSpend: string };
  assert.equal(result.totalSpend, "0.000000001");
});

void test("documentation search uses verified first-party URLs without API access", async () => {
  const captured = captureIo();
  const code = await runCli(["node", "spicyapi", "--json", "docs", "search", "webhook"], {
    io: captured.io,
    createClient: () => {
      throw new Error("docs search must not create an API client");
    },
  });

  assert.equal(code, 0);
  const result = JSON.parse(captured.stdout.join("")) as Array<{ slug: string; url: string }>;
  assert.equal(result[0]?.slug, "webhooks");
  assert.equal(result[0]?.url, "https://docs.spicyapi.ai/docs/webhooks");
});

void test("non-interactive billable commands fail closed without --yes", async () => {
  const captured = captureIo();
  let called = false;
  const mockFetch: typeof fetch = () => {
    called = true;
    return Promise.resolve(
      Response.json({ code: 500, msg: "unexpected", request_id: "req" }, { status: 500 }),
    );
  };

  const code = await runCli(
    ["node", "spicyapi", "tasks", "create", "--model", "provider/model", "--input-json", "{}"],
    dependencies(captured.io, mockFetch),
  );

  assert.equal(code, 1);
  assert.equal(called, false);
  assert.match(captured.stderr.join(""), /interactive confirmation or --yes/);
});

void test("task creation without an input flag fails before the billable confirmation", async () => {
  const captured = captureIo({ stdinIsTTY: true, confirm: () => Promise.resolve(true) });
  let called = false;
  const mockFetch: typeof fetch = () => {
    called = true;
    return Promise.resolve(
      Response.json({ code: 500, msg: "unexpected", request_id: "req" }, { status: 500 }),
    );
  };

  const code = await runCli(
    ["node", "spicyapi", "tasks", "create", "--model", "provider/model", "--yes"],
    dependencies(captured.io, mockFetch),
  );

  assert.equal(code, 1);
  assert.equal(called, false);
  const stderr = captured.stderr.join("");
  assert.match(stderr, /model input is required/);
  assert.match(stderr, /--input-json/);
  assert.match(stderr, /--input-file/);
  assert.match(stderr, /stdin/);
});

void test("confirmed task creation sends and returns the stable idempotency key", async () => {
  const captured = captureIo();
  let requestHeaders = new Headers();
  let requestBody = "";
  const mockFetch: typeof fetch = (_input, init) => {
    if (
      (typeof _input === "string"
        ? _input
        : _input instanceof URL
          ? _input.href
          : _input.url
      ).endsWith("/jobs/quote")
    )
      return Promise.resolve(
        Response.json({
          code: 200,
          msg: "success",
          request_id: "req_quote",
          data: {
            quoteId: "quote_cli",
            model: "provider/model",
            estimatedCost: "0.10",
            maxCharge: "0.10",
            currency: "USD",
            quantity: "1",
            unit: "per_request",
            expiresAt: "2026-09-05T12:05:00Z",
          },
        }),
      );
    requestHeaders = new Headers(init?.headers);
    requestBody = typeof init?.body === "string" ? init.body : "";
    return Promise.resolve(
      Response.json({
        code: 200,
        msg: "success",
        request_id: "req_create",
        data: { taskId: "job_cli", state: "queued", estimatedCost: "0.10" },
      }),
    );
  };

  const code = await runCli(
    [
      "node",
      "spicyapi",
      "--json",
      "tasks",
      "create",
      "--model",
      "provider/model",
      "--input-json",
      '{"prompt":"hello","futureField":true}',
      "--idempotency-key",
      "idem_cli",
      "--yes",
    ],
    dependencies(captured.io, mockFetch),
  );

  assert.equal(code, 0);
  assert.equal(requestHeaders.get("authorization"), "Bearer sk_cli_secret");
  assert.equal(requestHeaders.get("idempotency-key"), "idem_cli");
  assert.deepEqual(JSON.parse(requestBody), {
    model: "provider/model",
    input: { prompt: "hello", futureField: true },
    quoteId: "quote_cli",
    expectedCost: "0.10",
  });
  const result = JSON.parse(captured.stdout.join("")) as { idempotencyKey: string; taskId: string };
  assert.deepEqual(result, {
    idempotencyKey: "idem_cli",
    taskId: "job_cli",
    state: "queued",
    estimatedCost: "0.10",
  });
  assert.match(captured.stderr.join(""), /Idempotency-Key: idem_cli/);
  assert.equal(captured.stdout.join("").includes("sk_cli_secret"), false);
});

void test("JSON command errors include the request ID and never echo the API key", async () => {
  const captured = captureIo();
  const mockFetch: typeof fetch = () =>
    Promise.resolve(
      Response.json({ code: 404, msg: "not found", request_id: "req_missing" }, { status: 404 }),
    );

  const code = await runCli(
    ["node", "spicyapi", "--json", "tasks", "get", "job_missing"],
    dependencies(captured.io, mockFetch),
  );

  assert.equal(code, 1);
  const result = JSON.parse(captured.stderr.join("")) as Record<string, unknown>;
  assert.equal(result.requestId, "req_missing");
  assert.equal(result.status, 404);
  assert.equal(captured.stderr.join("").includes("sk_cli_secret"), false);
});

void test("tasks list passes filters and the cursor through, requests one page, and neither confirms spending nor fetches detail", async () => {
  const captured = captureIo({
    confirm: () => {
      throw new Error("a read-only listing must not confirm spending");
    },
  });
  const urls: string[] = [];
  const page = {
    items: [{ taskId: "task_1", cost: "0.000000001", settled: true }],
    hasMore: true,
    nextCursor: "next+/=",
  };
  const code = await runCli(
    [
      "node",
      "spicyapi",
      "--json",
      "tasks",
      "list",
      "--from",
      "2026-09-01",
      "--to",
      "2026-09-07",
      "--state",
      "succeeded",
      "--model",
      "example/model/edit",
      "--limit",
      "50",
      "--cursor",
      "opaque+/=",
    ],
    dependencies(captured.io, (input, init) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      assert.equal(init?.method, "GET");
      return Promise.resolve(
        Response.json({ code: 200, msg: "success", request_id: "req_tasks", data: page }),
      );
    }),
  );
  assert.equal(code, 0);
  assert.equal(urls.length, 1);
  const url = new URL(urls[0]!);
  assert.equal(url.pathname, "/api/v1/jobs");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    from: "2026-09-01",
    to: "2026-09-07",
    state: "succeeded",
    model: "example/model/edit",
    limit: "50",
    cursor: "opaque+/=",
  });
  assert.deepEqual(JSON.parse(captured.stdout.join("")), page);
});

void test("an unconfirmed purge sends no request at all", async () => {
  const captured = captureIo();
  let called = false;
  const mockFetch: typeof fetch = () => {
    called = true;
    return Promise.resolve(
      Response.json({ code: 200, msg: "success", request_id: "req", data: {} }, { status: 200 }),
    );
  };

  // A non-interactive terminal with no --yes: refuse outright.
  const closed = await runCli(
    ["node", "spicyapi", "tasks", "purge", "job_purge"],
    dependencies(captured.io, mockFetch),
  );
  assert.equal(closed, 1);
  assert.equal(called, false);
  assert.match(
    captured.stderr.join(""),
    /destructive command requires an interactive confirmation/,
  );

  // An interactive terminal where the user answers no: again, no request goes out.
  const declined = captureIo({ stdinIsTTY: true, confirm: () => Promise.resolve(false) });
  const declinedCode = await runCli(
    ["node", "spicyapi", "tasks", "purge", "job_purge"],
    dependencies(declined.io, mockFetch),
  );
  assert.equal(declinedCode, 1);
  assert.equal(called, false);
  assert.match(declined.stderr.join(""), /operation canceled/);
});

void test("a confirmed purge states plainly that the billing records are kept", async () => {
  const prompts: string[] = [];
  const captured = captureIo({
    stdinIsTTY: true,
    confirm: (message) => {
      prompts.push(message);
      return Promise.resolve(true);
    },
  });
  const urls: string[] = [];
  const mockFetch: typeof fetch = (input, init) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(init?.method, "POST");
    return Promise.resolve(
      Response.json({
        code: 200,
        msg: "success",
        request_id: "req_purge",
        data: {
          taskId: "job_purge",
          contentState: "purged",
          purgedAt: "2026-09-13T10:00:00Z",
          contentRemovedBy: "user",
          billingRetained: true,
        },
      }),
    );
  };

  const code = await runCli(
    ["node", "spicyapi", "tasks", "purge", "job_purge"],
    dependencies(captured.io, mockFetch),
  );

  assert.equal(code, 0);
  assert.equal(urls.length, 1);
  assert.match(urls[0] ?? "", /\/jobs\/purge$/);
  const prompt = prompts.join(" ");
  assert.match(prompt, /cannot be undone/i);
  // "what is destroyed is content, not the record of spending" has to appear before the user says
  // yes, not as an explanation afterwards.
  assert.match(prompt, /Billing records are kept/);
  assert.match(captured.stdout.join(""), /contentState: purged/);
  // The deletion scope matches the server's, and the confirmation and the follow-up message
  // describe the same thing.
  assert.match(prompt, /generated media, result payload, prompt and other input text/);
  assert.match(prompt, /ledger entry, charged amount, model, state, timestamps and request ID/);
  assert.match(
    captured.stdout.join(""),
    /generated media, result payload, prompt and other input text/,
  );
});

void test("the help text for purge and for --retention names the same deletion scope", async () => {
  const scope = "generated media, result payload, prompt and other input text";
  for (const argv of [
    ["tasks", "purge", "--help"],
    ["tasks", "create", "--help"],
  ]) {
    const captured = captureIo();
    const code = await runCli(["node", "spicyapi", ...argv], { io: captured.io });
    assert.equal(code, 0);
    // commander wraps to the terminal width, so flatten the whitespace before comparing.
    const help = captured.stdout.join("").replace(/\s+/g, " ");
    assert.ok(help.includes(scope), `${argv.join(" ")} help must name the deletion scope`);
    assert.match(help, /[Bb]illing records are (always )?kept/);
  }
});

void test("--retention accepts durations people write, as well as a plain number of seconds", async () => {
  const seen: Array<string | null> = [];
  const mockFetch: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/jobs/quote")) {
      return Promise.resolve(
        Response.json({
          code: 200,
          msg: "success",
          request_id: "req_quote",
          data: {
            quoteId: "quote_retention",
            model: "provider/model",
            estimatedCost: "0.10",
            maxCharge: "0.10",
            currency: "USD",
            quantity: "1",
            unit: "per_request",
            expiresAt: "2026-09-13T12:05:00Z",
          },
        }),
      );
    }
    seen.push(new Headers(init?.headers).get("x-spicy-retention"));
    return Promise.resolve(
      Response.json({
        code: 200,
        msg: "success",
        request_id: "req_create",
        data: { taskId: "job_retention", state: "queued", estimatedCost: "0.10" },
      }),
    );
  };

  for (const [written, expected] of [
    ["1h", "3600"],
    ["30m", "1800"],
    ["7d", "604800"],
    ["900", "900"],
    ["0", "0"],
  ] as const) {
    const captured = captureIo();
    const code = await runCli(
      [
        "node",
        "spicyapi",
        "--json",
        "tasks",
        "create",
        "--model",
        "provider/model",
        "--input-json",
        "{}",
        "--retention",
        written,
        "--yes",
      ],
      dependencies(captured.io, mockFetch),
    );
    assert.equal(code, 0, `--retention ${written} should be accepted`);
    assert.equal(seen.at(-1), expected, `--retention ${written} should send ${expected}`);
  }
  assert.deepEqual(seen, ["3600", "1800", "604800", "900", "0"]);

  const rejected = captureIo();
  const code = await runCli(
    [
      "node",
      "spicyapi",
      "tasks",
      "create",
      "--model",
      "provider/model",
      "--input-json",
      "{}",
      "--retention",
      "forever",
      "--yes",
    ],
    dependencies(rejected.io, mockFetch),
  );
  assert.notEqual(code, 0);
  assert.match(rejected.stderr.join(""), /30m, 1h, or 7d/);
  assert.equal(seen.length, 5);
});

void test("tasks get says \"it expired\" and \"you deleted it\" differently", async () => {
  /* `purgedAt` and `contentRemovedBy` are top-level on TaskRecord while `retention` holds the policy
     alone. Passing them separately is what preserves "the purge time is still reportable when there
     is no retention block". */
  const record = (
    contentState: string,
    top: Record<string, string>,
    retention?: Record<string, string>,
  ) => ({
    code: 200,
    msg: "success",
    request_id: "req_get",
    data: {
      taskId: "job_state",
      model: "provider/model",
      state: "succeeded",
      cost: "0.10",
      settled: true,
      createdAt: "2026-09-13T00:00:00Z",
      contentState,
      ...top,
      ...(retention ? { retention } : {}),
    },
  });

  const purged = captureIo();
  assert.equal(
    await runCli(
      ["node", "spicyapi", "tasks", "get", "job_state"],
      dependencies(purged.io, () =>
        Promise.resolve(
          Response.json(
            record("purged", { purgedAt: "2026-09-13T10:00:00Z", contentRemovedBy: "user" }),
          ),
        ),
      ),
    ),
    0,
  );
  const purgedOut = purged.stdout.join("");
  assert.match(purgedOut, /Destroyed — you removed the outputs on 2026-09-13T10:00:00Z/);
  assert.equal(purgedOut.includes("Expired"), false);

  const expired = captureIo();
  assert.equal(
    await runCli(
      ["node", "spicyapi", "tasks", "get", "job_state"],
      dependencies(expired.io, () =>
        Promise.resolve(
          Response.json(
            record("expired", {}, { outputsExpireAt: "2026-09-12T10:00:00Z", source: "account" }),
          ),
        ),
      ),
    ),
    0,
  );
  const expiredOut = expired.stdout.join("");
  assert.match(expiredOut, /Expired — outputs were removed on 2026-09-12T10:00:00Z/);
  assert.match(expiredOut, /Retention set by: account/);
  assert.equal(expiredOut.includes("you removed"), false);
});

void test("on the public surface, status reads an absent /readyz as usable and prints one sentence", async () => {
  const captured = captureIo();
  const responses: Record<string, Response> = {
    "/healthz": new Response('{"status":"ok"}', { status: 200 }),
    "/readyz": new Response("404 page not found", { status: 404 }),
  };
  const mockFetch: typeof fetch = (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const path = new URL(url).pathname;
    return Promise.resolve(responses[path]!.clone());
  };

  const code = await runCli(
    ["node", "spicyapi", "--service-base-url", "http://127.0.0.1:4020", "status"],
    dependencies(captured.io, mockFetch),
  );

  assert.equal(code, 0);
  const output = captured.stdout.join("");
  assert.match(output, /^SpicyAPI is reachable — 127\.0\.0\.1:4020 answered in \d+ ms\.\n$/);
  // This was the most prominent line in the four lines of raw JSON, and the one that turned people
  // away.
  assert.equal(output.includes("operational"), false);
});

void test("a 403 is reported as a refused origin rather than an outage, and does not point at the status page", async () => {
  // A colleague reviewing this hit a 403 on their own machine: a direct connection failed and only
  // the system proxy worked - meaning what was refused was the request's origin, not the service.
  // This message used to say "SpicyAPI is not healthy" and link to the status page, so people went
  // and looked at a status page that was entirely green, and got stuck with nowhere left to look.
  //
  // That is a signal pointing the wrong way - more expensive than no signal at all, because it
  // consumes the time budget for investigating.
  for (const status of [403, 451]) {
    const captured = captureIo();
    const responses: Record<string, Response> = {
      "/healthz": new Response("blocked", { status }),
      "/readyz": new Response("blocked", { status }),
    };
    const mockFetch: typeof fetch = (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const path = new URL(url).pathname;
      return Promise.resolve(responses[path]!.clone());
    };

    // Note that the status command always returns 0, whether or not the service is usable, so the
    // exit code is not asserted here - that is a separate design question and out of scope.
    await runCli(
      ["node", "spicyapi", "--service-base-url", "http://127.0.0.1:4020", "status"],
      dependencies(captured.io, mockFetch),
    );

    const output = captured.stdout.join("") + captured.stderr.join("");
    assert.match(output, /refused this request/, `HTTP ${status} did not say the origin was refused`);
    assert.match(output, /proxy|region/, `HTTP ${status} did not say what to check`);
    assert.equal(
      output.includes("status.spicyapi.ai"),
      false,
      `HTTP ${status} pointed at the status page, where everything is green`,
    );
    assert.equal(
      output.includes("not healthy"),
      false,
      `HTTP ${status} was described as an outage when the real cause is the request origin`,
    );
  }
});

void test("status --json preserves the probe structure unchanged", async () => {
  const captured = captureIo();
  const responses: Record<string, Response> = {
    "/healthz": new Response('{"status":"ok"}', { status: 200 }),
    "/readyz": new Response("404 page not found", { status: 404 }),
  };
  const mockFetch: typeof fetch = (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    return Promise.resolve(responses[new URL(url).pathname]!.clone());
  };

  const code = await runCli(
    ["node", "spicyapi", "--json", "status"],
    dependencies(captured.io, mockFetch),
  );

  assert.equal(code, 0);
  const status = JSON.parse(captured.stdout.join("")) as {
    operational: boolean;
    readiness: { path: string; status: number };
    health: { path: string };
    checkedAt: string;
  };
  assert.equal(status.operational, true);
  assert.equal(status.health.path, "/healthz");
  assert.equal(status.readiness.path, "/readyz");
  assert.equal(status.readiness.status, 404);
  assert.equal(typeof status.checkedAt, "string");
});

void test("when genuinely unreachable, status names who failed to answer", async () => {
  const captured = captureIo();
  const mockFetch: typeof fetch = () => Promise.reject(new Error("connect ECONNREFUSED"));

  const code = await runCli(
    ["node", "spicyapi", "--service-base-url", "http://127.0.0.1:4020", "status"],
    dependencies(captured.io, mockFetch),
  );

  assert.equal(code, 0);
  const output = captured.stdout.join("");
  assert.match(output, /could not be reached/);
  assert.match(output, /127\.0\.0\.1:4020/);
  assert.match(output, /SPICY_SERVICE_BASE_URL/);
});

void test("a 401 adds a next step in the terminal after the server's message", async () => {
  const captured = captureIo({ env: { SPICY_API_KEY: "sk-openai-not-ours-0000" } });
  const mockFetch: typeof fetch = () =>
    Promise.resolve(
      Response.json(
        { code: 401, msg: "Credentials are invalid or expired", request_id: "req_401" },
        { status: 401 },
      ),
    );

  const code = await runCli(
    ["node", "spicyapi", "models", "list"],
    dependencies(captured.io, mockFetch),
  );

  assert.equal(code, 1);
  const stderr = captured.stderr.join("");
  assert.match(stderr, /Error: Credentials are invalid or expired \(request req_401\)/);
  assert.match(stderr, /Next: SPICY_API_KEY starts with "sk-openai", not "sk-spicy-"/);
  assert.match(stderr, /console\/keys/);
  // Only the first 9 characters are echoed; the key itself never reaches a terminal or a CI log.
  assert.equal(stderr.includes("sk-openai-not-ours-0000"), false);
});

void test("with no key set, a 401 says plainly that the key is not exported", async () => {
  const captured = captureIo();
  const mockFetch: typeof fetch = () =>
    Promise.resolve(
      Response.json(
        { code: 401, msg: "Credentials are invalid or expired", request_id: "req_401" },
        { status: 401 },
      ),
    );

  const code = await runCli(
    ["node", "spicyapi", "models", "list"],
    dependencies(captured.io, mockFetch),
  );

  assert.equal(code, 1);
  assert.match(captured.stderr.join(""), /Next: SPICY_API_KEY is not set in this shell\./);
});

void test("a 429 lifts Retry-After into the next-step advice", async () => {
  const captured = captureIo();
  const mockFetch: typeof fetch = () =>
    Promise.resolve(
      Response.json(
        { code: 429, msg: "Too many requests", request_id: "req_429" },
        { status: 429, headers: { "Retry-After": "7" } },
      ),
    );

  const code = await runCli(
    ["node", "spicyapi", "models", "list"],
    dependencies(captured.io, mockFetch),
  );

  assert.equal(code, 1);
  const stderr = captured.stderr.join("");
  assert.match(stderr, /Next: back off and retry in 7s \(Retry-After\)\./);
  assert.match(stderr, /per account/);
});

void test("error output under --json carries no prose advice", async () => {
  const captured = captureIo();
  const mockFetch: typeof fetch = () =>
    Promise.resolve(
      Response.json(
        { code: 401, msg: "Credentials are invalid or expired", request_id: "req_401" },
        { status: 401 },
      ),
    );

  const code = await runCli(
    ["node", "spicyapi", "--json", "models", "list"],
    dependencies(captured.io, mockFetch),
  );

  assert.equal(code, 1);
  const stderr = captured.stderr.join("");
  assert.equal(stderr.includes("Next:"), false);
  const details = JSON.parse(stderr) as { status: number; requestId: string };
  assert.equal(details.status, 401);
  assert.equal(details.requestId, "req_401");
});

// -- DX-4, from the pre-launch review of 2026-09-16 -------------------------

void test("when --wait fails after acceptance, the taskId and a recovery command are still handed over", async () => {
  const captured = captureIo();
  // Quote, then a successful task creation, then polling that cannot connect. This is the most
  // dangerous stretch: the task is already running on the server and already being billed, while the
  // user holds nothing. Re-running the same command generates a new idempotency key, creating a
  // second task and paying a second time.
  const mockFetch: typeof fetch = (input) => {
    // `fetch`'s first argument may be a URL object or a Request, and `String(Request)` yields
    // "[object Request]", so read each case explicitly rather than relying on stringification.
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/quote")) {
      return Promise.resolve(
        Response.json({
          code: 200,
          msg: "success",
          request_id: "req_quote",
          data: {
            quoteId: "quote_cli",
            model: "provider/model",
            estimatedCost: "0.10",
            maxCharge: "0.10",
            currency: "USD",
            quantity: "1",
            unit: "per_request",
            expiresAt: "2099-01-01T00:00:00Z",
          },
        }),
      );
    }
    if (url.includes("/createTask")) {
      return Promise.resolve(
        Response.json({
          code: 200,
          msg: "success",
          request_id: "req_create",
          data: { taskId: "job_accepted_but_lost", state: "queued", estimatedCost: "0.10" },
        }),
      );
    }
    return Promise.reject(new TypeError("network request failed"));
  };

  const code = await runCli(
    [
      "node",
      "spicyapi",
      "--json",
      "tasks",
      "create",
      "--model",
      "provider/model",
      "--input-json",
      '{"prompt":"hello"}',
      "--idempotency-key",
      "idem_lost",
      "--wait",
      "--wait-timeout-ms",
      "50",
      "--yes",
    ],
    dependencies(captured.io, mockFetch),
  );

  assert.equal(code, 1);
  const stderr = captured.stderr.join("");
  // Written out the moment the task is accepted: a wait can be interrupted by Ctrl-C and never
  // reach any catch block.
  assert.match(stderr, /Accepted: job_accepted_but_lost/);
  assert.match(stderr, /spicyapi tasks get job_accepted_but_lost/);

  // Under --json the final error object has to carry it too, or a script has no way to recover.
  const lines = stderr.trim().split("\n");
  const failure = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
  assert.equal(failure.taskId, "job_accepted_but_lost");
  assert.equal(failure.idempotencyKey, "idem_lost");
  assert.equal(failure.recover, "spicyapi tasks get job_accepted_but_lost");
  assert.equal(stderr.includes("sk_cli_secret"), false);
});

void test("--input-file and stdin strip the UTF-8 BOM written by Windows PowerShell", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spicy-cli-bom-"));
  try {
    const inputPath = join(directory, "input.json");
    await writeFile(inputPath, '\uFEFF{"prompt":"hello"}', "utf8");
    const bodies: string[] = [];
    const mockFetch: typeof fetch = (_input, init) => {
      bodies.push(typeof init?.body === "string" ? init.body : "");
      return Promise.resolve(
        Response.json({
          code: 200,
          msg: "success",
          request_id: "req_quote",
          data: {
            quoteId: "quote_bom",
            model: "provider/model",
            estimatedCost: "0.10",
            maxCharge: "0.10",
            currency: "USD",
            quantity: "1",
            unit: "per_request",
            expiresAt: "2026-09-17T12:05:00Z",
          },
        }),
      );
    };

    const fromFile = captureIo();
    const fileCode = await runCli(
      ["node", "spicyapi", "--json", "tasks", "quote", "--model", "provider/model"].concat([
        "--input-file",
        inputPath,
      ]),
      dependencies(fromFile.io, mockFetch),
    );
    assert.equal(fileCode, 0, fromFile.stderr.join(""));

    const fromStdin = captureIo({ readStdin: () => Promise.resolve('\uFEFF{"prompt":"hello"}') });
    const stdinCode = await runCli(
      ["node", "spicyapi", "--json", "tasks", "quote", "--model", "provider/model"].concat([
        "--input-file",
        "-",
      ]),
      dependencies(fromStdin.io, mockFetch),
    );
    assert.equal(stdinCode, 0, fromStdin.stderr.join(""));

    assert.equal(bodies.length, 2);
    for (const body of bodies) {
      assert.deepEqual((JSON.parse(body) as { input: unknown }).input, { prompt: "hello" });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("in human-readable mode, a wait that fails after acceptance carries the taskId and recovery command on the final error, with Next derived from the underlying error", async () => {
  const captured = captureIo();
  const mockFetch: typeof fetch = (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/quote")) {
      return Promise.resolve(
        Response.json({
          code: 200,
          msg: "success",
          request_id: "req_quote",
          data: {
            quoteId: "quote_cli",
            model: "provider/model",
            estimatedCost: "0.10",
            maxCharge: "0.10",
            currency: "USD",
            quantity: "1",
            unit: "per_request",
            expiresAt: "2099-01-01T00:00:00Z",
          },
        }),
      );
    }
    if (url.includes("/createTask")) {
      return Promise.resolve(
        Response.json({
          code: 200,
          msg: "success",
          request_id: "req_create",
          data: { taskId: "job_human_wait", state: "queued", estimatedCost: "0.10" },
        }),
      );
    }
    // Polling hits a 503: once wrapped it is no longer a SpicyApiError, so without unwrapping there
    // is no Next line.
    return Promise.resolve(
      Response.json(
        { code: 503, msg: "Service temporarily unavailable", request_id: "req_poll" },
        { status: 503 },
      ),
    );
  };

  const code = await runCli(
    [
      "node",
      "spicyapi",
      "tasks",
      "create",
      "--model",
      "provider/model",
      "--input-json",
      '{"prompt":"hello"}',
      "--idempotency-key",
      "idem_human",
      "--wait",
      "--yes",
    ],
    dependencies(captured.io, mockFetch),
  );

  assert.equal(code, 1);
  const stderr = captured.stderr.join("");
  const errorAt = stderr.indexOf("Error: Service temporarily unavailable (request req_poll)");
  assert.ok(errorAt >= 0, stderr);
  // Beyond the two lines written at acceptance, it is repeated after the error: those are the lines
  // people actually read last.
  const tail = stderr.slice(errorAt);
  assert.match(tail, /Task job_human_wait was accepted/);
  assert.match(tail, /Recover: spicyapi tasks get job_human_wait/);
  assert.match(tail, /--idempotency-key idem_human/);
  assert.match(tail, /Next: this one is on our side/);
  assert.equal(stderr.includes("sk_cli_secret"), false);
});

void test("with SPICY_API_KEY unset: no request goes out, the human form gets a Next line, and --json gets a type that states the reason", async () => {
  let called = false;
  const noKey = (io: CliIo): CliDependencies => ({
    io,
    createClient: (options) =>
      new SpicyClient({
        ...options,
        // An empty string is treated like unset: the SDK trims it and never consults the host
        // environment.
        apiKey: "",
        apiBaseUrl: "http://127.0.0.1:4020/api/v1",
        fetch: () => {
          called = true;
          return Promise.resolve(Response.json({ code: 500, msg: "unexpected" }));
        },
        maxRetries: 0,
      }),
  });

  const human = captureIo();
  assert.equal(await runCli(["node", "spicyapi", "models", "list"], noKey(human.io)), 1);
  const stderr = human.stderr.join("");
  assert.match(stderr, /Error: SPICY_API_KEY is required/);
  assert.match(stderr, /Next: SPICY_API_KEY is not set in this shell/);
  assert.match(stderr, /export SPICY_API_KEY=/);
  assert.match(stderr, /console\/keys/);

  const json = captureIo();
  assert.equal(await runCli(["node", "spicyapi", "--json", "balance"], noKey(json.io)), 1);
  const details = JSON.parse(json.stderr.join("")) as { type: string; error: string };
  assert.equal(details.type, "MissingApiKeyError");
  assert.match(details.error, /SPICY_API_KEY/);
  assert.equal(json.stderr.join("").includes("Next:"), false);

  assert.equal(called, false);
});

void test("docs search says so when nothing matches, still exits 0, and still prints an empty array under --json", async () => {
  const noClient: CliDependencies["createClient"] = () => {
    throw new Error("docs search must not create an API client");
  };
  const human = captureIo();
  assert.equal(
    await runCli(["node", "spicyapi", "docs", "search", "zzqxvw"], {
      io: human.io,
      createClient: noClient,
    }),
    0,
  );
  assert.match(human.stdout.join(""), /No documentation matched "zzqxvw"/);

  const json = captureIo();
  assert.equal(
    await runCli(["node", "spicyapi", "--json", "docs", "search", "zzqxvw"], {
      io: json.io,
      createClient: noClient,
    }),
    0,
  );
  assert.deepEqual(JSON.parse(json.stdout.join("")), []);
});

// -- Reference documents and 403 business codes, 2026-10-05 -------------------------------------

/** A fake upload backend: sign the ticket, accept the PUT, commit - recording what was declared. */
function uploadBackend(seen: { ticket?: Record<string, unknown>; put?: boolean }): typeof fetch {
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/common/upload-url")) {
      seen.ticket = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Promise.resolve(
        Response.json({
          code: 200,
          msg: "success",
          request_id: "req_ticket",
          data: {
            fileId: "fil_doc",
            key: "spicy://f/fil_doc",
            uploadUrl: "http://127.0.0.1:4020/upload/fil_doc",
            method: "PUT",
            headers: { "Content-Type": String(seen.ticket["contentType"]) },
            expiresAt: "2026-10-05T00:20:00Z",
            maxBytes: 90 * 1024 * 1024,
          },
        }),
      );
    }
    if (url.endsWith("/upload/fil_doc")) {
      seen.put = true;
      return Promise.resolve(new Response("", { status: 200 }));
    }
    if (url.endsWith("/files/fil_doc/commit")) {
      return Promise.resolve(
        Response.json({
          code: 200,
          msg: "success",
          request_id: "req_commit",
          data: {
            fileId: "fil_doc",
            status: "ready",
            bytes: 9,
            contentType: seen.ticket?.["contentType"],
            sha256: "a".repeat(64),
            uri: "spicy://f/fil_doc",
            expiresAt: "2026-10-06T00:00:00Z",
          },
        }),
      );
    }
    return Promise.resolve(Response.json({ code: 500, msg: "unexpected" }, { status: 500 }));
  };
}

void test("files upload takes reference documents, naming their type itself because the SDK cannot", async () => {
  // The server has accepted PDF, Office, iWork, TXT and Markdown uploads since 2026-09-29 (for
  // fields such as reference_file_url), while the published SDK infers only eight media types from
  // an extension. Before this, `files upload brief.pdf` failed locally with a list of image, video
  // and audio extensions - which reads as "the platform does not take documents".
  const directory = await mkdtemp(join(tmpdir(), "spicy-cli-upload-"));
  try {
    const cases: Array<[string, string]> = [
      ["brief.PDF", "application/pdf"],
      ["deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
      ["notes.md", "text/markdown"],
      ["frame.jpg", "image/jpeg"],
    ];
    for (const [name, expected] of cases) {
      const filePath = join(directory, name);
      await writeFile(filePath, "%PDF-1.7\n");
      const captured = captureIo();
      const seen: { ticket?: Record<string, unknown>; put?: boolean } = {};
      const code = await runCli(
        ["node", "spicyapi", "--json", "files", "upload", filePath],
        dependencies(captured.io, uploadBackend(seen)),
      );
      assert.equal(code, 0, `${name}: ${captured.stderr.join("")}`);
      assert.equal(seen.ticket?.["contentType"], expected, `${name} was declared with the wrong type`);
      assert.equal(seen.put, true, `${name}: the bytes must genuinely be PUT`);
      const result = JSON.parse(captured.stdout.join("")) as { uri: string; contentType: string };
      assert.equal(result.uri, "spicy://f/fil_doc");
      assert.equal(result.contentType, expected);
    }

    // An explicit --content-type is accepted for documents too, and wins over the extension.
    const explicit = captureIo();
    const seen: { ticket?: Record<string, unknown> } = {};
    const filePath = join(directory, "export.bin");
    await writeFile(filePath, "plain words");
    assert.equal(
      await runCli(
        ["node", "spicyapi", "--json", "files", "upload", filePath, "--content-type", "text/plain"],
        dependencies(explicit.io, uploadBackend(seen)),
      ),
      0,
    );
    assert.equal(seen.ticket?.["contentType"], "text/plain");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("an unknown extension is refused before any request, and the message lists documents too", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spicy-cli-upload-"));
  try {
    const filePath = join(directory, "clip.xyz");
    await writeFile(filePath, "bytes");
    const captured = captureIo();
    let requests = 0;
    const code = await runCli(
      ["node", "spicyapi", "files", "upload", filePath],
      dependencies(captured.io, () => {
        requests += 1;
        return Promise.resolve(Response.json({ code: 500, msg: "unexpected" }, { status: 500 }));
      }),
    );
    assert.equal(code, 1);
    assert.equal(requests, 0, "no ticket may be requested for a file whose type is unknown");
    const stderr = captured.stderr.join("");
    assert.match(stderr, /--content-type is required unless the file extension is one of: /);
    for (const extension of ["jpg", "mp4", "mp3", "pdf", "docx", "md"]) {
      assert.match(stderr, new RegExp(`\\b${extension}\\b`), `${extension} is missing from the list`);
    }

    const invalid = captureIo();
    assert.notEqual(
      await runCli(
        ["node", "spicyapi", "files", "upload", filePath, "--content-type", "application/zip"],
        dependencies(invalid.io, () => Promise.reject(new Error("must not be called"))),
      ),
      0,
    );
    assert.match(invalid.stderr.join(""), /application\/pdf/, "the accepted list must name documents");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("each 403 business code gets its own next step, and none of them is the allowlist one by mistake", async () => {
  // Every 403 used to read "check the key's model and IP allowlists". An account whose email is not
  // verified yet (40310) or a request from a region the service is not offered in (40303) was sent
  // to a settings page with nothing wrong on it.
  const forbidden = (body: unknown, contentType = "application/json"): typeof fetch => {
    return () =>
      Promise.resolve(
        new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status: 403,
          headers: { "Content-Type": contentType },
        }),
      );
  };
  const cases: Array<[string, typeof fetch, RegExp]> = [
    [
      "40310",
      forbidden({ code: 40310, msg: "Verify your email address", request_id: "req_1" }),
      /Next: verify your account email first/,
    ],
    [
      "40303",
      forbidden({ code: 40303, msg: "Not available", request_id: "req_2" }),
      /Next: SpicyAPI is not offered in the region this request came from/,
    ],
    [
      "40301",
      forbidden({ code: 40301, msg: "Model not allowed", request_id: "req_3" }),
      /Next: this key may not call this model/,
    ],
    [
      "40302",
      forbidden({ code: 40302, msg: "IP not allowed", request_id: "req_4" }),
      /Next: this network address is not on the key's IP allowlist/,
    ],
    [
      "403",
      forbidden({ code: 403, msg: "Forbidden", request_id: "req_5" }),
      /Next: this key is not allowed to do that/,
    ],
    [
      "gateway",
      forbidden("<html><body>Access denied by corporate proxy</body></html>", "text/html"),
      /Next: this refusal carries no SpicyAPI error code/,
    ],
  ];
  for (const [label, mockFetch, expected] of cases) {
    const captured = captureIo({ env: { SPICY_API_KEY: "sk-spicy-test" } });
    const code = await runCli(
      ["node", "spicyapi", "models", "list"],
      dependencies(captured.io, mockFetch),
    );
    assert.equal(code, 1, label);
    const stderr = captured.stderr.join("");
    assert.match(stderr, expected, `${label}: ${stderr}`);
    if (label !== "403" && label !== "40301" && label !== "40302") {
      assert.equal(stderr.includes("allowlist"), false, `${label} pointed at the key allowlists`);
    }
  }
});

void test("the CLI accepts every upload type the bundled contract lists", async () => {
  // The upload list has fallen behind the service twice (audio and video, then documents), each
  // time looking like "the platform does not take this". The bundled contract arrives with each SDK
  // release, so this goes red on the first SDK upgrade that adds a type the CLI does not know.
  const contract = await readOpenApiContract();
  const block = /UploadURLRequest:[\s\S]*?contentType: \{[^}]*enum: \[([^\]]+)\]/.exec(contract);
  assert.ok(block?.[1], "UploadURLRequest.contentType enum not found in the bundled contract");
  const listed = block[1].split(",").map((value) => value.trim());
  assert.ok(listed.includes("image/png"), "the parsed enum is not the upload one");
  for (const contentType of listed) {
    assert.ok(
      (SUPPORTED_UPLOAD_CONTENT_TYPES as readonly string[]).includes(contentType),
      `the contract accepts ${contentType} but the CLI refuses it`,
    );
  }
});
