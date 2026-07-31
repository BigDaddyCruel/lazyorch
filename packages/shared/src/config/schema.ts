import { z } from "zod";

/** Model complexity tiers used by routing. */
export const MODEL_TIERS = [
  "nano",
  "small",
  "medium",
  "large",
  "xlarge",
] as const;

export const ModelTierSchema = z.enum(MODEL_TIERS);
export type ModelTier = z.infer<typeof ModelTierSchema>;

export const AdapterSourceSchema = z.enum([
  "builtin",
  "path_discover",
  "user_config",
]);
export type AdapterSource = z.infer<typeof AdapterSourceSchema>;

export const AdapterCapabilitiesSchema = z.object({
  models: z.array(z.string()).default([]),
  tier_map: z.record(z.string(), z.string()).default(() => ({})),
  streaming: z.boolean().default(false),
  worktree_ok: z.boolean().default(true),
  usage_reporting: z
    .enum(["none", "tokens", "tokens_and_cost"])
    .default("none"),
  effort_flag: z.boolean().optional(),
  max_concurrent_hint: z.number().int().positive().optional(),
});

/** User-registered adapter entry under `adapters.registry[]`. */
export const AdapterRegistryEntrySchema = z.object({
  id: z.string().min(1),
  display_name: z.string().min(1).optional(),
  binary: z.string().min(1).optional(),
  args_prefix: z.array(z.string()).optional(),
  version_args: z.array(z.string()).optional(),
  version_floor: z.string().optional(),
  /**
   * Optional argv for model-list probe (PR-22), e.g. `["models"]` for opencode.
   * When set, adapter.listModels() may exec the binary; otherwise uses
   * capabilities.models / tier_map.
   */
  models_args: z.array(z.string()).optional(),
  enabled: z.boolean().default(true),
  source: AdapterSourceSchema.default("user_config"),
  candidates: z.array(z.string()).optional(),
  capabilities: AdapterCapabilitiesSchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
  start_template: z.string().optional(),
});
export type AdapterRegistryEntry = z.infer<typeof AdapterRegistryEntrySchema>;

/** Built-in adapter toggle (claude / codex / agy / grok / shell). */
export const BuiltinAdapterConfigSchema = z.object({
  enabled: z.boolean().default(true),
  binary: z.string().nullable().default(null),
  candidates: z.array(z.string()).optional(),
});

export const AdaptersConfigSchema = z
  .object({
    default: z.string().default("claude"),
    preference_order: z
      .array(z.string())
      .default(() => ["claude", "codex", "grok", "agy", "shell"]),
    claude: BuiltinAdapterConfigSchema.default(() => ({
      enabled: true,
      binary: null,
    })),
    codex: BuiltinAdapterConfigSchema.default(() => ({
      enabled: true,
      binary: null,
    })),
    agy: BuiltinAdapterConfigSchema.default(() => ({
      enabled: true,
      binary: null,
      candidates: ["agy"],
    })),
    grok: BuiltinAdapterConfigSchema.default(() => ({
      enabled: true,
      binary: null,
      candidates: ["grok", "grok-cli", "xai"],
    })),
    shell: z
      .object({ enabled: z.boolean().default(true) })
      .default(() => ({ enabled: true })),
    registry: z.array(AdapterRegistryEntrySchema).default(() => []),
    /** Optional per-adapter tier_map overrides. */
    models: z.record(z.string(), z.unknown()).default(() => ({})),
  })
  .strict()
  .superRefine((adapters, ctx) => {
    const seen = new Map<string, number>();
    for (let i = 0; i < adapters.registry.length; i++) {
      const id = adapters.registry[i]?.id;
      if (!id) continue;
      const prev = seen.get(id);
      if (prev !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["registry", i, "id"],
          message: `duplicate adapters.registry id "${id}" (first at index ${prev})`,
        });
      } else {
        seen.set(id, i);
      }
    }
  });
export type AdaptersConfig = z.infer<typeof AdaptersConfigSchema>;

export const ModelsConfigSchema = z.object({
  routing_enabled: z.boolean().default(true),
  strict_role_floors: z.boolean().default(false),
  escalate_on_failure: z.boolean().default(true),
  escalate_after_failures: z.number().int().nonnegative().default(1),
  max_tier: ModelTierSchema.default("xlarge"),
  budget_tier_cap: ModelTierSchema.default("medium"),
  role_tier_floor: z
    .object({
      plan_writer: ModelTierSchema.default("large"),
      plan_reviewer: ModelTierSchema.default("large"),
      lead: ModelTierSchema.default("medium"),
      reviewer: ModelTierSchema.default("medium"),
      worker: ModelTierSchema.default("small"),
      qa: ModelTierSchema.default("small"),
    })
    .default(() => ({
      plan_writer: "large" as const,
      plan_reviewer: "large" as const,
      lead: "medium" as const,
      reviewer: "medium" as const,
      worker: "small" as const,
      qa: "small" as const,
    })),
});
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

