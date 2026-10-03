# RelayShield Pre-Bind Screen (Claude Code plugin)

A PreToolUse hook that screens URLs and wallet addresses in tool calls
against RelayShield's threat-intel corpus before the agent fetches them.

## Behavior

- Any screened target graded `high`: the hook exits 2, which blocks the tool
  call. The message on stderr tells the agent what was flagged (target,
  score, top reasons, corpus provenance) and to stop or ask the user.
- Graded `medium`: the call is allowed, with a warning on stderr.
- Graded `unknown`, or the request fails or times out (15s): the call is
  allowed and a one-line note goes to stderr. Fail open, never silent.

RelayShield never declares anything "safe": `unknown` means nothing is known
against the target right now, not proof it is clean.

## Layout

- `.claude-plugin/plugin.json`: plugin manifest.
- `hooks/hooks.json`: registers the PreToolUse hook on `WebFetch`.
- `src/check-url.ts`: hook source (TypeScript).
- `dist/check-url.js`: compiled hook (what `hooks.json` runs).

## Build

```
npm install --no-audit --no-fund typescript
npx tsc
```

The compiled `dist/check-url.js` is what ships in the plugin.

## Install in Claude Code

Point Claude Code at this directory as a plugin (see the plugin docs for
`claude plugin` marketplace commands), or copy it into your plugins folder.
The hook needs outbound HTTPS access to the RelayShield API; no API key.
