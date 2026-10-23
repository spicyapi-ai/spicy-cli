import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { createInterface } from "node:readline/promises";

import { SpicyApiError } from "@spicyapi/sdk";
import type {
  Asset,
  AssetCharacter,
  AssetCharacterList,
  AssetList,
  AssetPlan,
  AssetUsage,
  ServiceStatus,
  TaskRecord,
  UploadContentType,
} from "@spicyapi/sdk";

export const MAX_CLI_INPUT_BYTES = 1_048_576;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdinIsTTY: boolean;
  readStdin: () => Promise<string>;
  confirm: (message: string) => Promise<boolean>;
  env: NodeJS.ProcessEnv;
}

export function defaultCliIo(): CliIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    readStdin: async () => {
      const chunks: string[] = [];
      const stream: AsyncIterable<unknown> = process.stdin;
      for await (const chunk of stream) {
        if (typeof chunk === "string") chunks.push(chunk);
        else if (chunk instanceof Uint8Array) chunks.push(new TextDecoder().decode(chunk));
        else throw new TypeError("stdin yielded an unsupported value");
      }
      return chunks.join("");
    },
    confirm: async (message) => {
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await prompt.question(`${message} Continue? [y/N] `);
        return /^(?:y|yes)$/i.test(answer.trim());
      } finally {
        prompt.close();
      }
    },
    env: process.env,
  };
}

