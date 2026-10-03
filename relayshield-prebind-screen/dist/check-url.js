"use strict";
/**
 * RelayShield pre-fetch screen (PreToolUse hook).
 *
 * Intercepts tool calls carrying URLs or wallet addresses, screens each
 * target against RelayShield's keyless composite-check API, and:
 *   - exit 2 (block): any target graded "high". The stderr message tells the
 *     agent what was flagged and to stop or ask the user.
 *   - exit 0 (allow): "medium" prints a warning to stderr; "unknown", request
 *     errors, and timeouts fail open with a one-line stderr note.
 *
 * RelayShield never declares anything "safe": "unknown" means nothing is
 * known against the target right now, not proof it is clean.
 */
const API_URL = "https://atq6wtkp6k.execute-api.us-east-1.amazonaws.com/prod/v1/composite-check";
const REQUEST_TIMEOUT_MS = 15000;
const MAX_WALLETS_PER_CALL = 3;
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
function extractUrl(input) {
    const raw = input["url"];
    return typeof raw === "string" ? raw.trim() : "";
}
function extractWallets(raw) {
    const found = new Set();
    for (const m of raw.matchAll(/\b0x[0-9a-fA-F]{40}\b/g)) {
        found.add(m[0]);
        if (found.size >= MAX_WALLETS_PER_CALL)
            break;
    }
    return [...found];
}
async function screen(body) {
    const target = typeof body["url"] === "string"
        ? body["url"]
        : typeof body["wallet"] === "string"
            ? body["wallet"]
            : "?";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const resp = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
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
            target,
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
function formatBlock(v) {
    const lines = [
        "RelayShield flagged this target as HIGH RISK (score " + v.score + "/100):",
        "  target: " + v.target,
    ];
    for (const r of v.reasons.slice(0, 3))
        lines.push("  - " + r);
    if (v.provenance)
        lines.push("  provenance: " + v.provenance);
    lines.push("Do not proceed with this fetch. Stop and ask the user before continuing.");
    return lines.join("\n");
}
async function main() {
    let input;
    try {
        input = JSON.parse(await readStdin());
    }
    catch {
        process.exit(0);
    }
    const toolInput = input.tool_input ?? {};
    const jobs = [];
    const url = extractUrl(toolInput);
    if (url)
        jobs.push({ url });
    for (const w of extractWallets(JSON.stringify(toolInput))) {
        jobs.push({ wallet: w });
    }
    if (jobs.length === 0)
        process.exit(0);
    let worst = null;
    const rank = { unknown: 0, medium: 1, high: 2 };
    for (const job of jobs) {
        const v = await screen(job);
        if (!v) {
            process.stderr.write("RelayShield screen did not run for " +
                JSON.stringify(job) +
                " (request failed); allowing.\n");
            continue;
        }
        if (!worst || (rank[v.level] ?? 0) > (rank[worst.level] ?? 0))
            worst = v;
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
        process.stderr.write("RelayShield: medium risk for " +
            worst.target +
            " (score " +
            worst.score +
            "/100). Proceed with caution; consider confirming with the user.\n");
    }
    process.exit(0);
}
main();
