/**
 * Session materialization: prompt.md + meta.json (KD-40).
 * Only the session runner writes prompt_file; adapters never compose prompts.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scrubText } from "../scrub.js";
import type {
  AgentSession,
  SessionMeta,
  SessionTaskBlob,
} from "../types.js";

export interface SkillLoader {
  /** Return markdown for a skill id, or null if missing. */
  load(skillId: string): Promise<string | null> | string | null;
}

export const emptySkillLoader: SkillLoader = {
  load: () => null,
};

export interface MaterializeResult {
  session_dir: string;
  prompt_file: string;
  meta_file: string;
  prompt: string;
  meta: SessionMeta;
}

export interface MaterializeOptions {
  session_dir: string;
  run_handle: string;
  session: AgentSession;
  started_at: string;
  skill_loader?: SkillLoader;
  /** Optional inline skill markdown map (overrides loader when present). */
  skill_markdown?: Record<string, string>;
}

/**
 * Build prompt.md body in normative order:
 * 1. role system preamble
 * 2. bound skills markdown
 * 3. frozen plan paths + freeze_hash
 * 4. task blob (if any)
 * 5. context KV snapshot as fenced JSON
 * 6. role-specific output contract
 */
export function buildPromptMarkdown(
  session: AgentSession,
  skillsMarkdown: readonly string[],
): string {
  const parts: string[] = [];

  parts.push(`# Role: ${session.role}\n`);
  parts.push(session.role_prompt.trim());
  parts.push("");

  if (skillsMarkdown.length > 0) {
    parts.push("## Skills\n");
    for (const sm of skillsMarkdown) {
      parts.push(sm.trim());
      parts.push("");
    }
  }

  parts.push("## Frozen plan\n");
  parts.push(`- plan_dir: \`${session.context.plan_dir}\``);
  parts.push(`- freeze_hash: \`${session.context.freeze_hash}\``);
  parts.push(`- run_id: \`${session.context.run_id}\``);
  parts.push(`- feature_branch: \`${session.context.feature_branch}\``);
  if (session.context.feature_tip_sha) {
    parts.push(`- feature_tip_sha: \`${session.context.feature_tip_sha}\``);
  }
  parts.push("");

  if (session.context.task) {
    parts.push("## Task\n");
    parts.push(formatTaskBlob(session.context.task));
    parts.push("");
  }

  parts.push("## Context\n");
  parts.push("```json");
  parts.push(JSON.stringify(session.context.context_kv, null, 2));
  parts.push("```");
  parts.push("");

  parts.push("## Output contract\n");
  parts.push(outputContractForRole(session.role, session.session_dir));
  parts.push("");

  return scrubText(parts.join("\n"));
}

function formatTaskBlob(task: SessionTaskBlob): string {
  const lines = [
    `**id:** \`${task.id}\``,
    `**title:** ${task.title}`,
    "",
    task.description,
    "",
    "### Scope",
    ...task.scope.map((s) => `- \`${s}\``),
    "",
    "### Acceptance",
    ...task.acceptance.map((a) => `- ${a}`),
    "",
    "### Review criteria",
    ...task.review_criteria.map((r) => `- ${r}`),
  ];
  return lines.join("\n");
}

function outputContractForRole(role: string, sessionDir?: string): string {
  const resultPath = sessionDir
    ? `${sessionDir.replace(/\\/g, "/")}/result.json`
    : "result.json (session_dir)";
  switch (role) {
    case "worker":
      return [
        "When work is complete, write a JSON file:",
        "",
        "```json",
        `{ "kind": "worker", "submitted": true, "notes": "optional" }`,
        "```",
        "",
        `Preferred path: \`${resultPath}\`.`,
        "If you cannot finish, write `submitted: false` with notes.",
      ].join("\n");
    case "reviewer":
    case "plan_reviewer":
      return [
        "Write a review decision JSON file:",
        "",
        "```json",
        `{ "kind": "review", "decision": "approve" | "reject", "comments": "optional" }`,
        "```",
        "",
        `Preferred path: \`${resultPath}\`.`,
      ].join("\n");
    case "qa":
      return [
        "Write a QA report JSON file:",
        "",
        "```json",
        `{ "kind": "qa", "passed": true | false, "summary": "optional" }`,
        "```",
        "",
        `Preferred path: \`${resultPath}\`.`,
      ].join("\n");
    case "plan_writer":
      return [
        "Write plan artifacts under the plan directory (DESIGN.md, TASK_DAG.json, etc.).",
        `Optionally write status to \`${resultPath}\`.`,
      ].join("\n");
    case "lead":
      return [
        "Lead policy session: exit cleanly when the work queue is empty.",
        `Optional status file: \`${resultPath}\`.`,
      ].join("\n");
    default:
      return `Write optional result JSON to \`${resultPath}\`.`;
  }
}

export async function materializeSession(
  options: MaterializeOptions,
): Promise<MaterializeResult> {
  const { session_dir, run_handle, session, started_at } = options;
  await mkdir(session_dir, { recursive: true });

  const skillsMarkdown: string[] = [];
  for (const skillId of session.skills) {
    const inline = options.skill_markdown?.[skillId];
    if (inline !== undefined) {
      skillsMarkdown.push(inline);
      continue;
    }
    const loader = options.skill_loader ?? emptySkillLoader;
    const loaded = await loader.load(skillId);
    if (loaded) skillsMarkdown.push(loaded);
  }

  // Ensure session_dir is on the session for the output-contract path.
  const sessionWithDir: AgentSession = {
    ...session,
    session_dir,
  };

  const prompt = buildPromptMarkdown(sessionWithDir, skillsMarkdown);
  const prompt_file = join(session_dir, "prompt.md");
  await writeFile(prompt_file, prompt, "utf8");

  const meta: SessionMeta = {
    run_handle,
    agent_id: session.agent_id,
    role: session.role,
    adapter_id: session.adapter_id,
    model: session.model,
    model_tier: session.model_tier,
    session_kind: session.session_kind,
    started_at,
    timeout_ms: session.timeout_ms,
    freeze_hash: session.context.freeze_hash,
    cwd: session.cwd,
  };
  if (session.task_id !== undefined) meta.task_id = session.task_id;
  if (session.complexity_score !== undefined) {
    meta.complexity_score = session.complexity_score;
  }

  const meta_file = join(session_dir, "meta.json");
  await writeFile(meta_file, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

  return { session_dir, prompt_file, meta_file, prompt, meta };
}

/**
 * Substitute generic start_template placeholders after materialize.
 */
export function substituteStartTemplate(
  template: string,
  vars: {
    cwd: string;
    model: string;
    prompt_file: string;
    session_dir: string;
    timeout_ms: number;
    binary?: string;
    args_prefix?: readonly string[];
    agent_id?: string;
    task_id?: string;
  },
): string {
  const map: Record<string, string> = {
    "{cwd}": vars.cwd,
    "{model}": vars.model,
    "{prompt_file}": vars.prompt_file,
    "{session_dir}": vars.session_dir,
    "{timeout_ms}": String(vars.timeout_ms),
    "{binary}": vars.binary ?? "",
    "{args_prefix}": (vars.args_prefix ?? []).join(" "),
    "{agent_id}": vars.agent_id ?? "",
    "{task_id}": vars.task_id ?? "",
  };
  let out = template;
  for (const [k, v] of Object.entries(map)) {
    out = out.split(k).join(v);
  }
  return out;
}
