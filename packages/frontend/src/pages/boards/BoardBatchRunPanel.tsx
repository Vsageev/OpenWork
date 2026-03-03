import { useState, useEffect } from 'react';
import { X, Bot, Play, CheckCircle2 } from 'lucide-react';
import { Button } from '../../ui';
import { api } from '../../lib/api';
import { toast } from '../../stores/toast';
import styles from './BoardBatchRunPanel.module.css';

interface BoardColumn {
  id: string;
  name: string;
  color: string;
  position: number;
}

interface AgentEntry {
  id: string;
  name: string;
  status: string;
  avatarIcon?: string;
  avatarBgColor?: string;
  avatarLogoColor?: string;
}

interface BatchResult {
  total: number;
  queued: number;
  message: string;
}

interface BoardBatchRunPanelProps {
  boardId: string;
  columns: BoardColumn[];
  onClose: () => void;
}

export function BoardBatchRunPanel({ boardId, columns, onClose }: BoardBatchRunPanelProps) {
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [agentId, setAgentId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [selectedColumnIds, setSelectedColumnIds] = useState<Set<string>>(
    () => new Set(columns.map((c) => c.id)),
  );
  const [maxParallel, setMaxParallel] = useState(3);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BatchResult | null>(null);

  useEffect(() => {
    api<{ entries: AgentEntry[] }>('/agents?limit=100').then((res) => {
      const active = res.entries.filter((a) => a.status === 'active');
      setAgents(active);
      if (active.length > 0) setAgentId(active[0].id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  function toggleColumn(id: string) {
    setSelectedColumnIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function selectAll() {
    setSelectedColumnIds(new Set(columns.map((c) => c.id)));
  }

  function deselectAll() {
    setSelectedColumnIds(new Set());
  }

  async function handleSubmit() {
    if (!agentId || !prompt.trim() || submitting) return;

    const columnIds =
      selectedColumnIds.size === columns.length
        ? undefined
        : Array.from(selectedColumnIds);

    if (columnIds !== undefined && columnIds.length === 0) {
      toast.error('Select at least one column');
      return;
    }

    setSubmitting(true);
    setResult(null);

    try {
      const res = await api<BatchResult>(`/boards/${boardId}/batch-run`, {
        method: 'POST',
        body: JSON.stringify({
          agentId,
          prompt: prompt.trim(),
          columnIds,
          maxParallel,
        }),
      });
      setResult(res);
      if (res.total === 0) {
        toast.info('No cards found on the board');
      } else {
        toast.success(`Batch run started — ${res.total} card${res.total !== 1 ? 's' : ''} queued`);
      }
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to start batch run');
    } finally {
      setSubmitting(false);
    }
  }

  const allSelected = selectedColumnIds.size === columns.length;

  return (
    <div className={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.panel}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <Bot size={16} />
            <span className={styles.title}>Batch Run</span>
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className={styles.body}>
          <p className={styles.description}>
            Run an agent on every card in this board. Cards are processed with concurrency control — the agent starts immediately in the background.
          </p>

          <div className={styles.formField}>
            <label className={styles.formLabel}>Agent</label>
            <select
              className={styles.selectInput}
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
            >
              {agents.length === 0 && <option value="">No active agents</option>}
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>

          <div className={styles.formField}>
            <label className={styles.formLabel}>Prompt</label>
            <textarea
              className={styles.promptTextarea}
              placeholder="What should the agent do with each card?"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
            />
          </div>

          {columns.length > 0 && (
            <div className={styles.formField}>
              <div className={styles.selectAllRow}>
                <span className={styles.formLabel}>Columns</span>
                <button
                  className={styles.selectAllBtn}
                  onClick={allSelected ? deselectAll : selectAll}
                  type="button"
                >
                  {allSelected ? 'Deselect all' : 'Select all'}
                </button>
              </div>
              <div className={styles.columnList}>
                {columns.map((col) => (
                  <label key={col.id} className={styles.columnCheckbox}>
                    <input
                      type="checkbox"
                      checked={selectedColumnIds.has(col.id)}
                      onChange={() => toggleColumn(col.id)}
                    />
                    <span
                      className={styles.columnDot}
                      style={{ background: col.color }}
                    />
                    {col.name}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className={styles.formField}>
            <label className={styles.formLabel}>Max parallel agents</label>
            <div className={styles.parallelRow}>
              <input
                type="number"
                className={styles.parallelInput}
                min={1}
                max={10}
                value={maxParallel}
                onChange={(e) => setMaxParallel(Math.max(1, Math.min(10, Number(e.target.value))))}
              />
              <span className={styles.parallelHint}>
                agents running at the same time (1–10)
              </span>
            </div>
          </div>

          {result && (
            <div className={`${styles.result} ${result.total === 0 ? styles.resultEmpty : styles.resultSuccess}`}>
              {result.total > 0 && <CheckCircle2 size={15} style={{ flexShrink: 0, marginTop: 1 }} />}
              {result.message}
            </div>
          )}
        </div>

        <div className={styles.footer}>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={submitting || !agentId || !prompt.trim() || selectedColumnIds.size === 0}
          >
            <Play size={14} />
            {submitting ? 'Starting…' : 'Run batch'}
          </Button>
        </div>
      </div>
    </div>
  );
}
