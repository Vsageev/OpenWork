import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { api } from '../lib/api';
import {
  getActiveWorkspaceId,
  setActiveWorkspaceId,
  clearActiveWorkspaceId,
} from '../lib/navigation-preferences';

export interface Workspace {
  id: string;
  name: string;
  userId: string;
  boardIds: string[];
  collectionIds: string[];
  agentGroupIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceContextValue {
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  activeWorkspaceId: string | null;
  setActiveWorkspace: (id: string | null) => void;
  refetchWorkspaces: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(getActiveWorkspaceId);

  const refetchWorkspaces = useCallback(async () => {
    try {
      const data = await api<{ entries: Workspace[] }>('/workspaces');
      setWorkspaces(data.entries);
    } catch {
      // silently fail
    }
  }, []);

  useEffect(() => {
    refetchWorkspaces();
  }, [refetchWorkspaces]);

  const setActiveWorkspace = useCallback((id: string | null) => {
    setActiveId(id);
    if (id) {
      setActiveWorkspaceId(id);
    } else {
      clearActiveWorkspaceId();
    }
  }, []);

  const activeWorkspace = activeId
    ? workspaces.find((w) => w.id === activeId) ?? null
    : null;

  return (
    <WorkspaceContext.Provider
      value={{
        workspaces,
        activeWorkspace,
        activeWorkspaceId: activeId,
        setActiveWorkspace,
        refetchWorkspaces,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used within WorkspaceProvider');
  return ctx;
}
