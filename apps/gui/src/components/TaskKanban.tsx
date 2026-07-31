import type { BoardTask } from "../api/types.js";
import { KANBAN_COLUMN_LABELS, KANBAN_COLUMNS, groupTasksByStatus } from "../lib/kanban.js";

export function TaskKanban({ tasks }: { tasks: BoardTask[] }) {
  const board = groupTasksByStatus(tasks);

  if (tasks.length === 0) {
    return (
      <p className="empty">
        No tasks for this run. Daemon run-detail APIs are still stubs — enable demo data in Settings
        for a full board.
      </p>
    );
  }

  return (
    <div className="kanban">
      {KANBAN_COLUMNS.map((col) => {
        const items = board[col];
        return (
          <div key={col} className="kanban-col">
            <div className="kanban-col-header">
              <span>{KANBAN_COLUMN_LABELS[col]}</span>
              <span>{items.length}</span>
            </div>
            <div className="kanban-col-body">
              {items.map((t) => (
                <TaskCard key={t.id} task={t} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TaskCard({ task }: { task: BoardTask }) {
  return (
    <div className="task-card">
      <div className="title">{task.title}</div>
      <div className="meta">
        <span className="mono">{task.id}</span>
        <span>P{task.priority}</span>
        {task.last_adapter_id && <span>{task.last_adapter_id}</span>}
        {task.last_model_tier && <span>tier:{task.last_model_tier}</span>}
        {task.blocked_reason && <span className="tag warn">{task.blocked_reason}</span>}
      </div>
    </div>
  );
}
