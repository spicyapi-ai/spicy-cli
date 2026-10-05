import { CLI_VERSION } from "../generated/package-version.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Command, CommanderError, InvalidArgumentError } from "commander";

import {
  DEFAULT_SERVICE_BASE_URL,
  searchDocumentation,
  SpicyApiError,
  SpicyClient,
  verifyWebhook,
  type SpicyClientOptions,
  type ListTasksOptions,
  type UploadContentType,
} from "@spicyapi/sdk";
import {
  defaultCliIo,
  describeNextStep,
  describeServiceStatus,
  describeTaskRetention,
  inferUploadContentType,
  isMissingApiKeyError,
  outputValue,
  parseRetentionSeconds,
  parseUploadContentType,
  readInputObject,
  requireConfirmation,
  type CliIo,
  type CliUploadContentType,
} from "./io.js";

interface GlobalOptions {
  json?: boolean;
  apiBaseUrl?: string;
  serviceBaseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

interface CreateTaskCommandOptions {
  inputJson?: string;
  inputFile?: string;
  callbackUrl?: string;
  idempotencyKey?: string;
  retention?: number;
  yes?: boolean;
  wait?: boolean;
  pollIntervalMs?: number;
  waitTimeoutMs?: number;
}

interface PurgeTaskCommandOptions {
  yes?: boolean;
}

interface RetryTaskCommandOptions {
  idempotencyKey?: string;
  yes?: boolean;
  wait?: boolean;
  pollIntervalMs?: number;
  waitTimeoutMs?: number;
}

interface ListModelsCommandOptions {
  modality?: "image" | "video" | "audio" | "text";
  provider?: string;
  task?: string;
  search?: string;
  includeSchema?: boolean;
  includeExamples?: boolean;
}

interface CliErrorDetails {
  error: string;
  type: string;
  status?: number;
  code?: number;
  requestId?: string;
  retryAfterSeconds?: number;
  /**
   * The task was accepted on the server; only the waiting step did not finish.
   *
   * Without this, any polling error after acceptance made `--wait` print nothing but a network
   * error: empty stdout, not a character of the taskId, while the task kept running and kept being
   * billed. All the user could do was re-run the same command - which generates a NEW idempotency
   * key by default, creating a second task and paying a second time.
   */
  taskId?: string;
  /** The idempotency key that went with that acceptance: only replaying it returns the same task. */
  idempotencyKey?: string;
  /** A recovery command that can be pasted straight back into the terminal. */
  recover?: string;
}

/**
 * "The task was accepted, but something went wrong while waiting for it to finish."
 *
 * It gets a type of its own so the acceptance details travel all the way to the outermost error
 * serialisation: both the human-readable mode and `--json` need the taskId, rather than having it
 * stop inside some catch block.
 */
class TaskAcceptedButWaitFailedError extends Error {
  constructor(
    readonly taskId: string,
    readonly idempotencyKey: string,
    override readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : "waiting for the task failed");
    this.name = "TaskAcceptedButWaitFailedError";
  }
}

/**
 * Waits only after a successful acceptance, and guarantees the taskId does not vanish with an
 * exception.
 *
 * The taskId is written to stderr the moment the task is accepted: a wait can end in a timeout, a
 * dropped connection or a Ctrl-C that never reaches any catch block, and those two lines are the
 * only thread the user is left holding. stderr rather than stdout, because stdout is reserved for
 * the final `--json` result and must not be polluted with progress.
 */
async function waitAfterAccepted(
  client: SpicyClient,
  accepted: { taskId: string },
  idempotencyKey: string,
  options: CreateTaskCommandOptions | RetryTaskCommandOptions,
  io: CliIo,
) {
  io.stderr(
    `Accepted: ${accepted.taskId}\n` +
      `If waiting is interrupted: spicyapi tasks get ${accepted.taskId}\n`,
  );
  try {
    return await client.waitForTask(accepted.taskId, taskWaitOptions(options));
  } catch (error) {
    throw new TaskAcceptedButWaitFailedError(accepted.taskId, idempotencyKey, error);
  }
}

