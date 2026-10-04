# RelayShield Guard (Claude Code mod)

A PreToolUse guard that screens what your agent is about to touch against
RelayShield's threat-intelligence corpus (661K+ indicators from 123
monitored marketplaces) before the tool call executes.

## What it screens

- **URLs** from `WebFetch` calls (and any `url` field in tool input)
- **Wallet addresses**: EVM (`0x...`), Solana (base58), Bitcoin (bech32 `bc1...`)
- **Applicant emails** (`from_address` / `email` fields): the insurance
  pre-bind screening case, kept as one covered input rather than the whole
  product

## Behavior

- Any target graded `high`: the hook exits 2, which blocks the tool call.
  The stderr message shows target, score, top reasons, and corpus
  provenance, and tells the agent to stop or ask the user.
- Graded `medium`: the call is allowed, with a warning on stderr.
- Graded `unknown`, or the request fails or times out (10s per check):
  the call is allowed and a one-line note goes to stderr. Fail open,
  never silent.

RelayShield never declares anything "safe": `unknown` means nothing is
known against the target right now, not proof it is clean.

## Measurement

Every API call carries `"source": "claude-guard-mod"` so guard traffic is
distinguishable from other keyless composite-check callers.

## Layout

- `.claude-plugin/plugin.json`: plugin manifest.
- `hooks/hooks.json`: registers the PreToolUse hook on `WebFetch`.
- `src/guard.ts`: hook source (TypeScript).
- `dist/guard.js`: compiled hook (what `hooks.json` runs).

## Build

```
npm install --no-audit --no-fund typescript @types/node
npx tsc
```

The compiled `dist/guard.js` is what ships in the plugin.

## Install in Claude Code

Point Claude Code at this directory as a plugin (see the plugin docs for
the current marketplace / mod install commands), or copy it into your
plugins folder. The hook needs outbound HTTPS access to the RelayShield
API. No API key, no signup, no cost: the composite-check endpoint is free
and keyless.

## Widening coverage

The hook extracts targets generically from `tool_input`, so to screen more
tool types, add their names to the `matcher` in `hooks/hooks.json`
(for example `"WebFetch|Bash"`). Keep the matcher narrow on purpose: every
matched tool call pays one hook round-trip.
