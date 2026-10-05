"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const API_URL = "https://atq6wtkp6k.execute-api.us-east-1.amazonaws.com/prod/v1/composite-check";
const REQUEST_TIMEOUT_MS = 10000;
const MAX_TARGETS_PER_CALL = 4;
const SOURCE = "claude-guard-mod";
const AUDIT_DIR = path.join(os.homedir(), ".relayshield");
const AUDIT_FILE = path.join(AUDIT_DIR, "guard-audit.jsonl");
function reasonText(r) {
    return typeof r === "string" ? r : r.text ?? "";
}
async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}
function asString(v) {
    return typeof v === "string" ? v.trim() : "";
}
const URL_RE = /https?:\/\/[^\s"'<>`]+/gi;
const EVM_RE = /\b0x[0-9a-fA-F]{40}\b/g;
const SOLANA_RE = /\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/g;
const BTC_BECH32_RE = /\bbc1[qp][qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38,58}\b/gi;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function dedupeKeepOrder(items) {
    const seen = new Set();
    return items.filter((i) => (seen.has(i) ? false : (seen.add(i), true)));
}
function extractUrls(text) {
    return dedupeKeepOrder(Array.from(text.matchAll(URL_RE), (m) => m[0].replace(/[.,;:!?)\]]+$/, "")));
}
function extractWallets(text) {
    const found = [];
    for (const re of [EVM_RE, SOLANA_RE, BTC_BECH32_RE]) {
        for (const m of text.matchAll(re))
            found.push(m[0]);
    }
    return dedupeKeepOrder(found);
}
function extractEmail(input) {
    for (const key of ["from_address", "email", "applicant_email"]) {
        const v = asString(input[key]);
        if (v && EMAIL_RE.test(v))
            return v;
    }
    return "";
}
async function screen(kind, value) {
    const body = kind === "url"
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
        const parsed = (await resp.json());
        const data = parsed.data;
        if (!parsed.ok || !data)
            return null;
        const reasons = [];
        for (const s of data.signals ?? []) {
            for (const r of s.reasons ?? []) {
                const t = reasonText(r);
                if (t)
                    reasons.push(t);
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
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
/** Append one JSON line to the audit log. Never throws; logging must not break the hook. */
function audit(entry) {
    try {
        fs.mkdirSync(AUDIT_DIR, { recursive: true });
        fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n", "utf8");
    }
    catch {
        // ignore: audit logging is best-effort
    }
}
function formatBlock(v) {
    const lines = [
        "[RelayShield: BLOCKED] HIGH RISK target (score " + v.score + "/100):",
        "  target: " + v.target,
    ];
    for (const r of v.reasons.slice(0, 3))
        lines.push("  - " + r);
    if (v.provenance)
        lines.push("  provenance: " + v.provenance);
    lines.push("Do not proceed with this tool call. Stop and ask the user before continuing.");
    return lines.join("\n");
}
function formatFlagged(v) {
    return ("[RelayShield: FLAGGED] medium risk for " +
        v.target +
        " (score " +
        v.score +
        "/100). Proceed with caution; consider confirming with the user.");
}
async function main() {
    let input;
    try {
        input = JSON.parse(await readStdin());
    }
    catch {
        process.exit(0);
    }
    const toolName = asString(input.tool_name) || "unknown-tool";
    const toolInput = input.tool_input ?? {};
    const inputText = JSON.stringify(toolInput);
    const jobs = [];
    const seen = new Set();
    const push = (kind, value) => {
        const key = kind + ":" + value;
        if (!seen.has(key) && jobs.length < MAX_TARGETS_PER_CALL) {
            seen.add(key);
            jobs.push({ kind, value });
        }
    };
    for (const u of extractUrls(inputText))
        push("url", u);
    for (const w of extractWallets(inputText))
        push("wallet", w);
    const email = extractEmail(toolInput);
    if (email)
        push("email", email);
    if (jobs.length === 0)
        process.exit(0);
    const results = await Promise.all(jobs.map((j) => screen(j.kind, j.value)));
    const verdicts = [];
    const failed = [];
    const rank = { unknown: 0, medium: 1, high: 2 };
    let worst = null;
    for (let i = 0; i < results.length; i++) {
        const v = results[i];
        if (!v) {
            failed.push(jobs[i].value);
            continue;
        }
        verdicts.push(v);
        if (!worst || (rank[v.level] ?? 0) > (rank[worst.level] ?? 0))
            worst = v;
    }
    for (const f of failed) {
        process.stderr.write("[RelayShield: ALLOWED] screen did not run for " +
            f +
            " (request failed); allowing.\n");
    }
    let grade = "ALLOWED";
    let note = "";
    if (worst === null) {
        note = "no verdicts; all screens failed open";
    }
    else if (worst.level === "high") {
        grade = "BLOCKED";
        process.stderr.write(formatBlock(worst) + "\n");
        note = "blocked: high-risk target";
    }
    else if (worst.level === "medium") {
        grade = "FLAGGED";
        process.stderr.write(formatFlagged(worst) + "\n");
        note = "flagged: medium-risk target, allowed with warning";
    }
    else {
        process.stderr.write("[RelayShield: ALLOWED] no flags found for screened targets.\n");
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
        note: note +
            (failed.length > 0 ? "; failed-open: " + failed.join(", ") : ""),
    });
    process.exit(grade === "BLOCKED" ? 2 : 0);
}
main();
