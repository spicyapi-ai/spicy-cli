# @spicyapi/cli

## 0.7.0

### Minor Changes

- Add the asset library: keep files in a library and reference them as `spicy://a/<id>` in any media
  field of model inputs sent with keys of the same workspace, until they are deleted. An upload's
  `spicy://` URI lasts one day; a saved asset does not expire. The key decides the library: a
  personal key reaches the personal library, a team key that team's shared library, where the
  creator's current role decides what may change.

  - SDK: `client.assets.create`, `list`, `listAll` (an async iterator that follows `nextCursor`),
    `get`, `update`, `delete`, `usage`, and `uploadFile`, which uploads a local file and saves it in
    one call. `create` sends the required `Idempotency-Key` itself (pass `idempotencyKey` to replay
    a save), which also makes its transport retry safe. Asset ids are accepted as `ast_…` or as the
    `spicy://a/…` reference.
  - `SpicyApiError` gains `reason`, read from a failure envelope's `data.reason`. The asset library
    uses `asset_library_locked`, `asset_library_full`, `asset_file_too_large`, `asset_daily_limit`,
    `asset_storage_full`, `asset_permission_denied` and `asset_workspace_forbidden` (exported as
    `ASSET_ERROR_REASONS`, with `isAssetErrorReason`, and kept equal to the contract's enum); any
    other value is passed through unchanged. `AssetUsage` carries `scope` (`AssetScope`: library,
    role, `canWrite`, `canTopUp`), and `lifetimeTopupUsd` / `topupToNextTierUsd` are optional
    because they are omitted when `canTopUp` is false.
  - CLI: `spicyapi assets list | get | save | rename | delete | usage`. `save` takes one of
    `--task <id> [--index n | --key k]`, `--file <path>`, `--url <url>` or `--file-id <id>`;
    `delete` asks first or takes `--yes`. Errors carry `reason` in `--json` output, and the `Next:`
    line follows the reason (a full library is a plan limit, not a schema problem). `assets usage`
    names the library and role the key acts with, and leaves upgrades to the team owner when the key
    cannot top up.
  - MCP: five tools — `spicyapi_assets_list`, `spicyapi_asset_save` (task output, local path under
    the upload roots, URL or committed upload), `spicyapi_asset_rename`, `spicyapi_asset_delete`
    (always confirmed) and `spicyapi_assets_usage_get`, which returns `scope`. Tool errors include
    `reason`.
  - Skill: the asset library workflow, its error reasons, and asset deletion in the cleanup rules.
  - The bundled OpenAPI contract is synchronised with the server, including the asset routes, and
    the documentation index covers five more pages (ComfyUI, SillyTavern, roleplay apps, Telegram
    and Discord bots, n8n).

- Organize the asset library and read its characters. Assets now carry `favorite`, `model` and
  `modelName` (the model that generated them; empty for uploads and links). Folders (collections)
  and characters are created on the Assets page of the web app; the API reads them. Personas became
  characters on 2026-10-12, and existing `spicy://p/<id>` references keep resolving to the same
  images in the personal library.

  - SDK: `assets.list` and `listAll` take `favorite`, `collectionId` (one folder; an unknown folder
    is a 404), `entityId` (one character's images) and `sort` (`recent`, `oldest`, `name`, `size`;
    exported as `AssetSort`). A cursor only works with the sort it came from, and `listAll` repeats
    the filters and sort on every page. `assets.update` changes `name`, `favorite` or both and sends
    only what you pass. New `assets.characters.list({ assetId, cursor, limit })`, `listAll` and
    `get(id)` return `AssetCharacter` records with their images in order. `ASSET_ERROR_REASONS` adds
    `asset_entity_name_taken`, matching the contract. `uploadFile` maps `.safetensors` to
    `application/octet-stream`, the new LoRA weights upload type (up to 2 GiB), and the bundled
    contract and generated types follow the server, including `POST /api/v1/files/import`.
  - CLI: `assets list --favorite | --no-favorite`, `--folder <collection-id>`,
    `--character <character-id>` and `--sort <order>`; `assets favorite <asset>` and
    `assets unfavorite <asset>`; and `characters list [--asset <asset>] [--all]` and
    `characters get <id>`, which print each character's images as `spicy://a/` references plus a
    `References:` array to paste into a model input. A 404 on a folder or a character gets its own
    `Next:` line. `files upload` accepts `.safetensors` LoRA weights.
  - MCP: `spicyapi_assets_list` takes `favorite`, `collectionId`, `entityId` and `sort`. Two
    read-only tools, `spicyapi_characters_list` and `spicyapi_character_get`, return characters with
    their images in order and tell the agent to put those `spicy://a/` references, in order, into
    the model's reference image field — for 22 tools in total. `spicyapi_upload_file` accepts
    `.safetensors` LoRA weights.
  - Skill: favorites, folders, sorting and characters in the asset library workflow, including that
    folders and characters are made on the web and that `spicy://p/` references still work.

### Patch Changes

- Updated dependencies
  - @spicyapi/sdk@0.9.0

## 0.6.0

### Minor Changes

- `files upload` takes reference documents: PDF, Word (`doc`, `docx`), Excel (`xls`, `xlsx`),
  PowerPoint (`ppt`, `pptx`), Keynote, Pages, Numbers, plain text and Markdown, up to 90 MiB, for
  input fields such as `reference_file_url`. The service has accepted them since late September, but
  the CLI only knew eight media types, so `files upload brief.pdf` stopped locally with a list of
  image, video and audio extensions. The type comes from the extension as before, and
  `--content-type` accepts the twelve document types too. An unrecognised extension is now refused
  before any request, with a message that lists every extension the CLI understands.

### Patch Changes

- The `Next:` line after a 403 depends on the business code. It used to tell every refusal to check
  the key's model and IP allowlists, which sent an account with an unverified email (`40310`) or a
  request from an unserved region (`40303`) to a settings page with nothing wrong on it. A 403
  without any SpicyAPI code now points at the proxy, VPN or gateway that answered instead.
- README: list `per_1k_characters` among the price units, mention audio generation, and note that a
  `spicy://f/…` URI from `files upload` is what goes in a text model's `image_url`, `video_url` or
  `audio_url` message part on the compatible endpoints.

## 0.5.7

### Patch Changes

- Honor `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` like curl does. Node.js's built-in `fetch`
  ignores them unless the process starts with `NODE_USE_ENV_PROXY=1`, and nothing can switch that on
  afterwards, so a terminal where curl reached the API through a proxy saw the CLI go out directly
  and fail. On Node.js 22.21+ or 24+, when a proxy variable holds an `http://` or `https://` URL,
  the CLI now restarts itself once with the switch on; input, output and exit status pass through
  unchanged. `NODE_USE_ENV_PROXY=0` opts out. A `socks5://` or bare `host:port` value is left alone,
  because Node.js refuses to start with it once the switch is on.
- Split the 403 rows of the troubleshooting table by business code, including `40310` for an account
  email that is not verified yet.

## 0.5.3

### Patch Changes

- Make `service_status` explain the two statuses that look like outages and are not.

  `/readyz` answers 404 on the public surface **by design** — readiness reveals database and Redis
  state, so the server registers that probe only on its admin process. `operational` has always
  accounted for this, but the reasoning lived in a source comment, so anyone reading the raw
  structure saw `readiness.ok: false` next to `operational: true` and reasonably concluded something
  was broken. The explanation now travels with the output: it is in the MCP output schema and the
  tool description, and in the SDK's own type documentation. A genuine not-ready answer is 503.

  A 403 or 451 is a rejection of where the request came from — a proxy, a gateway, or a region the
  service is not offered in — and the CLI used to report it as `SpicyAPI is not healthy` and point
  at the status page, which shows everything green. It now says the request was refused, names what
  to check, and drops the status-page link.

- Updated dependencies
  - @spicyapi/sdk@0.7.0

## 0.5.2

### Patch Changes

- Fix `spicyapi_models_list` and `spicyapi_model_get` failing outright on 16 of the 121 published
  endpoints. The MCP output schema pinned `policyTier` to three values while the service already
  returns five; `softened` and `filtered` made the MCP SDK reject the structured content, so any
  unfiltered catalogue listing raised `Output validation error` rather than returning models. The
  field is now an open set, because a descriptive classification should never be able to fail a
  call.

  Catch the bundled contract up with the service. New: the anonymous evaluation catalogue
  `GET /console/v1/catalog/models`, which answers "which models are there and what do they cost"
  without an API key; business codes `40003` (uploaded bytes do not match their ticket), `40004` (no
  deployment serves that parameter combination), `503` (dependency briefly unavailable) and `50302`
  (a synchronous generation failed upstream and was already refunded); `toolkit`, marking the models
  that replace a person in an image or a video; per-tier `variants` alongside each price.
  `callBackUrl` now rejects `http://`, task `errorMessage` carries the model service's own reason in
  English when there is one, and `jobs/purge` reads no `Idempotency-Key` — `taskId` is the key.

  Document the subject-swap two-step video workflow, block-rounded duration billing, and where text
  models live: the SDK, CLI and MCP server cover asynchronous media tasks, while chat runs through
  the OpenAI, Anthropic and Gemini compatible layers with an existing client.

- Updated dependencies
  - @spicyapi/sdk@0.6.0

## 0.5.1

### Patch Changes

- `--wait` no longer loses the task when waiting fails after the task was accepted. As soon as the
  server accepts a task, the CLI prints the task ID and a recovery command on stderr, so they
  survive a timeout, a dropped connection or Ctrl-C. If waiting then fails, the error (in both human
  and `--json` output) carries `taskId`, `idempotencyKey` and `recover`
  (`spicyapi tasks get <taskId>`). Previously the only visible output was a network error, and
  re-running the same command created — and paid for — a second task. In human-readable output the
  final error repeats the task ID, the recovery command and the idempotency key to replay with.
- `--input-file` and stdin input tolerate a UTF-8 byte order mark, which Windows editors often add.
- Running a command that needs a key without `SPICY_API_KEY` set now prints a `Next:` line
  explaining how to set it on macOS, Linux and Windows; `--json` reports the error type as
  `MissingApiKeyError`.
- `docs search` prints a message when nothing matches instead of printing nothing.
- `tasks purge` and `--retention` describe the same deletion scope: generated media, result payload,
  prompt and other input text; the ledger entry, charge, model, state, timestamps and request ID
  stay.
- Updated dependencies
  - @spicyapi/sdk@0.5.2

## 0.5.0

### Minor Changes

- Stop reporting a healthy platform as down. `probeStatus` treated a 404 from `/readyz` as "not
  ready", but the readiness probe exposes database and Redis state, so the server registers it only
  on the management process — the public one never had it. `operational` was therefore always false
  on the production domain, and that is the answer to the first command the README recommends, the
  only one that needs no key and costs nothing. A genuine outage still surfaces: an unready service
  answers 503, not 404.

  `spicyapi status` now prints one line a person can read, and keeps the previous structure behind
  `--json`. CLI failures append a `Next:` line saying what to do — for 401 it distinguishes no key
  set, a key whose prefix is not `sk-spicy-`, and a key that the server rejected, echoing only the
  first nine characters.

  Documentation: the README example points at an endpoint that is live and priced instead of a
  paused one, and the MCP setup covers Claude Desktop alongside the other clients.

### Patch Changes

- Updated dependencies
  - @spicyapi/sdk@0.5.1

## 0.4.0

### Minor Changes

- 983dd22: Add customer-controlled retention and on-demand content destruction across all four
  surfaces.

  `createTask` (and `run`) accept `retentionSeconds`, sent as `X-Spicy-Retention`, to shorten how
  long one task's outputs and prompt are kept; `0` removes the outputs as soon as the task reaches a
  terminal state. It can only shorten — the account settings and the platform maximum still apply,
  and the deadlines that actually took effect come back in the task record's new `retention` object.
  An oversized value is clamped by the server rather than rejected, so a request asking to be more
  conservative never fails the generation.

  `purgeTask` destroys one terminal task's generated media, result payload, prompt and input text,
  and is idempotent. It destroys content, not the record of what it cost: the ledger entry, charged
  amount, model, state, timestamps and request ID all remain queryable, so it is never a refund.
  Task records now carry `contentState`, which distinguishes `expired` (the retention rules ran)
  from `purged` (the account destroyed it deliberately) — reporting the second as the first makes it
  look like the platform lost the customer's work.

  The CLI adds `tasks purge`, gated behind the same interactive confirmation or `--yes` as a
  billable command, and `tasks create --retention` accepting `30m`, `1h`, `7d` or plain seconds.
  `tasks get` now spells out the content state and retention deadlines in its human-readable output.

  The MCP server adds `spicyapi_task_purge` with `destructiveHint: true` and a confirmation round.
  Its result is projected onto a fixed whitelist — task ID, content state, removal metadata — so no
  link, ticket or output key can travel in the same message that reports the content's destruction.

### Patch Changes

- 4c586b6: Correct three things the package documentation had wrong. Public model IDs read
  `<publisher>/<model>/<task>` — `bytedance/seedream-5.0-pro/text-to-image` — not the internal
  `<family>/<version>/<task>` slug; the Skill's own workflow reference used the internal shape as
  its placeholder, so an agent reading it would assemble identifiers that do not resolve. There are
  no audio models: the catalog is video, image and chat, and every README opened by claiming
  otherwise. And the quickstarts could not be run as written, because both the model ID and the API
  key were placeholders with no command next to them for obtaining a real one.

  Every README now starts from getting a key (`spicyapi.ai/register`, then the console; keys begin
  `sk-spicy-`) and lists a model before using one. `npx @spicyapi/cli` and `npx @spicyapi/skill` are
  documented without `--yes --package=`, which only `@spicyapi/mcp` needs — it ships two binaries,
  so the short form fails with `could not determine executable to run`. The Skill installs with
  `npx skills add https://spicyapi.ai/skill` through the installer most coding agents share, with
  the packaged installer kept as the second option. The MCP client examples no longer pin `@0.1.0`.

- a096fff: Add `spicyapi_upload_file` so an MCP client can upload a file from the user's machine and
  get back the `spicy://` URI to put in model input. The previous `spicyapi_upload_prepare` handed a
  presigned PUT ticket to the model and nothing ever sent that PUT — MCP tool results are content
  for the model to read, not requests the host executes — so local media was unreachable from MCP
  alone. It also placed the storage URL, which carries account and tenant identifiers, into the
  model context; that tool is removed. File reads are confined to the user's home directory by
  default, configurable with `SPICY_MCP_UPLOAD_ROOTS`.

  The CLI now accepts MP4/WebM video and MP3/WAV audio for `--content-type`; its whitelist had only
  the four image types while the server and SDK already took audio and video.

- Updated dependencies [39e03de]
- Updated dependencies [4c586b6]
- Updated dependencies [25887e3]
- Updated dependencies [983dd22]
  - @spicyapi/sdk@0.5.0

## 0.3.2

### Patch Changes

- Clarify task waiting, balance, and request confirmation text.

## 0.3.1

### Patch Changes

- Updated dependencies
  - @spicyapi/sdk@0.4.0

## 0.3.0

### Minor Changes

- Add `tasks list` for paginated current-key task metadata, with UTC date, model and state filters,
  opaque cursors, and exact USD cost strings. Read one page without extra task lookups.

- Add one-call task execution, bounded adaptive waiting, Base64 upload support, and current-key USD
  usage. Preserve request IDs through optional response metadata and clarify direct media results
  and timeout recovery.

### Patch Changes

- Updated dependencies
  - @spicyapi/sdk@0.3.0

## 0.2.0

### Minor Changes

- Add request-bound task quotes and expected-cost checks, document the public compatibility
  endpoints, and unify the development workflow across the SDK, CLI, MCP, and Agent Skill.

  The SDK now enforces an end-to-end timeout and a size limit when reading response bodies, and
  fills in the OpenAI-compatible examples and regression tests. The CLI and MCP add read-only
  quoting while keeping explicit confirmation and idempotency controls for billable writes. The
  content-mode field sent by older clients is now ignored for task admission.

### Patch Changes

- Updated dependencies
  - @spicyapi/sdk@0.2.0