/* `tasks purge` and `--retention` delete the same thing, and all three descriptions have to agree.
   The wording follows the server: the output objects, the result payload, the prompt and the text
   in input are deleted; the ledger entries, the amount, the model identifier, the state, the
   timestamps and the request ID are left untouched. */
const DESTROYED_CONTENT = "generated media, result payload, prompt and other input text";
const RETAINED_BILLING_RECORDS =
  "the ledger entry, charged amount, model, state, timestamps and request ID";

export interface CliDependencies {
  io?: CliIo;
  createClient?: (options: SpicyClientOptions) => SpicyClient;
}

function integer(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError("must be a non-negative integer");
  }
  return parsed;
}

// commander's option parsers are expected to throw InvalidArgumentError, which is what folds the
// error into a usage line reading "option '--retention <duration>' argument 'x' is invalid". The
// parser in io.ts stays pure and throws a TypeError, so it can be unit-tested without commander.
function retentionDuration(value: string): number {
  try {
    return parseRetentionSeconds(value);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : "invalid duration");
  }
}

function clientOptions(program: Command): SpicyClientOptions {
  const options = program.opts<GlobalOptions>();
  return {
    ...(options.apiBaseUrl === undefined ? {} : { apiBaseUrl: options.apiBaseUrl }),
    ...(options.serviceBaseUrl === undefined ? {} : { serviceBaseUrl: options.serviceBaseUrl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
  };
}

function isJson(program: Command): boolean {
  return Boolean(program.opts<GlobalOptions>().json);
}

function taskWaitOptions(options: CreateTaskCommandOptions | RetryTaskCommandOptions): {
  intervalMs?: number;
  timeoutMs?: number;
} {
  return {
    ...(options.pollIntervalMs === undefined ? {} : { intervalMs: options.pollIntervalMs }),
    ...(options.waitTimeoutMs === undefined ? {} : { timeoutMs: options.waitTimeoutMs }),
  };
}

function describeError(error: unknown): CliErrorDetails {
  if (isMissingApiKeyError(error)) {
    // Keep the SDK's own wording; give the type a name that states the reason, so a script need
    // not guess at a TypeError.
    return { error: error.message, type: "MissingApiKeyError" };
  }
  if (error instanceof TaskAcceptedButWaitFailedError) {
    // Describe the underlying error as usual, then add "the task still exists, and here is how to
    // get it back".
    return {
      ...describeError(error.cause),
      taskId: error.taskId,
      idempotencyKey: error.idempotencyKey,
      recover: `spicyapi tasks get ${error.taskId}`,
    };
  }
  if (error instanceof SpicyApiError) {
    return {
      error: error.message,
      type: error.name,
      status: error.status,
      ...(error.code === undefined ? {} : { code: error.code }),
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
    };
  }
  if (error instanceof Error) return { error: error.message, type: error.name };
  return { error: "unknown error", type: "Error" };
}

export function createCli(dependencies: CliDependencies = {}): Command {
  const io = dependencies.io ?? defaultCliIo();
  const createClient = dependencies.createClient ?? ((options) => new SpicyClient(options));
  const program = new Command();
  // exitOverride has to be set before any subcommand is created: commander runs
  // copyInheritedSettings inside .command(), and _exitCallback is copied by value at that moment.
  // It used to sit at the end of createCli, so no subcommand inherited the override and a branch
  // such as `tasks create --help` called process.exit(0) outright - which, inside node --test's
  // child process, takes the unflushed TAP output with it and leaves the whole of cli.test.js
  // judged a passing, empty file.
  program.exitOverride();
  program
    .name("spicyapi")
    .description("Official CLI for the SpicyAPI public API")
    .version(CLI_VERSION)
    .option("--json", "emit machine-readable JSON")
    .option("--api-base-url <url>", "override SPICY_API_BASE_URL")
    .option("--service-base-url <url>", "override SPICY_SERVICE_BASE_URL")
    .option("--timeout-ms <milliseconds>", "per-request timeout", integer)
    .option("--max-retries <count>", "safe-request retry count (0-5)", integer)
    .showSuggestionAfterError()
    .configureOutput({
      writeOut: (text) => io.stdout(text),
      writeErr: (text) => io.stderr(text),
    });

  program
    .command("status")
    .description("check whether the public API is reachable; no API key needed")
    .action(async () => {
      const options = clientOptions(program);
      const startedAt = Date.now();
      const status = await createClient(options).getStatus();
      const elapsedMs = Date.now() - startedAt;
      // The `--json` form is the probe structure exactly as the server gave it, with no field
      // added; the human-readable one gives only the conclusion.
      if (isJson(program)) {
        outputValue(status, true, io);
        return;
      }
      const serviceBaseUrl =
        options.serviceBaseUrl ?? io.env.SPICY_SERVICE_BASE_URL ?? DEFAULT_SERVICE_BASE_URL;
      io.stdout(`${describeServiceStatus(status, serviceBaseUrl, elapsedMs)}\n`);
    });

  const docs = program.command("docs").description("discover first-party SpicyAPI documentation");
  docs
    .command("search")
    .argument("[query]", "words to match", "")
    .option("--limit <count>", "maximum results (1-25)", integer, 10)
    .description("search the bundled first-party documentation index")
    .action((query: string, options: { limit: number }) => {
      const results = searchDocumentation(query, options.limit);
      // `--json` still prints []; in human-readable mode a blank screen cannot be told apart from
      // the command not having run.
      if (results.length === 0 && !isJson(program)) {
        io.stdout(
          `No documentation matched "${query}". Try fewer or different words, or run \`spicyapi docs search\` without words to browse pages.\n`,
        );
        return;
      }
      outputValue(results, isJson(program), io);
    });

  const models = program
    .command("models")
    .description("inspect the live account-specific model catalog");
  models
    .command("list")
    .option("--modality <type>", "image, video, audio, or text")
    .option("--provider <name>")
    .option("--task <task>")
    .option("--search <text>")
    .option("--include-schema", "include each model input schema")
    .option("--include-examples", "include validated examples")
    .description("list enabled models and account-specific prices")
    .action(async (options: ListModelsCommandOptions) => {
      const result = await createClient(clientOptions(program)).listModels(options);
      outputValue(result, isJson(program), io);
    });
  models
    .command("get")
    .argument("<model>", "exact model ID; slashes are supported")
    .description("get one model and its current input schema")
    .action(async (model: string) => {
      outputValue(await createClient(clientOptions(program)).getModel(model), isJson(program), io);
    });

  program
    .command("balance")
    .description("show available, held, and total USD balance")
    .action(async () => {
      outputValue(await createClient(clientOptions(program)).getBalance(), isJson(program), io);
    });

  program
    .command("usage")
    .description("show settled USD usage for the current API key only")
    .option("--from <date>", "inclusive UTC date (YYYY-MM-DD)")
    .option("--to <date>", "exclusive UTC date (YYYY-MM-DD), at most 92 days")
    .action(async (options: { from?: string; to?: string }) => {
      outputValue(
        await createClient(clientOptions(program)).getUsage(options),
        isJson(program),
        io,
      );
    });

  const tasks = program
    .command("tasks")
    .description("list, create, inspect, retry, wait for, and destroy the content of tasks");
  tasks
    .command("list")
    .description(
      "list metadata for tasks created with the current API key; use get for a selected result",
    )
    .option("--from <date>", "inclusive UTC date (YYYY-MM-DD); fix dates across pages")
    .option("--to <date>", "exclusive UTC date; default seven-day window, at most 92 days")
    .option("--state <state>", "queued, running, succeeded, failed, canceled, or expired")
    .option("--model <model>", "exact catalog model ID")
    .option("--limit <count>", "page size (1-100, default 20)", integer)
    .option("--cursor <cursor>", "opaque nextCursor from the preceding page")
    .action(async (options: ListTasksOptions) => {
      outputValue(
        await createClient(clientOptions(program)).listTasks(options),
        isJson(program),
        io,
      );
    });
  tasks
    .command("get")
    .argument("<task-id>")
    .description(
      "get a task visible to the current API key, with its content state and retention deadlines",
    )
    .action(async (taskId: string) => {
      const task = await createClient(clientOptions(program)).getTask(taskId);
      outputValue(task, isJson(program), io);
      // Not a word is added under `--json`: what a machine reads is the record the server
      // returned. Only the human-readable form gets an extra line, because `contentState: purged`
      // does not say who did the deleting.
      if (!isJson(program)) {
        for (const line of describeTaskRetention(task)) io.stdout(`${line}\n`);
      }
    });
  tasks
    .command("wait")
    .argument("<task-id>")
    .option("--poll-interval-ms <milliseconds>", "poll interval", integer)
    .option("--wait-timeout-ms <milliseconds>", "overall wait timeout", integer)
    .description(
      "poll until a task reaches a terminal state; waiting does not cancel an accepted task",
    )
    .action(async (taskId: string, options: RetryTaskCommandOptions) => {
      const task = await createClient(clientOptions(program)).waitForTask(
        taskId,
        taskWaitOptions(options),
      );
      outputValue(task, isJson(program), io);
    });
  tasks
    .command("quote")
    .requiredOption("--model <model>", "exact live catalog model ID")
    .option("--input-json <json>", "model input JSON object")
    .option("--input-file <path>", "model input JSON file; use - for stdin")
    .option("--callback-url <url>", "terminal webhook URL")
    .description("quote the exact request without creating a task or reserving funds")
    .action(async (options: CreateTaskCommandOptions & { model: string }) => {
      const input = await readInputObject(options.inputJson, options.inputFile, io);
      const quote = await createClient(clientOptions(program)).quoteTask({
        model: options.model,
        input,
        ...(options.callbackUrl === undefined ? {} : { callBackUrl: options.callbackUrl }),
      });
      outputValue(quote, isJson(program), io);
    });
  tasks
    .command("create")
    .requiredOption("--model <model>", "exact live catalog model ID")
    .option("--input-json <json>", "model input JSON object")
    .option("--input-file <path>", "model input JSON file; use - for stdin")
    .option("--callback-url <url>", "terminal webhook URL")
    .option("--idempotency-key <key>", "stable logical-operation key; generated when omitted")
    .option(
      "--retention <duration>",
      `keep this task's ${DESTROYED_CONTENT} for at most this long: 30m, 1h, 7d, or plain seconds. Only shortens; 0 removes them once the task finishes. Billing records are always kept`,
      retentionDuration,
    )
    .option("--yes", "confirm the billable action non-interactively")
    .option("--wait", "wait for a terminal task after creation")
    .option("--poll-interval-ms <milliseconds>", "poll interval used with --wait", integer)
    .option("--wait-timeout-ms <milliseconds>", "overall timeout used with --wait", integer)
    .description("create a billable asynchronous generation task")
    .action(async (options: CreateTaskCommandOptions & { model: string }) => {
      const input = await readInputObject(options.inputJson, options.inputFile, io);
      const idempotencyKey = options.idempotencyKey ?? randomUUID();
      if (!options.yes && !io.stdinIsTTY) {
        await requireConfirmation("Create a billable task.", false, io);
      }
      const client = createClient(clientOptions(program));
      const payload = {
        model: options.model,
        input,
        ...(options.callbackUrl === undefined ? {} : { callBackUrl: options.callbackUrl }),
      };
      const quote = await client.quoteTask(payload);
      const retentionMessage =
        options.retention === undefined
          ? ""
          : options.retention === 0
            ? ` Retention: the ${DESTROYED_CONTENT} are removed once this task reaches a terminal state; billing records are kept.`
            : ` Retention: the ${DESTROYED_CONTENT} are kept for at most ${options.retention} seconds, or less if your account settings are shorter; billing records are kept.`;
      const priceMessage = `Estimated charge: USD ${quote.estimatedCost}; maximum charge: USD ${quote.maxCharge}. Quote expires: ${quote.expiresAt}.${retentionMessage}`;
      io.stderr(`${priceMessage}\nIdempotency-Key: ${idempotencyKey}\n`);
      await requireConfirmation(
        `Create a billable task with model ${options.model}? ${priceMessage} Idempotency-Key: ${idempotencyKey}.`,
        Boolean(options.yes),
        io,
      );
      const created = await client.createTask(
        { ...payload, quoteId: quote.quoteId, expectedCost: quote.estimatedCost },
        {
          idempotencyKey,
          ...(options.retention === undefined ? {} : { retentionSeconds: options.retention }),
        },
      );
      if (!options.wait) {
        outputValue({ idempotencyKey, ...created }, isJson(program), io);
        return;
      }
      const task = await waitAfterAccepted(client, created, idempotencyKey, options, io);
      outputValue({ idempotencyKey, accepted: created, task }, isJson(program), io);
    });
  tasks
    .command("retry")
    .argument("<task-id>", "failed or expired source task")
    .option("--idempotency-key <key>", "stable logical-operation key; generated when omitted")
    .option("--yes", "confirm the billable action non-interactively")
    .option("--wait", "wait for the new retry task")
    .option("--poll-interval-ms <milliseconds>", "poll interval used with --wait", integer)
    .option("--wait-timeout-ms <milliseconds>", "overall timeout used with --wait", integer)
    .description("create a new billable task from a failed or expired task")
    .action(async (taskId: string, options: RetryTaskCommandOptions) => {
      const idempotencyKey = options.idempotencyKey ?? randomUUID();
      await requireConfirmation(
        `Retry source task ${taskId}. Current schema, price, balance, and policy will be evaluated again. Idempotency-Key: ${idempotencyKey}.`,
        Boolean(options.yes),
        io,
      );
      io.stderr(`Idempotency-Key: ${idempotencyKey}\n`);
      const client = createClient(clientOptions(program));
      const created = await client.retryTask(taskId, { idempotencyKey });
      if (!options.wait) {
        outputValue({ idempotencyKey, ...created }, isJson(program), io);
        return;
      }
      const task = await waitAfterAccepted(client, created, idempotencyKey, options, io);
      outputValue({ idempotencyKey, accepted: created, task }, isJson(program), io);
    });

  tasks
    .command("purge")
    .argument(
      "<task-id>",
      "finished task whose content should be destroyed; a running task cannot be canceled, wait for it to finish",
    )
    .option("--yes", "confirm the destructive action non-interactively")
    .description(
      `permanently destroy one finished task's ${DESTROYED_CONTENT}; billing records are kept`,
    )
    .action(async (taskId: string, options: PurgeTaskCommandOptions) => {
      await requireConfirmation(
        `Permanently destroy the stored content of task ${taskId}: ${DESTROYED_CONTENT}. This cannot be undone. Billing records are kept — ${RETAINED_BILLING_RECORDS} stay queryable. Only the content is destroyed.`,
        Boolean(options.yes),
        io,
        "destructive",
      );
      const result = await createClient(clientOptions(program)).purgeTask(taskId);
      outputValue(result, isJson(program), io);
      if (!isJson(program)) {
        io.stdout(
          `Content destruction requested: ${DESTROYED_CONTENT}. Stored media objects are removed within about a minute. Billing records were not touched.\n`,
        );
      }
    });

  const files = program
    .command("files")
    .description("upload inputs and create short-lived output links");
  files
    .command("upload")
    .argument(
      "<path>",
      "image (JPEG/PNG/WebP/GIF), video (MP4/WebM), audio (MP3/WAV), or reference document (PDF, Word, Excel, PowerPoint, Keynote, Pages, Numbers, TXT, Markdown)",
    )
    .option("--content-type <type>", "override MIME type", parseUploadContentType)
    .description("upload a local file and print its spicy:// URI for use in model input")
    .action(async (filePath: string, options: { contentType?: CliUploadContentType }) => {
      const contentType = options.contentType ?? inferUploadContentType(filePath);
      outputValue(
        await createClient(clientOptions(program)).uploadFile(filePath, {
          /* The published SDK types stop at the eight media types; documents are passed through
             unchanged at runtime and validated by the server. See DocumentContentType. */
          contentType: contentType as UploadContentType,
        }),
        isJson(program),
        io,
      );
    });
  files
    .command("download-url")
    .argument("<task-id>")
    .option("--key <key>", "specific task output key; first output when omitted")
    .description("create a short-lived URL for a task output")
    .action(async (taskId: string, options: { key?: string }) => {
      outputValue(
        await createClient(clientOptions(program)).createDownloadUrl(taskId, options.key),
        isJson(program),
        io,
      );
    });

  const webhooks = program
    .command("webhooks")
    .description("verify current SpicyAPI callback signatures");
  webhooks
    .command("verify")
    .requiredOption("--body-file <path>", "raw, unmodified request body")
    .requiredOption("--timestamp <seconds>", "X-Webhook-Timestamp")
    .requiredOption("--signature <base64>", "X-Webhook-Signature")
    .requiredOption("--payload-version <version>", "X-Webhook-Payload-Version (1 or 2)", integer)
    .option(
      "--secret-env <name>",
      "environment variable containing the webhook secret",
      "SPICY_WEBHOOK_SECRET",
    )
    .option("--tolerance-seconds <seconds>", "accepted clock skew", integer, 300)
    .description("verify exact raw bytes; the secret is never accepted as a command argument")
    .action(
      async (options: {
        bodyFile: string;
        timestamp: string;
        signature: string;
        payloadVersion: number;
        secretEnv: string;
        toleranceSeconds: number;
      }) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.secretEnv)) {
          throw new TypeError("--secret-env must be an environment variable name");
        }
        const secret = io.env[options.secretEnv];
        if (!secret) throw new Error(`${options.secretEnv} is required`);
        if (options.payloadVersion !== 1 && options.payloadVersion !== 2) {
          throw new TypeError("--payload-version must be 1 or 2");
        }
        const rawBody = await readFile(options.bodyFile);
        outputValue(
          verifyWebhook({
            rawBody,
            timestamp: options.timestamp,
            signature: options.signature,
            payloadVersion: options.payloadVersion,
            secret,
            toleranceSeconds: options.toleranceSeconds,
          }),
          isJson(program),
          io,
        );
      },
    );

  return program;
}

