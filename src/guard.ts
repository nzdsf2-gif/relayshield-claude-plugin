/**
 * RelayShield guard (PreToolUse hook).
 *
 * Pre-invocation screening: intercepts tool calls BEFORE the agent acts,
 * covering WebFetch calls and MCP server tool invocations (mcp__*). Extracts
 * URLs, wallet addresses, and applicant emails from the tool input, screens
 * each target against RelayShield's keyless composite-check API, and grades
 * the call:
 *   - BLOCKED (exit 2): any target graded "high". The stderr message shows
 *     target, score, top reasons, and corpus provenance, and tells the agent
 *     to stop or ask the user.
 *   - FLAGGED (exit 0): worst target graded "medium". The call is allowed,
 *     with a warning on stderr.
 *   - ALLOWED (exit 0): worst target "unknown", or the screen did not run
 *     (request failed/timed out). Fail open, never silent; a one-line note
 *     goes to stderr.
 *
 * Every decision is appended to a local audit log
 * (~/.relayshield/guard-audit.jsonl) as one JSON line, so the user can review
 * what the guard allowed, flagged, or blocked.
 *
 * Every API call carries "source": "claude-guard-mod" so guard traffic is
 * distinguishable from other keyless composite-check callers.
 *
 * RelayShield never declares anything "safe": "unknown" means nothing is
 * known against the target right now, not proof it is clean.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const API_URL =
  "https://atq6wtkp6k.execute-api.us-east-1.amazonaws.com/prod/v1/composite-check";
const REQUEST_TIMEOUT_MS = 10000;
const MAX_TARGETS_PER_CALL = 4;
const SOURCE = "claude-guard-mod";
const AUDIT_DIR = path.join(os.homedir(), ".relayshield");
const AUDIT_FILE = path.join(AUDIT_DIR, "guard-audit.jsonl");

type Grade = "BLOCKED" | "FLAGGED" | "ALLOWED";

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
  kind: string;
  level: string;
  score: number;
  reasons: string[];
  provenance: string | null;
}

interface AuditEntry {
  ts: string;
  tool_name: string;
  grade: Grade;
  targets: Array<{ target: string; kind: string; level: string; score: number }>;
  reasons: string[];
  note: string;
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

const URL_RE = /https?:\/\/[^\s"'<>`]+/gi;
const EVM_RE = /\b0x[0-9a-fA-F]{40}\b/g;
const SOLANA_RE = /\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/g;
const BTC_BECH32_RE = /\bbc1[qp][qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38,58}\b/gi;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function dedupeKeepOrder(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i) ? false : (seen.add(i), true)));
}

function extractUrls(text: string): string[] {
  return dedupeKeepOrder(
    Array.from(text.matchAll(URL_RE), (m) => m[0].replace(/[.,;:!?)\]]+$/, ""))
  );
}

function extractWallets(text: string): string[] {
  const found: string[] = [];
  for (const re of [EVM_RE, SOLANA_RE, BTC_BECH32_RE]) {
    for (const m of text.matchAll(re)) found.push(m[0]);
  }
  return dedupeKeepOrder(found);
}

function extractEmail(input: Record<string, unknown>): string {
  for (const key of ["from_address", "email", "applicant_email"]) {
    const v = asString(input[key]);
    if (v && EMAIL_RE.test(v)) return v;
  }
  return "";
}

async function screen(
  kind: string,
  value: string
): Promise<Verdict | null> {
  const body: Record<string, unknown> =
    kind === "url"
      ? { url: value }
      : kind === "wallet"
        ? { wallet: value }
        : { email: { from_address: value } };
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
      target: value,
      kind,
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

/** Append one JSON line to the audit log. Never throws; logging must not break the hook. */
function audit(entry: AuditEntry): void {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // ignore: audit logging is best-effort
  }
}

function formatBlock(v: Verdict): string {
  const lines = [
    "[RelayShield: BLOCKED] HIGH RISK target (score " + v.score + "/100):",
    "  target: " + v.target,
  ];
  for (const r of v.reasons.slice(0, 3)) lines.push("  - " + r);
  if (v.provenance) lines.push("  provenance: " + v.provenance);
  lines.push(
    "Do not proceed with this tool call. Stop and ask the user before continuing."
  );
  return lines.join("\n");
}

function formatFlagged(v: Verdict): string {
  return (
    "[RelayShield: FLAGGED] medium risk for " +
    v.target +
    " (score " +
    v.score +
    "/100). Proceed with caution; consider confirming with the user."
  );
}

async function main(): Promise<void> {
  let input: HookInput;
  try {
    input = JSON.parse(await readStdin()) as HookInput;
  } catch {
    process.exit(0);
  }
  const toolName = asString(input.tool_name) || "unknown-tool";
  const toolInput = input.tool_input ?? {};
  const inputText = JSON.stringify(toolInput);

  const jobs: Array<{ kind: string; value: string }> = [];
  const seen = new Set<string>();
  const push = (kind: string, value: string) => {
    const key = kind + ":" + value;
    if (!seen.has(key) && jobs.length < MAX_TARGETS_PER_CALL) {
      seen.add(key);
      jobs.push({ kind, value });
    }
  };

  for (const u of extractUrls(inputText)) push("url", u);
  for (const w of extractWallets(inputText)) push("wallet", w);
  const email = extractEmail(toolInput);
  if (email) push("email", email);
  if (jobs.length === 0) process.exit(0);

  const results = await Promise.all(jobs.map((j) => screen(j.kind, j.value)));
  const verdicts: Verdict[] = [];
  const failed: string[] = [];
  const rank: Record<string, number> = { unknown: 0, medium: 1, high: 2 };
  let worst: Verdict | null = null;
  for (let i = 0; i < results.length; i++) {
    const v = results[i];
    if (!v) {
      failed.push(jobs[i].value);
      continue;
    }
    verdicts.push(v);
    if (!worst || (rank[v.level] ?? 0) > (rank[worst.level] ?? 0)) worst = v;
  }

  for (const f of failed) {
    process.stderr.write(
      "[RelayShield: ALLOWED] screen did not run for " +
        f +
        " (request failed); allowing.\n"
    );
  }

  let grade: Grade = "ALLOWED";
  let note = "";
  if (worst === null) {
    note = "no verdicts; all screens failed open";
  } else if (worst.level === "high") {
    grade = "BLOCKED";
    process.stderr.write(formatBlock(worst) + "\n");
    note = "blocked: high-risk target";
  } else if (worst.level === "medium") {
    grade = "FLAGGED";
    process.stderr.write(formatFlagged(worst) + "\n");
    note = "flagged: medium-risk target, allowed with warning";
  } else {
    process.stderr.write(
      "[RelayShield: ALLOWED] no flags found for screened targets.\n"
    );
    note = "allowed: no flags found";
  }

  audit({
    ts: new Date().toISOString(),
    tool_name: toolName,
    grade,
    targets: verdicts.map((v) => ({
      target: v.target,
      kind: v.kind,
      level: v.level,
      score: v.score,
    })),
    reasons: worst ? worst.reasons.slice(0, 5) : [],
    note:
      note +
      (failed.length > 0 ? "; failed-open: " + failed.join(", ") : ""),
  });

  process.exit(grade === "BLOCKED" ? 2 : 0);
}

main();