export function outputValue(value: unknown, json: boolean, io: CliIo): void {
  if (json) {
    io.stdout(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (typeof value === "string") {
    io.stdout(`${value}\n`);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) io.stdout(`${formatRecord(item)}\n`);
    return;
  }
  io.stdout(`${formatRecord(value)}\n`);
}

function formatRecord(value: unknown): string {
  if (value === null || typeof value !== "object") return String(value);
  const rows = Object.entries(value).map(([key, item]) => {
    const formatted =
      item !== null && typeof item === "object"
        ? JSON.stringify(item)
        : item === undefined
          ? ""
          : String(item);
    return `${key}: ${formatted}`;
  });
  return rows.join("\n");
}

function serviceHost(serviceBaseUrl: string): string {
  try {
    return new URL(serviceBaseUrl).host;
  } catch {
    return serviceBaseUrl;
  }
}

/**
 * Turns the structure from `getStatus()` into one sentence a person can read.
 *
 * This is the first command the README recommends, and the only one that needs no key and costs
 * nothing, so the whole burden of demonstrating that the platform is alive rests on it. In four
 * lines of raw JSON the eye lands on `operational: false` and never reaches the health line, so the
 * conclusion has to come first, as a sentence, naming who answered and how fast. Anyone who wants
 * the structure can still add `--json`, where not a field has changed.
 */
export function describeServiceStatus(
  status: ServiceStatus,
  serviceBaseUrl: string,
  elapsedMs: number,
): string {
  const host = serviceHost(serviceBaseUrl);
  if (status.operational) {
    return `SpicyAPI is reachable — ${host} answered in ${elapsedMs} ms.`;
  }
  // A status of 0 means nothing left or arrived locally: the network, a proxy, or an edited base URL.
  if (status.health.status === 0) {
    const detail = status.health.error ? ` (${status.health.error})` : "";
    return (
      `SpicyAPI could not be reached — no answer from ${host}${detail}. ` +
      "Check your network or proxy, then SPICY_SERVICE_BASE_URL if you overrode it."
    );
  }
  // A 403 or 451 does not mean the service is broken; it means this request's origin was refused.
  // Reporting it as an outage and pointing at the status page sends people the wrong way - the
  // status page is fine, and what needs checking is the egress: a proxy, a corporate gateway, or a
  // request coming from a region this service does not serve. This deliberately asserts none of
  // them and merely lists the possibilities.
  if (status.health.status === 403 || status.health.status === 451) {
    return (
      `SpicyAPI refused this request — ${host} answered HTTP ${status.health.status} on /healthz. ` +
      "That is a rejection of where the request came from, not a service fault. " +
      "Check whether a proxy or gateway sits in front of you, and whether this network is in a region SpicyAPI serves."
    );
  }
  if (!status.health.ok) {
    return (
      `SpicyAPI is not healthy — ${host} answered HTTP ${status.health.status} on /healthz. ` +
      "Current incidents are at https://status.spicyapi.ai."
    );
  }
  return (
    `SpicyAPI answered but reports it is not ready — ${host} returned ` +
    `HTTP ${status.readiness.status} on /readyz. Current incidents are at https://status.spicyapi.ai.`
  );
}

function describeApiKeyState(env: NodeJS.ProcessEnv): string {
  const key = env.SPICY_API_KEY;
  if (!key) return "SPICY_API_KEY is not set in this shell.";
  // Only the first 9 characters, the length of `sk-spicy-`: enough to tell "pasted somebody else's
  // key" or "used a console cookie as a key" apart, without printing the secret itself into a
  // terminal or a CI log.
  if (!key.startsWith("sk-spicy-")) {
    return `SPICY_API_KEY starts with "${key.slice(0, 9)}", not "sk-spicy-", so this shell holds the wrong value.`;
  }
  return "SPICY_API_KEY is set with the right prefix, so the key itself is revoked, expired, or from another account.";
}

/**
 * A 403 has four unrelated causes, and the business code is the only thing that tells them apart.
 *
 * This used to answer every 403 with "check the key's model and IP allowlists". For an account whose
 * email is not verified yet (`40310`) or a request from a region the service is not offered in
 * (`40303`), that sends people to a settings page where nothing is wrong. A 403 without any business
 * code almost certainly did not come from SpicyAPI: the SDK only fills `code` from the platform's
 * own envelope, which always carries one, so an empty one means a proxy, VPN or gateway answered
 * first, and the allowlists are just as irrelevant.
 */
function describeForbidden(code: number | undefined): string {
  switch (code) {
    case 40301:
      return "Next: this key may not call this model. Check the key's model restrictions at https://spicyapi.ai/console/keys.";
    case 40302:
      return "Next: this network address is not on the key's IP allowlist. Add it, or use a key without one, at https://spicyapi.ai/console/keys.";
    case 40303:
      return "Next: SpicyAPI is not offered in the region this request came from. Changing keys or settings does not change that.";
    case 40310:
      return "Next: verify your account email first. Open the link we sent when you signed up, or send a new one from https://spicyapi.ai/console; the key works as soon as the address is verified.";
    case undefined:
      return "Next: this refusal carries no SpicyAPI error code, so something in between most likely answered. Check any proxy, VPN or corporate gateway between this machine and api.spicyapi.ai.";
    default:
      return "Next: this key is not allowed to do that. Check its model allowlist and IP allowlist at https://spicyapi.ai/console/keys.";
  }
}

/**
 * With no key, the SDK throws a plain TypeError (`SPICY_API_KEY is required for authenticated API
 * operations`) before any request goes out.
 *
 * It is not a `SpicyApiError`, which used to mean no `Next:` line and an unenlightening `TypeError`
 * as the type under `--json`. It is recognised by its message prefix: that sentence is fixed in the
 * SDK, the CLI's tests pin it against the real SDK, and a reworded SDK turns this red first.
 */
export function isMissingApiKeyError(error: unknown): error is TypeError {
  return error instanceof TypeError && error.message.startsWith("SPICY_API_KEY is required");
}

/**
 * The server's message says what happened; the terminal still owes a sentence about what to do now.
 *
 * Everything a CLI offers over raw HTTP comes from knowing the context: whether the key is exported,
 * whether its prefix is right, how many seconds `Retry-After` asked for. The README says all of
 * this, but whoever is reading is in a terminal right now, not in the README.
 */
/**
 * Which command failed, so a hint can depend on it: an asset 403 is not a model 403, and a 404
 * from a character or a folder is not an unknown model.
 */
export interface NextStepContext {
  /** An `assets` or `characters` command. */
  assets?: boolean;
  /** A `characters` command. */
  characters?: boolean;
  /** `assets list` with `--folder`. */
  folder?: boolean;
}

export function describeNextStep(
  error: unknown,
  env: NodeJS.ProcessEnv,
  context: NextStepContext = {},
): string | undefined {
  if (isMissingApiKeyError(error)) {
    return (
      'Next: SPICY_API_KEY is not set in this shell. Set it with export SPICY_API_KEY="sk-spicy-..." ' +
      '(PowerShell: $env:SPICY_API_KEY = "sk-spicy-..."), then run the command again. ' +
      "Create a key at https://spicyapi.ai/console/keys. `spicyapi status` and `spicyapi docs search` work without one."
    );
  }
  if (!(error instanceof SpicyApiError)) return undefined;
  const assetStep = describeAssetNextStep(error, context);
  if (assetStep) return assetStep;
  switch (error.status) {
    case 400:
      return "Next: re-read the schema with `spicyapi models get <model>` and build --input-json from it. One unknown field is a 400.";
    case 401:
      return `Next: ${describeApiKeyState(env)} Create or rotate a key at https://spicyapi.ai/console/keys.`;
    case 402:
      return "Next: top up, or raise the key's spend cap, at https://spicyapi.ai/console. Asking again does not change a balance or a cap.";
    case 403:
      return describeForbidden(error.code);
    case 404:
      return "Next: check the id. Model ids read <maker>/<model>/<task>; `spicyapi models list` shows what this account can call today.";
    case 409:
      return "Next: the quote expired or the request changed. Quote again, or replay the original request with its original --idempotency-key.";
    case 413:
      return "Next: the body is too large. Upload the media with `spicyapi files upload` and send the returned spicy:// URI instead.";
    case 429: {
      const wait =
        error.retryAfterSeconds === undefined
          ? "after the Retry-After delay"
          : `in ${error.retryAfterSeconds}s (Retry-After)`;
      return `Next: back off and retry ${wait}. The limit counts per account, so creating more keys does not raise it.`;
    }
    default:
      if (error.status >= 500) {
        return "Next: this one is on our side. Retry with backoff; if it persists, quote the request id at https://spicyapi.ai/contact.";
      }
      return undefined;
  }
}

/**
 * The asset library says why it refused in `reason`, which is more precise than the HTTP status:
 * a 400 there is a plan limit, not a malformed input, and the generic 400 hint would send the
 * reader to model schemas. Unknown reasons fall through to the status-based hints.
 */
function describeAssetNextStep(error: SpicyApiError, context: NextStepContext): string | undefined {
  const assetCommand = context.assets === true || context.characters === true;
  switch (error.reason) {
    case "asset_library_locked":
      return "Next: the asset library opens with the owner's first top-up. `spicyapi assets usage` shows each plan and what it takes; the owner tops up at https://spicyapi.ai/console. Assets already saved stay usable.";
    case "asset_library_full":
      return "Next: the plan's storage or item count is used up. Delete assets you no longer need with `spicyapi assets delete <id>`, or have the owner top up to reach the next plan; `spicyapi assets usage` shows both.";
    case "asset_file_too_large":
      return "Next: this file is above the plan's per-file limit. `spicyapi assets usage` shows the limit and what the next plan allows.";
    case "asset_daily_limit": {
      const wait =
        error.retryAfterSeconds === undefined
          ? "after the Retry-After delay"
          : `in ${error.retryAfterSeconds}s (Retry-After)`;
      return `Next: today's allowance of new assets is used up; it resets at 00:00 UTC. Try again ${wait}. Saved assets keep working, and deleting one does not give the allowance back.`;
    }
    case "asset_storage_full":
      return "Next: storage is temporarily full across the platform and nothing was saved. Retry later.";
    case "asset_permission_denied":
      return "Next: your role in this team does not allow that change. Billing and readonly members can only read and use assets, and developers can rename, favorite or delete only what they saved; ask a team owner or admin. `spicyapi assets usage` shows the role this key acts with.";
    case "asset_workspace_forbidden":
      return "Next: this key cannot reach that library, for example because the member who created this team key has left the team. Use a key created in the workspace whose library you need, at https://spicyapi.ai/console/keys.";
    case "asset_entity_name_taken":
      return "Next: the library already has a character with that name (ignoring case). Pick another name on the Assets page at https://spicyapi.ai/assets.";
  }
  if (assetCommand && error.status === 403) {
    return "Next: this key may not do that in its asset library. `spicyapi assets usage` shows which library the key reaches and its role; manage keys at https://spicyapi.ai/console/keys.";
  }
  if (context.characters === true && error.status === 404) {
    return "Next: check the character id. `spicyapi characters list` shows the characters this key's library holds.";
  }
  if (context.folder === true && error.status === 404) {
    return "Next: check the folder id. Folders are created on the Assets page at https://spicyapi.ai/assets, and one from another library is not found.";
  }
  if (assetCommand && error.status === 404) {
    return "Next: check the asset id. `spicyapi assets list` shows the assets this key's library holds; a deleted asset is gone for good.";
  }
  return undefined;
}

const BYTE_UNITS = ["KB", "MB", "GB", "TB"] as const;

/** Binary units, as the asset API counts them (500 MB = 524288000 bytes). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  let value = bytes;
  let unit: (typeof BYTE_UNITS)[number] = "KB";
  for (const candidate of BYTE_UNITS) {
    value /= 1024;
    unit = candidate;
    if (value < 1024) break;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${unit}`;
}

function describeAssetLine(asset: Asset): string {
  const favorite = asset.favorite === true ? "  (favorite)" : "";
  return `${asset.uri}  ${asset.kind}  ${formatBytes(asset.bytes)}  ${asset.name}${favorite}`;
}

/** One line per asset, led by the reference you paste into a model input. */
export function describeAssetList(page: AssetList): string[] {
  if (page.items.length === 0) return ["No saved assets match."];
  const lines = page.items.map(describeAssetLine);
  if (page.nextCursor) {
    lines.push(`More assets: run the same command with --cursor ${page.nextCursor}, or add --all.`);
  }
  return lines;
}

export function describeFavoriteChange(asset: Asset): string[] {
  return [
    `${asset.favorite === true ? "Marked as a favorite" : "No longer a favorite"}: ${describeAssetLine(asset)}`,
  ];
}

function characterImageCount(character: AssetCharacter): string {
  return `${character.count} ${character.count === 1 ? "image" : "images"}`;
}

/** The references a character stands for, in order, as one JSON array ready to paste. */
function characterReferences(character: AssetCharacter): string {
  return JSON.stringify(character.assets.map((image) => image.uri));
}

/** One block per character: its id and name, then its images as pasteable references. */
export function describeCharacterList(page: AssetCharacterList): string[] {
  if (page.items.length === 0) {
    return [
      "No characters in this key's library. Create them on the Assets page at https://spicyapi.ai/assets.",
    ];
  }
  const lines: string[] = [];
  for (const character of page.items) {
    lines.push(`${character.id}  ${character.name}  ${characterImageCount(character)}`);
    lines.push(`  ${characterReferences(character)}`);
  }
  if (page.nextCursor) {
    lines.push(
      `More characters: run the same command with --cursor ${page.nextCursor}, or add --all.`,
    );
  }
  return lines;
}

/** A character's images in order, then the array of references to put in a model input. */
export function describeCharacter(character: AssetCharacter): string[] {
  const lines = [`${character.name}  ${character.id}  ${characterImageCount(character)}`];
  if (character.note) lines.push(`Note: ${character.note}`);
  if (character.assets.length === 0) {
    lines.push(
      "This character has no images yet. Add them on the Assets page at https://spicyapi.ai/assets.",
    );
    return lines;
  }
  character.assets.forEach((image, index) => {
    lines.push(`${index + 1}. ${describeAssetLine(image)}`);
  });
  lines.push(`References: ${characterReferences(character)}`);
  lines.push(
    "Put these spicy://a/ references, in this order, in the model's reference image field (`spicyapi models get <model>` names it).",
  );
  return lines;
}

export function describeSavedAsset(asset: Asset): string[] {
  return [
    `Saved: ${describeAssetLine(asset)}`,
    `Put ${asset.uri} in any media field of a model input; it works until you delete it.`,
  ];
}

function describePlanLimits(plan: AssetPlan): string {
  if (plan.maxBytes === 0) return "saving closed";
  return `${formatBytes(plan.maxBytes)}, ${plan.maxCount} items, ${formatBytes(plan.maxFileBytes)} per file`;
}

/** The plan, what is stored against it, today's count and what the next plan takes. */
function describeAssetScope(scope: AssetUsage["scope"]): string {
  const library = scope.personal
    ? "personal"
    : `team workspace ${scope.workspaceId}, acting as ${scope.role}`;
  return scope.canWrite ? `Library: ${library}` : `Library: ${library} (read and use only)`;
}

/**
 * The library the key reaches, the plan, what is stored against it, today's count and what the
 * next plan takes. Usage and limits cover the owner's whole allowance, so a team member sees the
 * same pool as the owner; the top-up amounts are absent when the key may not see them.
 */
export function describeAssetUsage(usage: AssetUsage): string[] {
  const { tier, limits, scope } = usage;
  const lines = [
    describeAssetScope(scope),
    `Plan: ${tier.name} (${describePlanLimits(tier)})`,
    `Stored: ${usage.usage.count} of ${limits.maxCount} items, ${formatBytes(usage.usage.bytes)} of ${formatBytes(limits.maxBytes)}`,
    `Saved today: ${usage.createdToday} of ${usage.dailyCreateLimit} (resets at 00:00 UTC)`,
  ];
  if (usage.full) {
    lines.push(
      limits.maxBytes === 0
        ? "Saving is closed on this plan; assets you already saved stay usable."
        : "Full: nothing new fits until you delete assets or reach the next plan.",
    );
  }
  if (usage.nextTier) {
    const next = `Next plan: ${usage.nextTier.name} — ${describePlanLimits(usage.nextTier)}`;
    if (!scope.canTopUp) {
      lines.push(`${next}. The team owner upgrades the plan.`);
    } else {
      const more = usage.topupToNextTierUsd ? ` (USD ${usage.topupToNextTierUsd} more)` : "";
      lines.push(`${next}, at USD ${usage.nextTier.minTopupUsd} in lifetime top-ups${more}`);
    }
  }
  return lines;
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  if (Buffer.byteLength(raw, "utf8") > MAX_CLI_INPUT_BYTES) {
    throw new TypeError(`${label} exceeds ${MAX_CLI_INPUT_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TypeError(`${label} is not valid JSON`, {
      cause: error,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(`${label} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Strips a leading UTF-8 BOM.
 *
 * Windows PowerShell 5.1 writes one with both `Out-File -Encoding utf8` and
 * `Set-Content -Encoding UTF8`, and `readFile(..., "utf8")` leaves it in place as `\uFEFF`, so
 * `JSON.parse` calls the whole file "not valid JSON" when its contents are perfectly correct.
 * Only the leading one is removed: a U+FEFF anywhere else is content, and none of this function's
 * business.
 */
function stripUtf8Bom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

export async function readInputObject(
  inputJson: string | undefined,
  inputFile: string | undefined,
  io: CliIo,
): Promise<Record<string, unknown>> {
  if (inputJson !== undefined && inputFile !== undefined) {
    throw new TypeError("use either --input-json or --input-file, not both");
  }
  if (inputJson !== undefined) return parseJsonObject(inputJson, "--input-json");
  // With neither flag this used to return {} silently, so the caller learned they had sent nothing
  // from the server's 400, after confirming the charge. Every model in the catalogue has required
  // fields and an empty object is never right, so refuse before any money moves. Anyone who really
  // wants to send an empty object can write --input-json '{}' explicitly.
  if (inputFile === undefined) {
    throw new TypeError(
      "model input is required: pass --input-json '<json object>' or --input-file <path> " +
        "(use --input-file - to read the object from stdin). " +
        "Read the model input schema first; to send an empty object on purpose, write --input-json '{}'",
    );
  }
  const raw = inputFile === "-" ? await io.readStdin() : await readFile(inputFile, "utf8");
  return parseJsonObject(stripUtf8Bom(raw), inputFile === "-" ? "stdin" : "--input-file");
}

/**
 * Spending money and destroying content pass through the same gate: either an answer at an
 * interactive terminal, or an explicit `--yes`.
 *
 * What they have in common is being irreversible once done - money paid and outputs deleted alike.
 * `kind` changes only an adjective in the refusal message; not one character of the test differs,
 * so there is no way for the destructive path to end up laxer than the paying one.
 */
export async function requireConfirmation(
  message: string,
  yes: boolean,
  io: CliIo,
  kind: "billable" | "destructive" = "billable",
): Promise<void> {
  if (yes) return;
  if (!io.stdinIsTTY) {
    throw new Error(`${kind} command requires an interactive confirmation or --yes`);
  }
  if (!(await io.confirm(message))) throw new Error("operation canceled");
}

const RETENTION_UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3_600,
  d: 86_400,
};

/**
 * `--retention` accepts what people actually write - `30m`, `1h`, `7d` - as well as a plain number
 * of seconds.
 *
 * No ceiling is enforced locally: only the server knows the platform limit, copying it into the CLI
 * as a constant buries a number that will expire, and the contract states plainly that anything
 * over it is clamped server-side with the effective value read back from the response's
 * `retention`. All that is guaranteed here is that the string becomes a valid number of seconds.
 * `0` is valid and means "delete the outputs as soon as the task reaches a terminal state".
 */
export function parseRetentionSeconds(value: string): number {
  const normalized = value.trim().toLowerCase();
  const match = /^(\d+)(s|m|h|d)?$/.exec(normalized);
  if (!match) {
    throw new TypeError(
      "--retention must be a whole number of seconds or a duration such as 30m, 1h, or 7d",
    );
  }
  const seconds = Number(match[1]) * RETENTION_UNIT_SECONDS[match[2] ?? "s"]!;
  if (!Number.isSafeInteger(seconds)) throw new TypeError("--retention is too large");
  return seconds;
}

/**
 * Puts a task's content state and expiry into plain words.
 *
 * "It expired" and "you deleted it" have to be said differently: describing the second as the first
 * leaves the user believing the platform lost their work.
 */
export function describeTaskRetention(task: TaskRecord): string[] {
  const lines: string[] = [];
  const retention = task.retention;
  /* `purgedAt` is top-level on TaskRecord rather than inside `retention`: the latter describes the
     policy for keeping content, while this describes what has already happened to it. A historical
     task with no per-task retention decision omits `retention` entirely, and the purge time still
     has to be reportable then. */
  const removedOn = task.purgedAt ?? retention?.outputsExpireAt;
  if (task.contentState === "purged") {
    lines.push(
      `Content: Destroyed — you removed the outputs${removedOn ? ` on ${removedOn}` : ""}. Billing records are unaffected.`,
    );
  } else if (task.contentState === "expired") {
    lines.push(
      `Content: Expired — outputs were removed${removedOn ? ` on ${removedOn}` : ""} under your retention settings.`,
    );
  }
  if (retention?.outputsExpireAt) lines.push(`Outputs expire: ${retention.outputsExpireAt}`);
  if (retention?.promptsExpireAt) lines.push(`Prompts erased: ${retention.promptsExpireAt}`);
  if (retention?.source) lines.push(`Retention set by: ${retention.source}`);
  return lines;
}

/**
 * Reference documents the upload endpoint accepts on top of images, audio and video (up to 90 MiB),
 * for input fields such as `reference_file_url`.
 *
 * They were first listed here because the SDK's `UploadContentType` stopped at the eight media
 * types when the server began accepting documents on 2026-09-29. The SDK has listed them since
 * 0.8.0, so this union now overlaps with it; it stays so the CLI keeps naming every type it takes.
 */
export type DocumentContentType =
  | "application/pdf"
  | "application/msword"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "application/vnd.ms-excel"
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  | "application/vnd.ms-powerpoint"
  | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  | "application/vnd.apple.keynote"
  | "application/vnd.apple.pages"
  | "application/vnd.apple.numbers"
  | "text/plain"
  | "text/markdown";

export type CliUploadContentType = UploadContentType | DocumentContentType;

/* Must cover the `UploadURLRequest.contentType` enum in the contract value for value. Before
   2026-09-12 the CLI listed four image types while the server and the SDK had long accepted audio
   and video - so anyone uploading an mp4 with an explicit MIME type was stopped by the CLI itself,
   with a message reading "content type must be one of: <four image types>", which looks like the
   platform not supporting video. The same thing happened again with documents, which is why the
   extension table and the accepted types now live side by side in one place. */
const UPLOAD_CONTENT_TYPES_BY_EXTENSION: Readonly<Record<string, CliUploadContentType>> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".key": "application/vnd.apple.keynote",
  ".pages": "application/vnd.apple.pages",
  ".numbers": "application/vnd.apple.numbers",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  // LoRA weights for `loras[].path`: a .safetensors file of up to 2 GiB.
  ".safetensors": "application/octet-stream",
};

export const SUPPORTED_UPLOAD_CONTENT_TYPES: readonly CliUploadContentType[] = [
  ...new Set(Object.values(UPLOAD_CONTENT_TYPES_BY_EXTENSION)),
];

/**
 * The content type for `files upload`, taken from the file extension (case-insensitive).
 *
 * The error lists the extensions this table knows, so it can never name fewer types than the CLI
 * actually accepts.
 */
export function inferUploadContentType(filePath: string): CliUploadContentType {
  const contentType = UPLOAD_CONTENT_TYPES_BY_EXTENSION[extname(filePath).toLowerCase()];
  if (!contentType) {
    const known = Object.keys(UPLOAD_CONTENT_TYPES_BY_EXTENSION)
      .map((extension) => extension.slice(1))
      .join(", ");
    throw new TypeError(`--content-type is required unless the file extension is one of: ${known}`);
  }
  return contentType;
}

export function parseUploadContentType(value: string): CliUploadContentType {
  if (!SUPPORTED_UPLOAD_CONTENT_TYPES.includes(value as CliUploadContentType)) {
    throw new TypeError(
      `content type must be one of: ${SUPPORTED_UPLOAD_CONTENT_TYPES.join(", ")}`,
    );
  }
  return value as CliUploadContentType;
}