export async function runCli(
  argv = process.argv,
  dependencies: CliDependencies = {},
): Promise<number> {
  const io = dependencies.io ?? defaultCliIo();
  const program = createCli({ ...dependencies, io });
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      // commander has already written the usage error to stderr through configureOutput. An
      // exitCode of 0 is an ordinary exit such as --help or --version; anything else simply carries
      // the code back rather than repeating the same sentence (under --json the machine-readable
      // form is still produced).
      if (error.exitCode === 0) return 0;
      if (isJson(program)) io.stderr(`${JSON.stringify(describeError(error))}\n`);
      return error.exitCode;
    }
    const details = describeError(error);
    if (isJson(program)) io.stderr(`${JSON.stringify(details)}\n`);
    else {
      io.stderr(
        `Error: ${details.error}${details.requestId ? ` (request ${details.requestId})` : ""}\n`,
      );
      /* A wait that failed after acceptance: this final error has to carry the taskId and the
         recovery command too. The two lines written at acceptance may long since have been scrolled
         off by polling output, and what people read is usually the last few lines - which is
         exactly where "re-run it and pay again" happens. */
      if (details.taskId !== undefined) {
        io.stderr(
          `Task ${details.taskId} was accepted and may still be running; only the wait stopped.\n` +
            `Recover: ${details.recover ?? `spicyapi tasks get ${details.taskId}`}\n` +
            `To replay the same request without creating a second task, reuse --idempotency-key ${details.idempotencyKey ?? "<original key>"}.\n`,
        );
      }
      // The server's message says what happened; the terminal still owes a sentence about what to
      // do now. Nothing is added under `--json`: that form is read by programs, and prose would only
      // pollute the parsing. A wrapped wait failure has to be unwrapped first, because the next step
      // depends on the underlying error (401, 429, 5xx) and the wrapper type is not a SpicyApiError,
      // so without unwrapping there is no advice at all.
      const next = describeNextStep(
        error instanceof TaskAcceptedButWaitFailedError ? error.cause : error,
        io.env,
      );
      if (next) io.stderr(`${next}\n`);
    }
    return 1;
  }
}
