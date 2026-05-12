import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { X, Bot, Play, Check, CheckCircle2, Minus, Plus, Zap, Layers, ChevronDown, Search, ListOrdered } from 'lucide-react';
import { Button, Tooltip } from '../../ui';
import { api } from '../../lib/api';
import { toast } from '../../stores/toast';
import { AgentAvatar } from '../../components/AgentAvatar';
import { BatchLayerPlanner, type BatchPlanCard } from '../../components/BatchLayerPlanner';
import {
  buildStagesFromLayers,
  type BatchLayer,
} from '../../lib/agent-batch';
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
  runId: string | null;
  total: number;
  queued: number;
  message: string;
}

interface BoardBatchRunPanelProps {
  boardId: string;
  columns: BoardColumn[];
  availableCards: Array<{
    id: string;
    name: string;
    columnId?: string | null;
    columnName?: string | null;
  }>;
  onClose: () => void;
}

export function BoardBatchRunPanel({ boardId, columns, availableCards, onClose }: BoardBatchRunPanelProps) {
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [agentId, setAgentId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [scopeMode, setScopeMode] = useState<'filters' | 'manual'>('filters');
  const [selectedColumnIds, setSelectedColumnIds] = useState<Set<string>>(
    () => new Set(columns.map((c) => c.id)),
  );
  const [textFilter, setTextFilter] = useState('');
  const [manualLayers, setManualLayers] = useState<BatchLayer[]>([{ cards: [] }]);
  const [maxParallel, setMaxParallel] = useState(3);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const agentPickerRef = useRef<HTMLDivElement>(null);

  // Preview count
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewAbortRef = useRef<AbortController | null>(null);

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

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (agentPickerRef.current && !agentPickerRef.current.contains(e.target as Node)) {
        setShowAgentPicker(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const manualCardCount = useMemo(
    () => manualLayers.reduce((s, l) => s + l.cards.length, 0),
    [manualLayers],
  );

  // Fetch preview count when filters change (debounced for text filter)
  useEffect(() => {
    if (scopeMode !== 'filters') {
      setPreviewLoading(false);
      setPreviewCount(manualCardCount);
      return;
    }

    // No columns selected → 0 cards, no need to call API
    if (selectedColumnIds.size === 0) {
      setPreviewCount(0);
      setPreviewLoading(false);
      return;
    }

    const timeout = setTimeout(() => {
      previewAbortRef.current?.abort();
      const abort = new AbortController();
      previewAbortRef.current = abort;

      const params = new URLSearchParams();
      if (selectedColumnIds.size < columns.length) {
        params.set('columnIds', Array.from(selectedColumnIds).join(','));
      }
      if (textFilter.trim()) {
        params.set('textFilter', textFilter.trim());
      }

      setPreviewLoading(true);
      api<{ count: number }>(`/boards/${boardId}/batch-run/preview?${params}`, { signal: abort.signal })
        .then((res) => {
          if (!abort.signal.aborted) setPreviewCount(res.count);
        })
        .catch(() => {})
        .finally(() => {
          if (!abort.signal.aborted) setPreviewLoading(false);
        });
    }, 300);

    return () => {
      clearTimeout(timeout);
      previewAbortRef.current?.abort();
    };
  }, [boardId, scopeMode, manualCardCount, selectedColumnIds, textFilter, columns.length]);

  const configuredStages = useMemo(
    () => scopeMode === 'manual' ? buildStagesFromLayers(manualLayers) : [],
    [scopeMode, manualLayers],
  );

  const loadManualOptions = useCallback(async (query: string): Promise<BatchPlanCard[]> => {
    const needle = query.toLowerCase();
    return availableCards
      .filter((card) => {
        if (!needle) return true;
        return card.name.toLowerCase().includes(needle)
          || (card.columnName ?? '').toLowerCase().includes(needle);
      })
      .slice(0, 30)
      .map((card) => ({
        id: card.id,
        name: card.name,
        subtitle: card.columnName ?? null,
      }));
  }, [availableCards]);

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
    if (!agentId || submitting) return;

    if (scopeMode === 'manual') {
      if (manualCardCount === 0) {
        toast.error('Add at least one card');
        return;
      }
    } else {
      const columnIds =
        selectedColumnIds.size === columns.length
          ? undefined
          : Array.from(selectedColumnIds);

      if (columnIds !== undefined && columnIds.length === 0) {
        toast.error('Select at least one column');
        return;
      }
    }

    setSubmitting(true);
    setResult(null);

    try {
      const res = await api<BatchResult>(`/boards/${boardId}/batch-run`, {
        method: 'POST',
        body: JSON.stringify({
          agentId,
          prompt: prompt.trim(),
          cardIds: scopeMode === 'manual' ? manualLayers.flatMap((l) => l.cards.map((c) => c.id)) : undefined,
          columnIds:
            scopeMode === 'filters' && selectedColumnIds.size < columns.length
              ? Array.from(selectedColumnIds)
              : undefined,
          textFilter: scopeMode === 'filters' ? textFilter.trim() || undefined : undefined,
          maxParallel,
          stages: configuredStages.length > 0 ? configuredStages : undefined,
        }),
      });
      setResult(res);
      if (res.total === 0) {
        toast.info('No cards found on the board');
      } else {
        toast.success(`Batch run started — ${res.total} card${res.total !== 1 ? 's' : ''} queued`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start batch run');
    } finally {
      setSubmitting(false);
    }
  }

  const allSelected = selectedColumnIds.size === columns.length;
  const selectedAgent = agents.find((a) => a.id === agentId);

  const disabledReason = submitting
    ? 'Batch run is starting…'
    : !agentId
      ? 'Select an agent first'
      : scopeMode === 'manual' && manualCardCount === 0
        ? 'Add at least one card'
        : scopeMode === 'filters' && selectedColumnIds.size === 0
          ? 'Select at least one column'
          : undefined;

  return (
    <div className={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.panel}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <div className={styles.headerIcon}>
              <Zap size={14} />
            </div>
            <span className={styles.title}>Batch Run</span>
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className={styles.body}>
          {/* Agent Selection */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <Bot size={14} className={styles.sectionIcon} />
              <span className={styles.sectionLabel}>Agent</span>
            </div>
            <div ref={agentPickerRef} className={styles.agentPicker}>
              <button
                type="button"
                className={styles.agentTrigger}
                onClick={() => setShowAgentPicker((v) => !v)}
              >
                {selectedAgent ? (
                  <>
                    <AgentAvatar
                      icon={selectedAgent.avatarIcon || 'spark'}
                      bgColor={selectedAgent.avatarBgColor || '#1a1a2e'}
                      logoColor={selectedAgent.avatarLogoColor || '#e94560'}
                      size={20}
                    />
                    <span className={styles.agentTriggerName}>{selectedAgent.name}</span>
                  </>
                ) : (
                  <span className={styles.agentPlaceholder}>
                    {agents.length === 0 ? 'No active agents' : 'Select an agent…'}
                  </span>
                )}
                <ChevronDown size={13} className={styles.agentChevron} />
              </button>
              {showAgentPicker && (
                <div className={styles.agentDropdown}>
                  {agents.length === 0 ? (
                    <div className={styles.agentDropdownEmpty}>No active agents available</div>
                  ) : (
                    agents.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        className={`${styles.agentOption} ${agentId === a.id ? styles.agentOptionActive : ''}`}
                        onClick={() => { setAgentId(a.id); setShowAgentPicker(false); }}
                      >
                        <AgentAvatar
                          icon={a.avatarIcon || 'spark'}
                          bgColor={a.avatarBgColor || '#1a1a2e'}
                          logoColor={a.avatarLogoColor || '#e94560'}
                          size={20}
                        />
                        <span className={styles.agentOptionName}>{a.name}</span>
                        {agentId === a.id && <Check size={12} className={styles.agentOptionCheck} />}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>

          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <ListOrdered size={14} className={styles.sectionIcon} />
              <span className={styles.sectionLabel}>Batch scope</span>
            </div>
            <div className={styles.columnChips}>
              <button
                type="button"
                className={`${styles.columnChip} ${scopeMode === 'filters' ? styles.columnChipSelected : ''}`}
                onClick={() => setScopeMode('filters')}
              >
                Filtered set
              </button>
              <button
                type="button"
                className={`${styles.columnChip} ${scopeMode === 'manual' ? styles.columnChipSelected : ''}`}
                onClick={() => setScopeMode('manual')}
              >
                Manual order
              </button>
            </div>
          </div>

          {/* Prompt */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionLabel}>Prompt (optional)</span>
              <span className={styles.charCount}>{prompt.length.toLocaleString()} / 10,000</span>
            </div>
            <textarea
              className={styles.promptTextarea}
              placeholder="Add extra instructions, or leave empty to use the card details."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={10000}
              rows={5}
            />
          </div>

          {scopeMode === 'filters' ? (
            <>
              {/* Columns */}
              {columns.length > 0 && (
                <div className={styles.section}>
                  <div className={styles.sectionHeader}>
                    <Layers size={14} className={styles.sectionIcon} />
                    <span className={styles.sectionLabel}>
                      Columns
                      <span className={styles.sectionCount}>
                        {selectedColumnIds.size}/{columns.length}
                      </span>
                    </span>
                    <button
                      className={styles.toggleAllBtn}
                      onClick={allSelected ? deselectAll : selectAll}
                      type="button"
                    >
                      {allSelected ? 'Clear' : 'All'}
                    </button>
                  </div>
                  <div className={styles.columnChips}>
                    {columns.map((col) => {
                      const selected = selectedColumnIds.has(col.id);
                      return (
                        <button
                          key={col.id}
                          className={`${styles.columnChip} ${selected ? styles.columnChipSelected : ''}`}
                          onClick={() => toggleColumn(col.id)}
                          type="button"
                        >
                          <span
                            className={styles.columnDot}
                            style={{ background: col.color }}
                          />
                          {col.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Text Filter */}
              <div className={styles.section}>
                <div className={styles.sectionHeader}>
                  <Search size={14} className={styles.sectionIcon} />
                  <span className={styles.sectionLabel}>Filter cards</span>
                </div>
                <input
                  className={styles.textFilterInput}
                  type="text"
                  placeholder="Filter by card name…"
                  value={textFilter}
                  onChange={(e) => setTextFilter(e.target.value)}
                  maxLength={200}
                />
              </div>
            </>
          ) : (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <Layers size={14} className={styles.sectionIcon} />
                <span className={styles.sectionLabel}>Cards &amp; layers</span>
              </div>
              <BatchLayerPlanner
                layers={manualLayers}
                onChange={setManualLayers}
                loadOptions={loadManualOptions}
                searchPlaceholder="Search board cards or columns..."
                emptySearchLabel="No board cards available"
              />
            </div>
          )}

          {/* Concurrency */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionLabel}>Concurrency</span>
            </div>
            <div className={styles.stepperRow}>
              <div className={styles.stepper}>
                <button
                  className={styles.stepperBtn}
                  onClick={() => setMaxParallel((v) => Math.max(1, v - 1))}
                  disabled={maxParallel <= 1}
                  type="button"
                  aria-label="Decrease"
                >
                  <Minus size={14} />
                </button>
                <span className={styles.stepperValue}>{maxParallel}</span>
                <button
                  className={styles.stepperBtn}
                  onClick={() => setMaxParallel((v) => Math.min(10, v + 1))}
                  disabled={maxParallel >= 10}
                  type="button"
                  aria-label="Increase"
                >
                  <Plus size={14} />
                </button>
              </div>
              <span className={styles.stepperHint}>parallel agents</span>
            </div>
          </div>

          {/* Result */}
          {result && (
            <div className={`${styles.result} ${result.total === 0 ? styles.resultEmpty : styles.resultSuccess}`}>
              {result.total > 0 && <CheckCircle2 size={15} style={{ flexShrink: 0, marginTop: 1 }} />}
              {result.message}
            </div>
          )}
        </div>

        <div className={styles.footer}>
          <div className={styles.footerMeta}>
            {previewCount !== null && (
              <span className={styles.footerCount}>
                {previewLoading ? '…' : previewCount} card{previewCount !== 1 ? 's' : ''}
              </span>
            )}
            {scopeMode === 'filters' && selectedColumnIds.size > 0 && selectedColumnIds.size < columns.length && (
              <span className={styles.footerColumns}>
                {selectedColumnIds.size} column{selectedColumnIds.size !== 1 ? 's' : ''}
              </span>
            )}
            {scopeMode === 'manual' && manualCardCount > 0 && (
              <span className={styles.footerColumns}>
                {configuredStages.length > 1
                  ? `${configuredStages.length} layers`
                  : `${manualCardCount} card${manualCardCount !== 1 ? 's' : ''}`}
              </span>
            )}
          </div>
          {disabledReason ? (
            <Tooltip label={disabledReason} position="top">
              <div style={{ cursor: 'not-allowed' }}>
                <Button
                  variant="primary"
                  disabled
                  style={{ pointerEvents: 'none' }}
                >
                  <Play size={14} />
                  {submitting ? 'Starting…' : 'Run batch'}
                </Button>
              </div>
            </Tooltip>
          ) : (
            <Button
              variant="primary"
              onClick={handleSubmit}
            >
              <Play size={14} />
              Run batch
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