export const ElasticityConfigSchema = z
  .object({
    min_workers: z.number().int().nonnegative().default(0),
    max_workers: z.number().int().nonnegative().default(4),
    scale_up_ready_ratio: z.number().positive().default(2),
    scale_down_idle_minutes: z.number().nonnegative().default(10),
    cooldown_seconds: z.number().nonnegative().default(60),
    scale_burst: z.number().int().positive().default(1),
    pressure_scale_down: z.boolean().default(true),
  })
  .strict();
export type ElasticityConfig = z.infer<typeof ElasticityConfigSchema>;

export const SchedulingConfigSchema = z
  .object({
    max_concurrent_agents: z.number().int().positive().default(8),
    tick_interval_ms: z.number().int().positive().default(5000),
    stall_timeout_ms: z.number().int().positive().default(600_000),
    retry_base_delay_ms: z.number().int().nonnegative().default(10_000),
    retry_max_delay_ms: z.number().int().nonnegative().default(300_000),
    task_max_attempts: z.number().int().positive().default(3),
    on_task_terminal_failed: z
      .enum(["gate", "fail_run", "wait"])
      .default("gate"),
    failed_escalation_ms: z.number().int().nonnegative().default(0),
    scope_lock_wait_ms: z.number().int().nonnegative().default(60_000),
    cancel_grace_ms: z.number().int().nonnegative().default(30_000),
  })
  .strict();
export type SchedulingConfig = z.infer<typeof SchedulingConfigSchema>;

export const ReserveSlotsConfigSchema = z
  .object({
    lead: z.number().int().nonnegative().default(1),
  })
  .strict();
export type ReserveSlotsConfig = z.infer<typeof ReserveSlotsConfigSchema>;

export const TeamConfigSchema = z
  .object({
    mode: z.enum(["full", "solo"]).default("full"),
    lead_template: z.string().default("architect-lead"),
    reviewer_templates: z.array(z.string()).default(() => ["code-reviewer"]),
    qa_templates: z.array(z.string()).default(() => ["qa-engineer"]),
    worker_templates: z
      .array(z.string())
      .default(() => ["fullstack-dev", "backend-dev", "frontend-dev"]),
    min_reviewers: z.number().int().nonnegative().default(1),
    max_reviewers: z.number().int().nonnegative().default(2),
    min_qa: z.number().int().nonnegative().default(1),
    max_qa: z.number().int().nonnegative().default(2),
  })
  .strict();
export type TeamConfig = z.infer<typeof TeamConfigSchema>;

/**
 * Gate policy config.
 * `timeout_action`: interactive default `none`; headless/CI effective default `fail` (KD-44).
 */
export const GatesConfigSchema = z
  .object({
    plan_approve: z.boolean().default(true),
    plan_reject_action: z.enum(["cancel", "revise"]).default("cancel"),
    merge: z.boolean().default(true),
    destructive_git: z.boolean().default(true),
    task_approve: z.boolean().default(false),
    allow_yes_plan: z.boolean().default(false),
    timeout_notify_hours: z.number().nonnegative().default(1),
    timeout_action: z.enum(["none", "cancel", "fail"]).default("none"),
  })
  .strict();
export type GatesConfig = z.infer<typeof GatesConfigSchema>;

export const PlanningConfigSchema = z.object({
  max_rounds: z.number().int().positive().default(5),
  human_gate: z.boolean().default(true),
  plan_reviewer_count: z.number().int().nonnegative().default(1),
  max_design_bytes: z.number().int().positive().default(524_288),
  max_context_chars: z.number().int().positive().default(100_000),
  strict_scopes: z.boolean().default(true),
  commit_to_git: z.boolean().default(false),
  edit_resets_rounds: z.boolean().default(false),
});

export const FeaturesConfigSchema = z.object({
  elastic_workers: z.boolean().default(true),
  github_integration: z.boolean().default(true),
  gui: z.boolean().default(true),
  auto_merge: z.boolean().default(false),
  multi_pr: z.boolean().default(false),
  sqlite_index: z.boolean().default(true),
  /** Alias of models.routing_enabled (resolved at load). */
  model_routing: z.boolean().default(true),
  messaging: z.boolean().default(false),
});

export const ProjectMetaConfigSchema = z.object({
  name: z.string().default("project"),
  default_branch: z.string().default("main"),
});

export const WorkspaceConfigSchema = z.object({
  mode: z.enum(["worktree"]).default("worktree"),
  worktree_root: z.string().nullable().default(null),
  worktree_tombstone_days: z.number().int().nonnegative().default(7),
});

