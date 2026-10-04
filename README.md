# relayshield-claude-plugin

Claude Code plugin: a PreToolUse hook that screens URLs, wallet addresses,
and applicant emails against RelayShield's threat-intel corpus before the
agent acts on them.

## What it screens

- **URLs** from `WebFetch` calls (and any `url` field in tool input)
- **Wallet addresses**: EVM (`0x...`), Solana (base58), Bitcoin (bech32 `bc1...`)
- **Applicant emails** (`from_address` / `email` fields): the insurance
  pre-bind screening case, kept as one covered input rather than the whole
  product

## Behavior

- **high**: the tool call is blocked. The agent is told what was flagged
  (target, score, top reasons, corpus provenance) and to stop or ask the user.
- **medium**: the call is allowed, with a warning.
- **unknown**, or the check fails or times out: the call is allowed with a
  one-line note. Fail open, never silent.

RelayShield never declares anything "safe": `unknown` means nothing is known
against the target right now, not proof it is clean.

Every API call carries `"source": "claude-guard-mod"` so guard traffic is
distinguishable from other keyless composite-check callers.

## Install

```bash
claude plugin marketplace add nzdsf2-gif/relayshield-claude-plugin
claude plugin install relayshield-guard
```

Or point Claude Code at this repo as a plugin directory. The hook needs
outbound HTTPS access to the RelayShield API and Node.js on the machine.
No API key, no signup.

## Contents

- `.claude-plugin/`: plugin manifest and icon.
- `hooks/hooks.json`: registers the PreToolUse hook on `WebFetch`.
- `src/guard.ts`: hook source (TypeScript).
- `dist/guard.js`: compiled hook (what `hooks.json` runs).
- `skills/relayshield-prebind-screen/SKILL.md`: the pre-bind fraud screen
  skill for insurance-shopping agents (applicant email, payment links and
  wallets, screened before an application is submitted or a policy bound).

This plugin replaces the former `relayshield-prebind-screen` plugin; it is a
strict superset (URLs, EVM/Solana/Bitcoin wallets, applicant emails).

## Build

```
npm install --no-audit --no-fund typescript @types/node
npx tsc
```

The compiled `dist/guard.js` is what ships in the plugin.

## Widening coverage

The hook extracts targets generically from `tool_input`, so to screen more
tool types, add their names to the `matcher` in `hooks/hooks.json`
(for example `"WebFetch|Bash"`). Keep the matcher narrow on purpose: every
matched tool call pays one hook round-trip.

## License

MIT. See `LICENSE`.

## Links

- RelayShield: https://relayshield.net
- API docs: https://api.relayshield.net/developers
- Free checks: no signup, no key.
