# relayshield-claude-plugin

Claude Code plugin: a PreToolUse hook that screens URLs and wallet addresses
against RelayShield's threat-intel corpus before the agent fetches them.

## What it does

When the agent is about to fetch a URL (WebFetch), the hook calls
RelayShield's free keyless API and grades the target:

- **high**: the tool call is blocked. The agent is told what was flagged
  (target, score, top reasons, corpus provenance) and to stop or ask the user.
- **medium**: the call is allowed, with a warning.
- **unknown**, or the check fails or times out: the call is allowed with a
  one-line note. Fail open, never silent.

RelayShield never declares anything "safe": `unknown` means nothing is known
against the target right now, not proof it is clean.

## Install

```bash
claude plugin marketplace add nzdsf2-gif/relayshield-claude-plugin
claude plugin install relayshield-prebind-screen
```

Or point Claude Code at this repo as a plugin directory. The hook needs
outbound HTTPS access to the RelayShield API and Node.js on the machine.
No API key, no signup.

## Contents

- `relayshield-prebind-screen/`: the plugin (manifest, hook, compiled JS).
- `skills/relayshield-prebind-screen/SKILL.md`: the pre-bind fraud screen
  skill for insurance-shopping agents (applicant email, payment links and
  wallets, screened before an application is submitted or a policy bound).

## Links

- RelayShield: https://relayshield.net
- API docs: https://api.relayshield.net/developers
- Free checks: no signup, no key.
