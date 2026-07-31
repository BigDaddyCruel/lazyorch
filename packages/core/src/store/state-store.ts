import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Gate } from "../types/gate.js";
import type { Plan } from "../types/plan.js";
import type { Project } from "../types/project.js";
import type { Run } from "../types/run.js";
import type { Task } from "../types/task.js";
import type { Team } from "../types/team.js";
import { readJsonFile, writeJsonFile } from "./json-io.js";

/**
 * JSON file I/O for LazyOrch entities under a state root
 * (typically `<repo>/.lazyorch`).
 *
 * Layout:
 *   project.json
 *   runs/<run_id>/run.json
 *   runs/<run_id>/team.json
 *   runs/<run_id>/gates.json
 *   runs/<run_id>/tasks/<task_id>.json
 *   plans/<run_id>/plan.json
 */
export class StateStore {
  constructor(readonly root: string) {}

  // --- project ---

  projectPath(): string {
    return join(this.root, "project.json");
  }

  async readProject(): Promise<Project | null> {
    return readJsonFile<Project>(this.projectPath());
  }

  async writeProject(project: Project): Promise<void> {
    await writeJsonFile(this.projectPath(), project);
  }

  // --- run ---

  runDir(runId: string): string {
    return join(this.root, "runs", runId);
  }

  runPath(runId: string): string {
    return join(this.runDir(runId), "run.json");
  }

  async readRun(runId: string): Promise<Run | null> {
    return readJsonFile<Run>(this.runPath(runId));
  }

  async writeRun(run: Run): Promise<void> {
    await writeJsonFile(this.runPath(run.id), run);
  }

  // --- team ---

  teamPath(runId: string): string {
    return join(this.runDir(runId), "team.json");
  }

  async readTeam(runId: string): Promise<Team | null> {
    return readJsonFile<Team>(this.teamPath(runId));
  }

  async writeTeam(team: Team): Promise<void> {
    await writeJsonFile(this.teamPath(team.run_id), team);
  }

  // --- gates (array file per run) ---

  gatesPath(runId: string): string {
    return join(this.runDir(runId), "gates.json");
  }

  async readGates(runId: string): Promise<Gate[]> {
    const data = await readJsonFile<Gate[]>(this.gatesPath(runId));
    return data ?? [];
  }

  async writeGates(runId: string, gates: Gate[]): Promise<void> {
    await writeJsonFile(this.gatesPath(runId), gates);
  }

  // --- tasks ---

  tasksDir(runId: string): string {
    return join(this.runDir(runId), "tasks");
  }

  taskPath(runId: string, taskId: string): string {
    return join(this.tasksDir(runId), `${taskId}.json`);
  }

  async readTask(runId: string, taskId: string): Promise<Task | null> {
    return readJsonFile<Task>(this.taskPath(runId, taskId));
  }

  async writeTask(task: Task): Promise<void> {
    await writeJsonFile(this.taskPath(task.run_id, task.id), task);
  }

  async listTasks(runId: string): Promise<Task[]> {
    const dir = this.tasksDir(runId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    const tasks: Task[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const task = await readJsonFile<Task>(join(dir, name));
      if (task) tasks.push(task);
    }
    // Deterministic order for schedulers/tests (readdir is FS-dependent).
    tasks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return tasks;
  }

  async deleteTask(runId: string, taskId: string): Promise<void> {
    try {
      await unlink(this.taskPath(runId, taskId));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  // --- plan ---

  planDir(runId: string): string {
    return join(this.root, "plans", runId);
  }

  planPath(runId: string): string {
    return join(this.planDir(runId), "plan.json");
  }

  async readPlan(runId: string): Promise<Plan | null> {
    return readJsonFile<Plan>(this.planPath(runId));
  }

  async writePlan(plan: Plan): Promise<void> {
    await writeJsonFile(this.planPath(plan.run_id), plan);
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}
