# Skill: qa-runner

Run task-local acceptance and run-level smoke checks.

Write `result.json` in the session directory with shape:
```json
{
  "kind": "qa",
  "passed": true | false,
  "summary": "optional free text"
}
```

Prefer allowlisted shell commands only. Do not use `gh` or network merge tools.
