/**
 * RelayShield guard (PreToolUse hook).
 *
 * Intercepts tool calls carrying URLs, wallet addresses, or applicant
 * emails, screens each target against RelayShield's keyless composite-check
 * API, and:
 *   - exit 2 (block): any target graded "high". The stderr message tells the
 *     agent what was flagged and to stop or ask the user.
 *   - exit 0 (allow): "medium" prints a warning to stderr; "unknown",
 *     request errors, and timeouts fail open with a one-line stderr note.
 *
 * Every API call carries "source": "claude-guard-mod" so guard traffic is
 * distinguishable from other keyless composite-check callers.
 *
 * RelayShield never declares anything "safe": "unknown" means nothing is
 * known against the target right now, not proof it is clean.
 */

const API_URL =
  "https://atq6wtkp6k.execute-api.us-east-1.amazonaws.com/prod/v1/composite-check";
const REQUEST_TIMEOUT_MS = 10000;
const MAX_TARGETS_PER_CALL = 4;
const SOURCE = "claude-guard-mod";

interface HookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

interface Signal {
  type: string;
  target?: string;
  level?: string;
  flagged?: boolean;
  reasons?: Array<string | { text?: string }>;
}

interface Provenance {
  summary?: string | null;
  sightings_count?: number;
  market_names?: string[];
}

interface Verdict {
  target: string;
  level: string;
  score: number;
  reasons: string[];
  provenance: string | null;
}

function reasonText(r: string | { text?: string }): string {
  return typeof r === "string" ? r : r.text ?? "";
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function extractUrl(input: Record<string, unknown>): string {
  return asString(input["url"]);
}

const EVM_RE = /\b0x[0-9a-fA-F]{40}\b/g;
const SOLANA_RE = /\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/g;
const BTC_BECH32_RE = /\bbc1[qp][qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38,58}\b/gi;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function extractWallets(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const re of [EVM_RE, SOLANA_RE, BTC_BECH32_RE]) {
    for (const m of text.matchAll(re)) {
      if (!seen.has(m[0])) {
        seen.add(m[0]);
        found.push(m[0]);
      }
    }
  }
  return found;
}

function extractEmail(input: Record<string, unknown>): string {
  for (const key of ["from_address", "email", "applicant_email"]) {
    const v = asString(input[key]);
    if (v && EMAIL_RE.test(v)) return v;
  }
  return "";
}

async function screen(body: Record<string, unknown>): Promise<Verdict | null> {
  const target =
    typeof body["url"] === "string"
      ? (body["url"] as string)
      : typeof body["wallet"] === "string"
        ? (body["wallet"] as string)
        : typeof body["email"] === "object" && body["email"] !== null
          ? asString((body["email"] as Record<string, unknown>)["from_address"])
          : "?";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, source: SOURCE }),
      signal: controller.signal,
    });
    const parsed = (await resp.json()) as {
      ok?: boolean;
      data?: {
        level?: string;
        score?: number;
        signals?: Signal[];
        corpus_provenance?: Provenance[] | null;
      };
    };
    const data = parsed.data;
    if (!parsed.ok || !data) return null;
    const reasons: string[] = [];
    for (const s of data.signals ?? []) {
      for (const r of s.reasons ?? []) {
        const t = reasonText(r);
        if (t) reasons.push(t);
      }
    }
    const prov = (data.corpus_provenance ?? []).find((p) => p.summary);
    return {
      target,
      level: data.level ?? "unknown",
      score: typeof data.score === "number" ? data.score : 0,
      reasons,
      provenance: prov?.summary ?? null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function formatBlock(v: Verdict): string {
  const lines = [
    "RelayShield flagged this target as HIGH RISK (score " + v.score + "/100):",
    "  target: " + v.target,
  ];
  for (const r of v.reasons.slice(0, 3)) lines.push("  - " + r);
  if (v.provenance) lines.push("  provenance: " + v.provenance);
  lines.push(
    "Do not proceed with this fetch. Stop and ask the user before continuing."
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  let input: HookInput;
  try {
    input = JSON.parse(await readStdin()) as HookInput;
  } catch {
    process.exit(0);
  }
  const toolInput = input.tool_input ?? {};
  const jobs: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const push = (job: Record<string, unknown>) => {
    const key = JSON.stringify(job);
    if (!seen.has(key) && jobs.length < MAX_TARGETS_PER_CALL) {
      seen.add(key);
      jobs.push(job);
    }
  };

  const url = extractUrl(toolInput);
  if (url) push({ url });
  for (const w of extractWallets(JSON.stringify(toolInput))) {
    push({ wallet: w });
  }
  const email = extractEmail(toolInput);
  if (email) push({ email: { from_address: email } });
  if (jobs.length === 0) process.exit(0);

  const results = await Promise.all(jobs.map((j) => screen(j)));
  let worst: Verdict | null = null;
  const rank: Record<string, number> = { unknown: 0, medium: 1, high: 2 };
  for (let i = 0; i < results.length; i++) {
    const v = results[i];
    if (!v) {
      process.stderr.write(
        "RelayShield screen did not run for " +
          JSON.stringify(jobs[i]) +
          " (request failed); allowing.\n"
      );
      continue;
    }
    if (!worst || (rank[v.level] ?? 0) > (rank[worst.level] ?? 0)) worst = v;
  }

  if (worst === null) {
    process.exit(0);
    return;
  }
  if (worst.level === "high") {
    process.stderr.write(formatBlock(worst) + "\n");
    process.exit(2);
  }
  if (worst.level === "medium") {
    process.stderr.write(
      "RelayShield: medium risk for " +
        worst.target +
        " (score " +
        worst.score +
        "/100). Proceed with caution; consider confirming with the user.\n"
    );
  }
  process.exit(0);
}

main();
