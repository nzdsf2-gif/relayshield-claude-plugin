---
name: relayshield-prebind-fraud-screen
description: Screen insurance applicants and payment counterparties for fraud before an agent submits an application or binds a policy. Use when an AI agent is about to collect applicant PII, submit an insurance application, take a premium payment, or fetch a quote/bind link on the user's behalf.
---

# RelayShield Pre-Bind Fraud Screen

An insurance-buying agent collects PII, runs underwriting, and takes payment in one conversation. That is a synthetic-identity and application-fraud surface. Run this screen before the agent submits an application or binds a policy.

## The API

All checks below use one keyless endpoint. No signup, no API key.

```
POST https://atq6wtkp6k.execute-api.us-east-1.amazonaws.com/prod/v1/composite-check
Content-Type: application/json
```

It returns `{"ok": true, "data": {...}}` with `level` (`high`, `medium`, or `unknown`), `score` (0-100), per-signal `signals`, and `corpus_provenance` when RelayShield's criminal threat-intel corpus knows the target.

RelayShield never declares anything "safe". The best possible result is `unknown`: nothing known against the target right now, not proof it is clean. Treat `unknown` as "no flags found", never as approval.

## Screen 1: applicant email

Check the applicant's email address for breach exposure and impersonation signals before it goes on an application.

Request:

```bash
curl -s -X POST "https://atq6wtkp6k.execute-api.us-east-1.amazonaws.com/prod/v1/composite-check" \
  -H "Content-Type: application/json" \
  -d '{"email":{"from_address":"billing@amaz0n-payments.net","subject":"Payment failed: update your card now","body_text":"Your premium payment failed. Update your payment method within 24 hours or your policy will be cancelled."}}'
```

Real response shape (medium risk):

```json
{
  "ok": true,
  "data": {
    "level": "medium",
    "score": 55,
    "signals": [
      {
        "type": "email",
        "level": "medium",
        "flagged": false,
        "reasons": [
          {"weight": 2, "text": "The message asks you to \"update your payment\" and puts a deadline on it: \"within 24 hours\". Being asked to act on your account AND being hurried are the two halves of almost every phishing message."}
        ]
      }
    ]
  }
}
```

Also screen any email the applicant forwards (carrier correspondence, "verify your policy" messages): pass the sender, subject, and body the same way. A sending domain that does not match the carrier it claims to be is a classic application-fraud tell.

## Screen 2: payment links and wallets

Before the agent opens a payment or bind link, or accepts a crypto wallet for premium payment, screen it.

Request:

```bash
curl -s -X POST "https://atq6wtkp6k.execute-api.us-east-1.amazonaws.com/prod/v1/composite-check" \
  -H "Content-Type: application/json" \
  -d '{"url":"http://sandboxle.com.cn/"}'
```

Real response shape (high risk, corpus hit):

```json
{
  "ok": true,
  "data": {
    "level": "high",
    "score": 90,
    "signals": [
      {
        "type": "url",
        "target": "http://sandboxle.com.cn/",
        "level": "high",
        "flagged": true,
        "reasons": ["this domain appears in RelayShield's criminal IOC corpus"]
      }
    ],
    "corpus_provenance": [
      {
        "sightings_count": 14,
        "markets_seen_count": 1,
        "market_names": ["urlhaus"],
        "malware_families": ["silverfox", "valleyrat"],
        "summary": "Seen in 1 criminal marketplace (urlhaus) · malware family silverfox · malware family valleyrat"
      }
    ]
  }
}
```

Wallets (EVM, Solana, Bitcoin, TON):

```bash
curl -s -X POST "https://atq6wtkp6k.execute-api.us-east-1.amazonaws.com/prod/v1/composite-check" \
  -H "Content-Type: application/json" \
  -d '{"wallet":"0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae"}'
```

A clean wallet returns `level: "unknown"`, `score: 15`, `flagged: false`, with reason `"no risk flags from wallet screening"`. Again: unknown means nothing known, not verified clean.

## Screen 3: applicant phone (keyed endpoint)

Phone reputation is available on the keyed API (`POST /v1/payg/phone-reputation`, API key required), not on the free keyless surface. If the integration holds a RelayShield API key, screen the applicant's phone number there too. Without a key, skip this screen and note the gap in the log.

## Decision policy

| Verdict | Action |
|---|---|
| `high` on any screen | Stop. Do not submit the application or open the payment link. Tell the user exactly what was flagged (target, score, top reasons, and the provenance summary when present) and ask how to proceed. |
| `medium` on any screen | Pause and ask the user before proceeding. Quote the reasons. |
| `unknown` on all screens | Proceed. Log the check and its reasons; absence of flags is not proof of safety. |
| Request fails or times out | Fail open: proceed, but log that the screen did not run and why. A screening outage must never silently become a clean bill of health. |

## Worked example

An agent is about to bind a policy and the applicant was sent a "complete your payment" link:

1. Screen the link: `{"url": "https://example-bind-link.com/pay"}` returns `unknown`, score 15. No flags found.
2. Screen the applicant email: `{"email": {"from_address": "applicant@gmail.com"}}` returns `unknown`. No flags found.
3. All screens unknown: proceed with the bind, and log both checks with their reasons.

If step 1 had returned `high` with a corpus provenance summary, the agent stops, shows the user the flagged domain and its provenance, and does not open the link or submit anything.
