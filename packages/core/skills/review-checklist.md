# Skill: review-checklist

Produce a structured code review decision.

Write `result.json` in the session directory with shape:
```json
{
  "kind": "review",
  "decision": "approve" | "reject",
  "comments": "optional free text"
}
```

Check: correctness, scope adherence, tests/acceptance, security, and style consistency.
Reject when acceptance is unmet or scope is violated.
