import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { X, Bot, Play, Check, CheckCircle2, Minus, Plus, Zap, ChevronDown, Search, Tag, Save, ListOrdered, Layers } from 'lucide-react';
import { Button, Tooltip } from '../../ui';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../stores/toast';
import { AgentAvatar } from '../../components/AgentAvatar';
import { BatchLayerPlanner, type BatchPlanCard } from '../../components/BatchLayerPlanner';
import {
  buildStagesFromLayers,
  type BatchLayer,
} from '../../lib/agent-batch';
import styles from './CollectionBatchRunPanel.module.css';

interface AgentBatchConfig {
  agentId?: string | null;
  prompt?: string | null;
  maxParallel?: number;
  cardFilters?: {
    search?: string;
    tagId?: string;
  };
}

interface AgentEntry {
  id: string;
  name: string;
  status?: string;
  avatarIcon?: string | null;
  avatarBgColor?: string | null;
  avatarLogoColor?: string | null;
}

interface TagEntry {
  id: string;
  name: string;
  color: string;
}

interface BatchResult {
  runId: string | null;
  total: number;
  queued: number;
  message: string;
}

interface CollectionBatchRunPanelProps {
  collectionId: string;
  tags: TagEntry[];
  initialConfig?: AgentBatchConfig | null;
  onClose: () => void;
  onConfigSaved?: (config: AgentBatchConfig) => void;
}

