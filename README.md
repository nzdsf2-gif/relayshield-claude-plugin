# RelayShield Guard (Claude Code mod)

**Pre-invocation screening for AI agent actions.** A PreToolUse guard that
screens what your agent is about to touch, against RelayShield's
threat-intelligence corpus (661K+ indicators from 123 monitored
marketplaces), *before* the tool call executes. Covers `WebFetch` calls and
MCP server tool invocations (`mcp__*`).

## What it screens

- **URLs** from `WebFetch` calls and any URL found anywhere in an MCP tool's
  input
- **Wallet addresses**: EVM (`0x...`), Solana (base58), Bitcoin (bech32 `bc1...`)
- **Applicant emails** (`from_address` / `email` fields): the insurance
  pre-bind screening case, kept as one covered input rather than the whole
  product

## Behavior (tri-state grading)

Every screened call gets one grade, printed to stderr:

- **BLOCKED**: any target graded `high`. The hook exits 2, which blocks the
  tool call. The stderr message shows target, score, top reasons, and corpus
  provenance, and tells the agent to stop or ask the user.
- **FLAGGED**: worst target graded `medium`. The call is allowed, with a
  warning on stderr.
- **ALLOWED**: worst target graded `unknown`, or the screen did not run
  (request failed or timed out, 10s per check). Fail open, never silent; a
  one-line note goes to stderr.

RelayShield never declares anything "safe": `unknown` means nothing is
known against the target right now, not proof it is clean.

## Audit log

Every screening decision is appended as one JSON line to
`~/.relayshield/guard-audit.jsonl`:

```json
{"ts":"2026-10-05T11:20:00.000Z","tool_name":"WebFetch","grade":"BLOCKED","targets":[{"target":"http://evil.example/","kind":"url","level":"high","score":90}],"reasons":["..."],"note":"blocked: high-risk target"}
```

Review what the guard allowed, flagged, or blocked:

```bash
cat ~/.relayshield/guard-audit.jsonl
```

## Measurement

Every API call carries `"source": "claude-guard-mod"` so guard traffic is
distinguishable from other keyless composite-check callers.

## Layout

- `.claude-plugin/plugin.json`: plugin manifest.
- `hooks/hooks.json`: registers the PreToolUse hook on `WebFetch` and `mcp__*`.
- `src/guard.ts`: hook source (TypeScript).
- `dist/guard.js`: compiled hook (what `hooks.json` runs).

## Build

```bash
npm install
npm run build
```

## Test

Simulate a hook invocation (blocked case):

```bash
echo '{"tool_name":"WebFetch","tool_input":{"url":"http://example.com"}}' | node dist/guard.js; echo "exit=$?"
```

Simulate an MCP tool invocation:

```bash
echo '{"tool_name":"mcp__fetch__fetch","tool_input":{"url":"http://example.com"}}' | node dist/guard.js; echo "exit=$?"
```

Then check the audit log:

```bash
cat ~/.relayshield/guard-audit.jsonl
```
