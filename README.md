# @spicyapi/cli

The official command-line client for [SpicyAPI](https://spicyapi.ai). `spicyapi` lets you browse the
models your account can use, check a price, generate images, videos and audio, wait for them and
download the results — by typing commands in a terminal, without writing any code.

It is useful when you want to try models and prices before anyone writes an integration, generate
media from your own computer, or check a model's exact settings before building on top of it.

This package installs the `spicyapi` binary and depends on `@spicyapi/sdk`. It does **not** contain
the MCP server or the Agent Skill. The full, step-by-step guide lives at
[docs.spicyapi.ai/docs/cli](https://docs.spicyapi.ai/docs/cli).

## What you can do

| I want to…                                            | Command                                 | Costs money? | Needs a key?                  |
| ----------------------------------------------------- | --------------------------------------- | ------------ | ----------------------------- |
| Check that SpicyAPI is reachable                      | `spicyapi status`                       | No           | No                            |
| Search the documentation                              | `spicyapi docs search <words>`          | No           | No                            |
| See which models I can use, and their prices          | `spicyapi models list`                  | No           | Yes                           |
| See which settings one model accepts                  | `spicyapi models get <model>`           | No           | Yes                           |
| Check my balance                                      | `spicyapi balance`                      | No           | Yes                           |
| See how much the current key has spent                | `spicyapi usage`                        | No           | Yes                           |
| Get the exact price of a generation without starting  | `spicyapi tasks quote`                  | No           | Yes                           |
| Start an image, video or audio generation             | `spicyapi tasks create`                 | **Yes**      | Yes                           |
| Wait for a generation to finish                       | `spicyapi tasks wait <task-id>`         | No           | Yes                           |
| Look at one generation and its result links           | `spicyapi tasks get <task-id>`          | No           | Yes                           |
| List my recent generations                            | `spicyapi tasks list`                   | No           | Yes                           |
| Run a failed or expired generation again              | `spicyapi tasks retry <task-id>`        | **Yes**      | Yes                           |
| Permanently delete a finished generation's content    | `spicyapi tasks purge <task-id>`        | No refund    | Yes                           |
| Upload a picture, video, audio or a document as input | `spicyapi files upload <path>`          | No           | Yes                           |
| Get a fresh download link for a result                | `spicyapi files download-url <task-id>` | No           | Yes                           |
| Check that a callback really came from SpicyAPI       | `spicyapi webhooks verify`              | No           | No (uses your webhook secret) |

Only `tasks create` and `tasks retry` spend money, and both stop and ask before anything is charged.
Words in angle brackets, such as `<task-id>`, mean "put your own value here", without the brackets.

## Before you start

### 1. Node.js 22.13 or later

Open a terminal (macOS: **Cmd + Space**, type `Terminal`; Windows: open **PowerShell** from the
Start menu) and check:

```bash
node -v
```

If it prints `v22.13.0` or higher you are ready. Otherwise install the **LTS** version from
[nodejs.org](https://nodejs.org), then close and reopen the terminal. Node.js includes `npm` and
`npx`.

### 2. An API key

1. Create an account at [spicyapi.ai/register](https://spicyapi.ai/register) — accounts are opened
   in batches, so you may join the waitlist first.
2. Add funds under [Billing](https://spicyapi.ai/console/billing). Prices are in US dollars.
3. On the [API keys page](https://spicyapi.ai/console/keys), click **Create key**. The key starts
   with `sk-spicy-` and is shown **once**, so copy it right away. New keys come with a low daily
   spend cap, which you can change on the same page.

Treat the key like a password: anyone who has it can spend your balance. Never paste it into chat,
screenshots, support tickets or a file that gets committed to a repository. If it leaks, revoke it
and create a new one.

### 3. Put the key in `SPICY_API_KEY`

There is no `login` command and no config file: the CLI reads `SPICY_API_KEY` from the process
environment only. It is never accepted as a command argument, so it cannot end up in a process
listing, and the CLI never prints it.

macOS / Linux, current window only:

```bash
export SPICY_API_KEY="sk-spicy-..."   # paste your own key
```

To keep it, add that line to `~/.zshrc` (macOS) or `~/.bashrc` (most Linux systems) and open a new
terminal. Check it without printing the key: `echo "${SPICY_API_KEY:0:9}"` should print `sk-spicy-`.

Windows PowerShell, current window only:

```powershell
$env:SPICY_API_KEY = "sk-spicy-..."
```

To keep it, search the Start menu for **Edit environment variables for your account** and add
`SPICY_API_KEY` there, then open a new PowerShell window. Check it with
`$env:SPICY_API_KEY.Substring(0, 9)`.

### 4. Run it with npx, or install it once

```bash
npx @spicyapi/cli status
```

npm asks once whether to install the package; answer `y`. With this method, write
`npx @spicyapi/cli` wherever this README writes `spicyapi`.

Running it often? Install it once and drop the `npx`:

```bash
npm install -g @spicyapi/cli
spicyapi status
```

If the global install fails with `EACCES`, keep using `npx`.

## Your first result, step by step

**1. Check the connection.** `status` needs no key at all and answers in one line:

```bash
spicyapi status
```

```text
SpicyAPI is reachable — api.spicyapi.ai answered in 118 ms.
```

Add `--json` for the raw health and readiness probes behind it.

**2. Check your balance.** This is the first command that uses your key.

```bash
spicyapi balance
```

```text
available: 12.34
held: 0.06
total: 12.40
```

Amounts are US dollars: `available` is what you can spend, `held` is set aside for tasks still
running.

**3. Find a model you can call**, and copy one `model` value from the output:

```bash
spicyapi models list --modality image --json
```

Choose an item whose `enabled` and `available` are both `true`. IDs read `<maker>/<model>/<task>`.
The live catalog decides what your account can call today, so use an ID from this list rather than
one you remember. The commands below write `MODEL_ID_FROM_CATALOG` where that ID goes: it is a
placeholder, not a model, so paste your own ID in its place. `pricing` shows your price per `unit`
(`per_image`, `per_second`, `per_request`, `per_1k_tokens` or `per_1k_characters`).

**4. Read that model's exact settings** — never guess the fields:

```bash
spicyapi models get MODEL_ID_FROM_CATALOG --json
```

In `inputSchema`, `required` lists the settings you must send, `properties` lists every setting the
model accepts (one unknown field is rejected), and `enum` lists allowed values. For ready-made
inputs the server has already validated, add `--include-examples` to `models list`.

**5. Write the input to a file.** A file avoids shell quoting problems, especially in PowerShell.
Save this as `input.json` with a plain-text editor (Notepad on Windows). UTF-8 with or without a
byte order mark (BOM) both work; avoid `echo … > input.json` in Windows PowerShell 5.1, which writes
UTF-16:

```json
{ "prompt": "A cinematic night portrait" }
```

On macOS and Linux you can pass it inline instead:
`--input-json '{"prompt":"A cinematic night portrait"}'`.

**6. Check the price (optional).** This creates nothing and reserves nothing:

```bash
spicyapi tasks quote --model MODEL_ID_FROM_CATALOG --input-file input.json
```

It prints `estimatedCost`, `maxCharge` and `expiresAt`; a quote is valid for five minutes.

**7. Create the task and wait for the result:**

```bash
spicyapi tasks create \
  --model MODEL_ID_FROM_CATALOG \
  --input-file input.json \
  --wait
```

It prints the estimated charge, the maximum charge and the idempotency key, then asks
`Continue? [y/N]` before spending anything. Type `y`. As soon as the task is accepted it prints
`Accepted: <task-id>` and a recovery command, then waits and prints the finished task. Look for
`"state":"succeeded"` and the `"url"` inside `output.assets`.

**8. Download the file.** The result URL needs no key and stays valid for about 20 minutes; open it
in a browser, or:

```bash
curl -L -o result.png "PASTE_THE_URL_HERE"   # Windows: curl.exe
```

`tasks get` or `files download-url` returns a fresh link. Generated files are kept for about 14 days
at most, so download what you want to keep.

## Reading the output

- By default each field is printed as `name: value`; nested values are printed as one-line JSON.
- `--json` prints the complete result as indented JSON. It works before or after the command name.
- Results go to stdout. Prices, the idempotency key, `Accepted:` lines and errors go to stderr, so
  `spicyapi --json tasks get <task-id> > task.json` saves only the result.
- Errors read `Error: <message> (request req_…)`, usually followed by a `Next:` line that says what
  to do. Under `--json` the error is a one-line JSON object on stderr with `error`, `type`,
  `status`, `code` and `requestId`, and there is no `Next:` line. A missing key keeps the SDK's
  message (`SPICY_API_KEY is required for authenticated API operations`); its `Next:` line shows
  `export` and PowerShell syntax and where to create a key, and under `--json` its `type` is
  `MissingApiKeyError`.
- Money is a USD decimal string without a `$` sign; times are UTC.
- The exit status is `0` on success and non-zero on failure.

## Command reference

Every command has built-in help: `spicyapi <command> --help`.

### Global options and environment

| Option                        | What it does                                                             | Default                          |
| ----------------------------- | ------------------------------------------------------------------------ | -------------------------------- |
| `--json`                      | Machine-readable JSON output                                             | off                              |
| `--timeout-ms <milliseconds>` | Per-request timeout, 1–120000                                            | `30000`                          |
| `--max-retries <count>`       | Automatic retries of safe requests after network errors, 429 or 5xx, 0–5 | `2`                              |
| `--api-base-url <url>`        | Override `SPICY_API_BASE_URL`                                            | `https://api.spicyapi.ai/api/v1` |
| `--service-base-url <url>`    | Override `SPICY_SERVICE_BASE_URL` (used by `status`)                     | `https://api.spicyapi.ai`        |
| `-V`, `--version`             | Print the version                                                        |                                  |

| Variable                                       | Used for                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| `SPICY_API_KEY`                                | Every command except `status`, `docs search` and `webhooks verify`          |
| `SPICY_WEBHOOK_SECRET`                         | Default secret variable for `webhooks verify`                               |
| `SPICY_API_BASE_URL`, `SPICY_SERVICE_BASE_URL` | Optional address overrides; HTTPS only (plain HTTP is allowed for loopback) |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`        | Send requests through an HTTP(S) proxy, the same variables curl reads       |

Proxy variables work on Node.js 22.21+ or 24+. Node.js's built-in `fetch` ignores them unless it
was started with `NODE_USE_ENV_PROXY=1`, so when the CLI finds an `http://` or `https://` proxy it
restarts itself once with that switch on. Set `NODE_USE_ENV_PROXY=0` to always connect directly.
`socks5://` proxies are not supported.

### Catalog and account

| Command               | What it does                                                            | Billable |
| --------------------- | ----------------------------------------------------------------------- | -------- |
| `status`              | Is the public API reachable? No key needed; `--json` for the raw probes | no       |
| `docs search [query]` | Search the bundled first-party documentation index; no key, no network  | no       |
| `models list`         | List enabled models and your account's prices                           | no       |
| `models get <model>`  | One model and its current input schema                                  | no       |
| `balance`             | Available, held and total USD balance                                   | no       |
| `usage`               | Settled USD usage for the current API key only                          | no       |

`docs search` takes `--limit <count>` (1–25, default 10). Each result's `url` is a page on
`https://docs.spicyapi.ai/docs/…`. When no page matches, it prints
`No documentation matched "<query>".` with a hint and exits `0`; under `--json` it prints `[]`.

`models list` accepts:

| Option               | What it does                                                                        |
| -------------------- | ----------------------------------------------------------------------------------- |
| `--modality <type>`  | `image`, `video`, `audio` or `text`                                                 |
| `--task <task>`      | One task, such as `text-to-image`, `edit`, `image-to-video` or `reference-to-video` |
| `--provider <name>`  | Exact model-maker identifier, as in the `provider` field                            |
| `--search <text>`    | Case-insensitive match on model id or display name                                  |
| `--include-schema`   | Include every model's `inputSchema` (much larger output)                            |
| `--include-examples` | Include server-validated example inputs                                             |

`usage` takes `--from` (inclusive UTC date, `YYYY-MM-DD`) and `--to` (exclusive UTC date, at most 92
days). Leave both out for the last seven days including today. It reports `totalCalls`, `totalSpend`
(settled charges only) and the same tasks grouped by `days` and by `models` — do not add the two
groupings together. It is limited to 30 requests per minute.

### Tasks

| Command                 | What it does                                      | Billable |
| ----------------------- | ------------------------------------------------- | -------- |
| `tasks quote`           | Price the exact request without creating anything | no       |
| `tasks create`          | Create an asynchronous generation task            | **yes**  |
| `tasks retry <task-id>` | Create a new task from a failed or expired one    | **yes**  |
| `tasks get <task-id>`   | Read one task                                     | no       |
| `tasks wait <task-id>`  | Poll until a terminal state                       | no       |
| `tasks list`            | One page of task metadata for the current key     | no       |
| `tasks purge <task-id>` | Destroy one task's stored content, permanently    | no       |

`tasks quote` takes `--model` plus `--input-json` or `--input-file` (use `-` for stdin; a leading
UTF-8 byte order mark in a file or on stdin is ignored), and optionally `--callback-url`. It returns
`estimatedCost`, `maxCharge`, `quantity`, `unit` and `expiresAt`; a quote lasts five minutes.

`tasks create` options:

| Option                              | What it does                                                                                                                                                                                   | Default                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `--model <model>`                   | Exact live catalog model ID (required)                                                                                                                                                         |                          |
| `--input-file <path>`               | Model input JSON file; `-` reads stdin (then `--yes` is required)                                                                                                                              |                          |
| `--input-json <json>`               | Model input as a JSON object (use this or `--input-file`)                                                                                                                                      |                          |
| `--wait`                            | Wait for a terminal state after creation                                                                                                                                                       | off                      |
| `--yes`                             | Confirm the billable action non-interactively                                                                                                                                                  | ask                      |
| `--idempotency-key <key>`           | Stable key for this one generation; a replay returns the same task (24 h, ≤128 chars)                                                                                                          | a new UUID per run       |
| `--retention <duration>`            | Shorten how long generated media, result payload, prompt and other input text are kept: `30m`, `1h`, `7d` or seconds; `0` removes them when the task finishes; billing records are always kept | account settings         |
| `--callback-url <url>`              | Public `https://` URL called when the task finishes; plain `http://`, `localhost` and private addresses are refused                                                                            | none                     |
| `--poll-interval-ms <milliseconds>` | Fixed poll interval with `--wait` (100–60000)                                                                                                                                                  | 2 s, backing off to 10 s |
| `--wait-timeout-ms <milliseconds>`  | Stop waiting after this long (1–86400000); the task keeps running                                                                                                                              | `600000` (10 min)        |

What `tasks create` does, in order: it validates that the input is a JSON object (and refuses before
anything else if you gave none); refuses to continue without a terminal to ask or `--yes`; fetches
and binds an exact quote; prints `Estimated charge`, `maximum charge`, the quote expiry and the
idempotency key; asks `Continue? [y/N]` (only `y` or `yes` proceeds); then creates the task. Without
`--wait` it prints `idempotencyKey`, `taskId`, `state`, `estimatedCost` and `deadlineAt`. With
`--wait` it prints `Accepted: <task-id>` and
`If waiting is interrupted: spicyapi tasks get <task-id>` on stderr the moment the task is accepted,
then `idempotencyKey`, `accepted` and the terminal `task`.

If waiting then fails with an error (a wait timeout, a network error), the task is still accepted
and may still be running. The human-readable error ends with three extra lines, so the recovery path
is never scrolled away:

```text
Error: task job_… did not reach a terminal state within 600000ms
Task job_… was accepted and may still be running; only the wait stopped.
Recover: spicyapi tasks get job_…
To replay the same request without creating a second task, reuse --idempotency-key <key>.
```

A `Next:` line follows when the underlying error has one (for example `429` or a 5xx). Under
`--json` the error object carries `taskId`, `idempotencyKey` and `recover` instead.

You do not need to run `tasks quote` first. `tasks create` fetches and binds the exact quote itself,
then asks you to confirm it. The separate quote command is for comparing prices, not a prerequisite.

`--retention` only ever shortens — your account settings and the platform maximum still apply — and
the deadlines that actually took effect come back in `tasks get` under `retention`. It removes the
same content as `tasks purge`, just on a timer.

`--callback-url` takes a public `https://` address and nothing else. Plain `http://` is refused, and
so are `localhost`, private network addresses, explicit ports other than 443 and 80, and URLs
carrying credentials; each returns `400` with `Invalid callback URL`. There is no development
exception for `http://`, because the delivery body carries the prompt and signed links to the
result. To receive callbacks on your own machine, put a tunnel with a real certificate in front of
it.

`tasks wait` takes `--poll-interval-ms` and `--wait-timeout-ms` (default 10 minutes). A timeout
reads `task <id> did not reach a terminal state within 600000ms`; it is not a failure, and waiting
never cancels a task.

`tasks get` returns `state`, `output.assets[]` (each with a signed `url` valid for about 20 minutes,
`expiresAt`, `mime` and a `key`; `pending: true` means still copying), `errorCode` and
`errorMessage` on failure, `cost` and `settled`, `contentState` and `retention`. Each call returns
fresh links. Use the same API key that created the task. Some models answer in `output.text` instead
of a file — audio transcription is the obvious one, an ordinary asynchronous task whose result is
words — so an empty `output.assets` is not automatically a failure.

`tasks retry` takes `--idempotency-key`, `--yes`, `--wait`, `--poll-interval-ms` and
`--wait-timeout-ms`. It asks for confirmation but, unlike `tasks create`, does not show a price
first: the new task is priced at the model's current price. It returns the new `taskId` and
`sourceTaskId`. Only `failed` and `expired` tasks (and historical `canceled` records) can be
retried; the retry reuses the source input and its retention.

`tasks purge` destroys one terminal task's generated media, result payload, prompt and other input
text. It asks for confirmation or an explicit `--yes`, the same gate as a billable command, because
it cannot be undone. **It destroys content, not the record of what it cost:** the ledger entry,
charged amount, model, state, timestamps and request ID stay queryable, and nothing is refunded. A
queued or running task cannot be purged and cannot be canceled — there is no cancellation API — so
wait for it with `tasks wait`, then purge it. Afterwards `tasks get` reports `contentState: purged`
— distinct from `expired`, which means the retention rules removed it. Purging takes no idempotency
key: the task ID is the idempotency key, so running the command again after a dropped connection
simply reports the original `purgedAt` and changes nothing.

### Task history

```bash
spicyapi --json tasks list --from 2026-09-01 --to 2026-09-07 --state failed --limit 20
```

This reads one page of metadata for the current key with no billable confirmation and no extra task
lookups. When `hasMore` is true, repeat the call with the **same** `--from` and `--to` and
`--cursor` set to the returned `nextCursor`.

- Dates are UTC `[from,to)`, default to seven days ending tomorrow UTC, and span at most 92 days.
- Page size is 20 by default, up to 100. `--model` filters an exact model ID. `--state` accepts
  `queued`, `running`, `succeeded`, `failed`, `canceled` or `expired`.
- `cost` is a decimal USD string and is final only when `settled` is true.
- Hidden tasks are excluded here; use `usage` for settled spending.

Use `tasks get` for a result you actually selected, rather than expanding every row.

### Files and webhooks

| Command                        | What it does                                        |
| ------------------------------ | --------------------------------------------------- |
| `files upload <path>`          | Prepare, PUT and commit a private direct upload     |
| `files download-url <task-id>` | Short-lived URL for a task output                   |
| `webhooks verify`              | Verify a callback signature against exact raw bytes |

`files upload` accepts JPEG, PNG, WebP and GIF images up to 10 MiB; MP4, WebM, MP3 and WAV up to
90 MiB and 600 seconds; and reference documents up to 90 MiB — PDF, Word (`doc`, `docx`), Excel
(`xls`, `xlsx`), PowerPoint (`ppt`, `pptx`), Keynote, Pages, Numbers, plain text and Markdown —
for fields such as `reference_file_url`. The type comes from the file extension, or from
`--content-type`. It prints a `spicy://` `uri` to put in a model input field such as `image_url`.
The URI is usable until `expiresAt`, normally one day.

`files download-url` takes `--key <key>` to pick one output (the first one by default). The link
lasts about 20 minutes; the command prints it and does not save the file.

`webhooks verify` needs `--body-file` (the raw, unmodified body), `--timestamp`, `--signature` and
`--payload-version` (`1` or `2`) from the callback headers, and accepts `--tolerance-seconds`
(default 300). It reads the secret from an environment variable named by `--secret-env`
(`SPICY_WEBHOOK_SECRET` by default). The secret itself is never accepted as an argument.

## Recipes

### Picture to video

```bash
spicyapi models list --modality video --task image-to-video --json
spicyapi models get <model> --json          # find the image field, usually image_url
spicyapi files upload ./start-frame.jpg     # copy the spicy:// uri
```

Put the settings in `input.json`, for example
`{ "prompt": "Slow push-in", "image_url": "spicy://f/fil_…", "duration_seconds": 5 }`, then:

```bash
spicyapi tasks quote --model <model> --input-file input.json
spicyapi tasks create --model <model> --input-file input.json --wait --wait-timeout-ms 1800000
```

Video usually takes minutes, so this waits up to 30 minutes instead of the default 10.

### Pick up a task after the wait was interrupted

The task keeps running (and is charged normally) after a timeout, a dropped connection or Ctrl-C.

- You saw `Accepted: <task-id>`: run `spicyapi tasks wait <task-id>` or
  `spicyapi tasks get <task-id>`.
- You only saw `Idempotency-Key: <key>`: re-run the **same** `tasks create` command with
  `--idempotency-key <key>`. You get the original task back instead of a second one — within 24
  hours, with the same API key, model and input. Running it again without that flag creates, and
  pays for, a second task.
- You saw neither: `spicyapi --json tasks list --limit 10`.

### Retry a failed task

`spicyapi tasks get <task-id>` shows `errorCode`. Failed tasks are never charged. A retry reuses the
original input unchanged, so:

- `rate_limited`, `upstream_unavailable`, `timeout`, `upstream_failed` — wait a little, then retry
  once with `spicyapi tasks retry <task-id> --wait`. If a `timeout` repeats, try a shorter duration
  or lower resolution with `tasks create`.
- `generation_failed` — change the prompt or image and use `tasks create`; the same input usually
  fails the same way.
- `invalid_asset` — upload the file again and use `tasks create` with the new `uri`; a retry would
  reuse the old file.
- `content_rejected`, `invalid_request`, `unsupported_combination` — do not retry unchanged; change
  the prompt, settings or model and use `tasks create`.

`errorMessage` beside the code is for a person to read, never for a script to match on. When the
model service reported a specific reason — a corrupted reference image, a copyright restriction on
generated audio — that sentence comes through in English, untranslated, with service names, hosts,
URLs, request and task IDs and account details removed; otherwise you get SpicyAPI's own normalized
wording. `errorCode` comes from a closed set and is the only stable thing to branch on.

A network error while creating is not a failed task — replay with the original idempotency key
instead. A command can also fail before any task exists, with a business `code` rather than an
`errorCode`. Four of those tell you exactly what to do next:

- **`40003`** — the uploaded bytes do not match the ticket they were committed against. Run
  `files upload` again from the start and use the new `spicy://` URI; re-committing cannot help.
- **`40004`** — the request is valid, but nothing can serve that exact combination of settings.
  Running it again unchanged gives the same answer. Change the setting the message names, checking
  it against `models get <model> --json`.
- **`503`** — something SpicyAPI depends on is briefly unavailable. Wait for the `Retry-After` delay
  and run the command again.
- **`50302`** — a synchronous generation failed upstream and **the charge was already refunded**.
  Running the same command again is safe and is the intended next step.

See the [errors guide](https://docs.spicyapi.ai/docs/errors).

### Export usage

```bash
spicyapi --json usage --from 2026-09-01 --to 2026-10-01 > usage-2026-09.json
```

### Scripts and CI

Without a terminal, billable commands refuse to run unless you pass `--yes`. In a script, quote
first, give each logical generation its own fixed `--idempotency-key`, read `state` from the
`--json` result (exit status 0 does not mean the task succeeded), and set spend caps on the key.

## Costs, confirmation and safety

- **Only `tasks create` and `tasks retry` cost money.** Prices are in US dollars.
- **Price first.** `tasks create` shows the estimated and maximum charge before asking. The estimate
  is held when the task is accepted and is also the most the task can cost; unused funds are
  released.
- **Some video endpoints bill in whole blocks.** Where a model declares a block, the source clip's
  duration is rounded up to the next block boundary before it is priced: on a 5-second block a
  6-second clip is billed as 10 seconds, and on an 8-second block a 6-second clip is billed as 8.
  This is not how per-second pricing works in general — only endpoints that declare a block behave
  this way, and each model's page states its block length. The amount you confirm is still the
  amount held, and the final charge can never exceed it.
- **Confirmation.** `[y/N]` defaults to no. `--yes` answers for you; without a terminal and without
  `--yes`, the CLI refuses rather than assuming yes. `tasks purge` asks the same way.
- **Idempotency key.** A label for one logical generation. If the network drops, re-running with the
  same key returns the original task instead of creating and charging for a second one (24 hours,
  same API key). The same key with a different input is rejected.
- **No cancellation.** An accepted task cannot be canceled; Ctrl-C only stops waiting.
- **Failed and expired tasks are not charged.** The hold is released in full.
- **Keep your results.** Outputs are kept for about 14 days at most (less if your account or
  `--retention` says so); download links last about 20 minutes; uploads last one day.

## Troubleshooting

| You see                                                                         | What to do                                                                                                                      |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `command not found: spicyapi`                                                   | Install globally, or run `npx @spicyapi/cli <command>`                                                                          |
| Windows: `npx.ps1 cannot be loaded because running scripts is disabled`         | Use `npx.cmd`, or run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once                                                |
| `SPICY_API_KEY is required for authenticated API operations`                    | The key is not set in this terminal window; follow the `Next:` line, or open a new window after setting it permanently          |
| `API key format is not recognized` / `Credentials are invalid or expired` (401) | Follow the `Next:` line: fix the variable's value, or create a new key                                                          |
| `Insufficient balance` or a spend-cap message (402)                             | Add funds, or raise the key's cap; asking again does not help                                                                   |
| 403 with `40301` / `40302`                                                      | The key's model or IP allowlist blocks this request                                                                             |
| 403 with `40310`                                                                | Verify your account email: open the link we sent, or send a new one from the console                                            |
| `Refused before reaching SpicyAPI (HTTP 403)`                                   | Something between you and the API answered instead; the message quotes what it said                                             |
| `… is set, but this request did not use it`                                     | Your proxy variable was ignored: update Node.js to 22.21+ or 24+, or run with `NODE_USE_ENV_PROXY=1`                            |
| 404                                                                             | Wrong model or task id, or a task created with another API key; `spicyapi models list` shows callable ids                       |
| 400, or `--input-file is not valid JSON`                                        | Compare the input with `models get <model> --json`; use straight quotes; on Windows save as UTF-8 (Notepad), not UTF-16 via `>` |
| `billable command requires an interactive confirmation or --yes`                | Run it in a terminal, or add `--yes` once you know the price                                                                    |
| `operation canceled`                                                            | You answered no; nothing was created or charged                                                                                 |
| 409                                                                             | The five-minute quote expired while you decided, or an idempotency key was reused for a different input; run again              |
| 429                                                                             | Wait for the `Retry-After` delay; more keys do not raise the account limit                                                      |
| `40003`                                                                         | The uploaded bytes do not match their ticket; run `files upload` again and use the new `spicy://` URI                           |
| `40004`                                                                         | Nothing can serve that exact combination of settings; change the setting named in the message, not the whole request            |
| `503`                                                                           | A dependency is briefly unavailable; wait for `Retry-After` and run the command again                                           |
| `50302`                                                                         | A synchronous generation failed upstream and was already refunded; running the same command again is safe                       |
| `request exceeded the local 30000ms timeout`                                    | Check the network; allow more with `--timeout-ms 120000`                                                                        |
| `did not reach a terminal state within 600000ms`                                | Not a failure: `spicyapi tasks wait <task-id> --wait-timeout-ms 1800000`                                                        |
| `No documentation matched "…"`                                                  | `docs search` found nothing; try fewer or different words                                                                       |
| `--content-type is required unless the file extension is …`                     | Pass `--content-type`, or convert to a supported file type                                                                      |
| 5xx                                                                             | Retry later; if it persists, quote the request id at [spicyapi.ai/contact](https://spicyapi.ai/contact)                         |

## What this CLI does not do

It submits and tracks native asynchronous tasks. It does not stream chat tokens. The catalogue's
text models are reached through the compatible layers instead — `POST /v1/chat/completions` and
`POST /v1/responses` (OpenAI), `POST /v1/messages` (Anthropic) and
`POST /v1beta/models/{model}:generateContent` (Google Gemini), all under `https://api.spicyapi.ai` —
so keep the official client you already use and point its base URL at SpicyAPI. Use native
`jobs/stream` when you need quote confirmation and the platform event envelope — see the
[text and streaming guide](https://docs.spicyapi.ai/docs/text-and-streaming).

Text models that read images, video or audio take them as message parts, and
`spicyapi files upload` returns the `spicy://f/…` URI that goes in an `image_url`, `video_url` or
`audio_url` part (video and audio parts are carried by Chat Completions and `jobs/stream`) — see
[sending media to a text model](https://docs.spicyapi.ai/docs/text-and-streaming#media-input).

An accepted task cannot be canceled. `tasks purge` destroys a finished task's content, but the task
record and its charge remain.

## More

- [CLI guide](https://docs.spicyapi.ai/docs/cli) · [Developer hub](https://spicyapi.ai/developers) ·
  [Full documentation](https://docs.spicyapi.ai/docs)
- Prefer to drive this from a coding agent? Use
  [`@spicyapi/mcp`](https://www.npmjs.com/package/@spicyapi/mcp) instead.