export function CollectionBatchRunPanel({
  collectionId,
  tags,
  initialConfig,
  onClose,
  onConfigSaved,
}: CollectionBatchRunPanelProps) {
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [agentId, setAgentId] = useState(initialConfig?.agentId ?? '');
  const [prompt, setPrompt] = useState(initialConfig?.prompt ?? '');
  const [scopeMode, setScopeMode] = useState<'filters' | 'manual'>('filters');
  const [textFilter, setTextFilter] = useState(initialConfig?.cardFilters?.search ?? '');
  const [tagFilter, setTagFilter] = useState(initialConfig?.cardFilters?.tagId ?? '');
  const [manualLayers, setManualLayers] = useState<BatchLayer[]>([{ cards: [] }]);
  const [maxParallel, setMaxParallel] = useState(initialConfig?.maxParallel ?? 3);
  const [submitting, setSubmitting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const agentPickerRef = useRef<HTMLDivElement>(null);

  // Preview count
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    api<{ entries: AgentEntry[] }>('/agents?limit=100').then((res) => {
      const active = res.entries.filter((a) => !a.status || a.status === 'active');
      setAgents(active);
      setAgentId((current) => current || active[0]?.id || '');
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

  // Fetch preview count when filters change
  useEffect(() => {
    if (scopeMode !== 'filters') {
      setPreviewLoading(false);
      setPreviewCount(manualCardCount);
      return;
    }

    const timeout = setTimeout(() => {
      previewAbortRef.current?.abort();
      const abort = new AbortController();
      previewAbortRef.current = abort;

      const params = new URLSearchParams({ collectionId, countOnly: 'true' });
      if (textFilter.trim()) params.set('search', textFilter.trim());
      if (tagFilter) params.set('tagId', tagFilter);

      setPreviewLoading(true);
      api<{ total: number }>(`/cards?${params}`, { signal: abort.signal })
        .then((res) => {
          if (!abort.signal.aborted) setPreviewCount(res.total);
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
  }, [collectionId, scopeMode, manualCardCount, textFilter, tagFilter]);

  const configuredStages = useMemo(
    () => scopeMode === 'manual' ? buildStagesFromLayers(manualLayers) : [],
    [scopeMode, manualLayers],
  );

  const loadManualOptions = useCallback(async (query: string): Promise<BatchPlanCard[]> => {
    const params = new URLSearchParams({
      collectionId,
      limit: '20',
    });
    if (query.trim()) params.set('search', query.trim());

    const res = await api<{ entries: Array<{ id: string; name: string; assignee: { firstName: string; lastName: string } | null }> }>(
      `/cards?${params.toString()}`,
    );

    return res.entries.map((card) => ({
      id: card.id,
      name: card.name,
      subtitle: card.assignee
        ? `${card.assignee.firstName} ${card.assignee.lastName}`.trim()
        : 'Unassigned',
    }));
  }, [collectionId]);

  async function handleSaveConfig() {
    setSaving(true);
    try {
      const config: AgentBatchConfig = {
        agentId: agentId || null,
        prompt: prompt || null,
        maxParallel,
        cardFilters: {
          ...(textFilter.trim() ? { search: textFilter.trim() } : {}),
          ...(tagFilter ? { tagId: tagFilter } : {}),
        },
      };
      await api(`/collections/${collectionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ agentBatchConfig: config }),
      });
      toast.success('Batch config saved');
      onConfigSaved?.(config);
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to save config');
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit() {
    if (!agentId || submitting) return;
    if (scopeMode === 'manual' && manualCardCount === 0) {
      toast.error('Add at least one card');
      return;
    }

    setSubmitting(true);
    setResult(null);

    try {
      const cardFilters = {
        ...(textFilter.trim() ? { search: textFilter.trim() } : {}),
        ...(tagFilter ? { tagId: tagFilter } : {}),
      };
      const res = await api<BatchResult>(`/collections/${collectionId}/agent-batch`, {
        method: 'POST',
        body: JSON.stringify({
          agentId,
          prompt: prompt.trim(),
          maxParallel,
          cardIds: scopeMode === 'manual' ? manualLayers.flatMap((l) => l.cards.map((c) => c.id)) : undefined,
          cardFilters: scopeMode === 'filters' ? cardFilters : undefined,
          stages: configuredStages.length > 0 ? configuredStages : undefined,
        }),
      });
      setResult(res);
      if (res.total === 0) {
        toast.info('No cards found matching filters');
      } else {
        toast.success(`Batch run started — ${res.total} card${res.total !== 1 ? 's' : ''} queued`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start batch run');
    } finally {
      setSubmitting(false);
    }
  }

  const selectedAgent = agents.find((a) => a.id === agentId);
  const disabledReason = submitting
    ? 'Batch run is starting…'
    : !agentId
      ? 'Select an agent first'
      : scopeMode === 'manual' && manualCardCount === 0
        ? 'Add at least one card'
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
            <div className={styles.tagChips}>
              <button
                type="button"
                className={`${styles.tagChip} ${scopeMode === 'filters' ? styles.tagChipSelected : ''}`}
                onClick={() => setScopeMode('filters')}
              >
                Filtered set
              </button>
              <button
                type="button"
                className={`${styles.tagChip} ${scopeMode === 'manual' ? styles.tagChipSelected : ''}`}
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
              {/* Card Filter */}
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

              {/* Tag Filter */}
              {tags.length > 0 && (
                <div className={styles.section}>
                  <div className={styles.sectionHeader}>
                    <Tag size={14} className={styles.sectionIcon} />
                    <span className={styles.sectionLabel}>Tag filter</span>
                    {tagFilter && (
                      <button
                        className={styles.toggleAllBtn}
                        onClick={() => setTagFilter('')}
                        type="button"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <div className={styles.tagChips}>
                    {tags.map((tag) => {
                      const selected = tagFilter === tag.id;
                      return (
                        <button
                          key={tag.id}
                          className={`${styles.tagChip} ${selected ? styles.tagChipSelected : ''}`}
                          onClick={() => setTagFilter(selected ? '' : tag.id)}
                          type="button"
                        >
                          <span
                            className={styles.tagDot}
                            style={{ background: tag.color }}
                          />
                          {tag.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
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
                searchPlaceholder="Search collection cards..."
                emptySearchLabel="No matching collection cards"
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
            {scopeMode === 'manual' && manualCardCount > 0 && (
              <span className={styles.footerCount}>
                {configuredStages.length > 1
                  ? `${configuredStages.length} layers`
                  : `${manualCardCount} card${manualCardCount !== 1 ? 's' : ''}`}
              </span>
            )}
          </div>
          <div className={styles.footerActions}>
            {scopeMode === 'filters' && (
              <Tooltip label="Save current settings as default" position="top">
                <button
                  className={styles.saveConfigBtn}
                  onClick={() => void handleSaveConfig()}
                  disabled={saving}
                  type="button"
                >
                  <Save size={14} />
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </Tooltip>
            )}
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
                {previewCount !== null && previewCount > 0
                  ? `Run on ${previewCount} card${previewCount !== 1 ? 's' : ''}`
                  : 'Run batch'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