export const ForgeConfigSchema = z.object({
  provider: z.enum(["github"]).default("github"),
  draft_pr_on_first_integration: z.boolean().default(true),
  required_checks: z.array(z.string()).default(() => []),
  merge_method: z.enum(["squash", "merge", "rebase"]).default("squash"),
  merge_gate: z.enum(["human", "auto"]).default("human"),
});

export const BudgetConfigSchema = z.object({
  max_usd_per_run: z.number().nonnegative().nullable().default(null),
  max_agent_hours: z.number().nonnegative().nullable().default(null),
  max_run_hours: z.number().nonnegative().nullable().default(null),
  hard_stop: z.boolean().default(true),
  model_rates: z.record(z.string(), z.unknown()).default(() => ({})),
});

export const ShellConfigSchema = z.object({
  allowed_commands: z
    .array(z.string())
    .default(() => [
      "git",
      "npm",
      "pnpm",
      "node",
      "npx",
      "vitest",
      "tsc",
      "eslint",
    ]),
  deny_patterns: z
    .array(z.string())
    .default(() => ["rm -rf /", "git push --force", "git push -f"]),
});

export const ContextConfigSchema = z.object({
  worker_write: z.boolean().default(false),
});

export const LeadConfigSchema = z.object({
  max_restarts_per_hour: z.number().int().nonnegative().default(3),
  session_mode: z.enum(["ephemeral"]).default("ephemeral"),
});

export const ReviewerConfigSchema = z.object({
  idle_exit_ms: z.number().int().nonnegative().default(60_000),
  max_restarts_per_hour: z.number().int().nonnegative().default(6),
});

export const QaConfigSchema = z.object({
  max_restarts_per_hour: z.number().int().nonnegative().default(6),
});

/**
 * Full project operator config (`.lazyorch/config.yml`).
 * Partial input is accepted; missing sections receive design defaults.
 * Each section is optional at input; when absent we parse `{}` so field defaults apply.
 * Top-level and packing-critical sections are `.strict()` so typos fail closed.
 */
export const LazyorchConfigSchema = z
  .object({
    project: ProjectMetaConfigSchema.default(() =>
      ProjectMetaConfigSchema.parse({}),
    ),
    adapters: AdaptersConfigSchema.default(() => AdaptersConfigSchema.parse({})),
    models: ModelsConfigSchema.default(() => ModelsConfigSchema.parse({})),
    planning: PlanningConfigSchema.default(() => PlanningConfigSchema.parse({})),
    team: TeamConfigSchema.default(() => TeamConfigSchema.parse({})),
    elasticity: ElasticityConfigSchema.default(() =>
      ElasticityConfigSchema.parse({}),
    ),
    scheduling: SchedulingConfigSchema.default(() =>
      SchedulingConfigSchema.parse({}),
    ),
    reserve_slots: ReserveSlotsConfigSchema.default(() =>
      ReserveSlotsConfigSchema.parse({}),
    ),
    reviewer: ReviewerConfigSchema.default(() => ReviewerConfigSchema.parse({})),
    qa: QaConfigSchema.default(() => QaConfigSchema.parse({})),
    workspace: WorkspaceConfigSchema.default(() =>
      WorkspaceConfigSchema.parse({}),
    ),
    forge: ForgeConfigSchema.default(() => ForgeConfigSchema.parse({})),
    budget: BudgetConfigSchema.default(() => BudgetConfigSchema.parse({})),
    shell: ShellConfigSchema.default(() => ShellConfigSchema.parse({})),
    gates: GatesConfigSchema.default(() => GatesConfigSchema.parse({})),
    context: ContextConfigSchema.default(() => ContextConfigSchema.parse({})),
    features: FeaturesConfigSchema.default(() => FeaturesConfigSchema.parse({})),
    lead: LeadConfigSchema.default(() => LeadConfigSchema.parse({})),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.team.min_reviewers > cfg.team.max_reviewers) {
      ctx.addIssue({
        code: "custom",
        path: ["team", "min_reviewers"],
        message: `min_reviewers (${cfg.team.min_reviewers}) > max_reviewers (${cfg.team.max_reviewers})`,
      });
    }
    if (cfg.team.min_qa > cfg.team.max_qa) {
      ctx.addIssue({
        code: "custom",
        path: ["team", "min_qa"],
        message: `min_qa (${cfg.team.min_qa}) > max_qa (${cfg.team.max_qa})`,
      });
    }
    if (cfg.elasticity.min_workers > cfg.elasticity.max_workers) {
      ctx.addIssue({
        code: "custom",
        path: ["elasticity", "min_workers"],
        message: `min_workers (${cfg.elasticity.min_workers}) > max_workers (${cfg.elasticity.max_workers})`,
      });
    }
  });

export type LazyorchConfig = z.infer<typeof LazyorchConfigSchema>;
export type LazyorchConfigInput = z.input<typeof LazyorchConfigSchema>;
