import { CircuitDocument, ProjectDocument } from './types';

/**
 * Resolve the list of currently open tab circuit IDs.
 * Explicitly distinguishes an empty array `[]` (all tabs closed) from `undefined` (legacy projects).
 */
export function resolveOpenTabIds(
  project: Pick<ProjectDocument, 'openTabIds' | 'circuits'>,
): string[] {
  if (Array.isArray(project.openTabIds)) {
    return project.openTabIds.filter((id) => Boolean(project.circuits[id]));
  }
  return Object.keys(project.circuits).filter((id) => !project.circuits[id]?.isStub);
}

/**
 * Pick the next active circuit ID after closing or removing `closedId`, preferring the most
 * recently visited tab still present in `remainingTabs`. Returns `''` when no tabs remain open.
 */
export function pickNextActiveTab(
  closedId: string,
  remainingTabs: string[],
  tabHistory: string[],
  circuits: Record<string, CircuitDocument>,
): { activeCircuitId: string; tabHistory: string[] } {
  const nextHistory = tabHistory.filter((id) => id !== closedId);
  if (remainingTabs.length === 0) {
    return { activeCircuitId: '', tabHistory: nextHistory };
  }
  for (let i = nextHistory.length - 1; i >= 0; i--) {
    const cand = nextHistory[i];
    if (cand !== closedId && remainingTabs.includes(cand) && circuits[cand]) {
      return { activeCircuitId: cand, tabHistory: nextHistory };
    }
  }
  const fallback = remainingTabs[remainingTabs.length - 1] ?? '';
  return { activeCircuitId: fallback, tabHistory: nextHistory };
}

/**
 * Purely close a tab without deleting the underlying module definition from `project.circuits`.
 * Allows closing down to 0 open tabs (`openTabIds: []`, `activeCircuitId: ''`).
 */
export function closeCircuitTabState(
  project: ProjectDocument,
  circuitId: string,
  tabHistory: string[],
): { openTabIds: string[]; activeCircuitId: string; tabHistory: string[] } {
  const curTabs = resolveOpenTabIds(project);
  const nextTabs = curTabs.filter((id) => id !== circuitId);

  if (project.activeCircuitId !== circuitId) {
    const stillValid =
      Boolean(project.activeCircuitId) &&
      nextTabs.includes(project.activeCircuitId) &&
      Boolean(project.circuits[project.activeCircuitId]);
    return {
      openTabIds: nextTabs,
      activeCircuitId: stillValid ? project.activeCircuitId : (nextTabs[nextTabs.length - 1] ?? ''),
      tabHistory: tabHistory.filter((id) => id !== circuitId),
    };
  }

  const picked = pickNextActiveTab(circuitId, nextTabs, tabHistory, project.circuits);
  return {
    openTabIds: nextTabs,
    activeCircuitId: picked.activeCircuitId,
    tabHistory: picked.tabHistory,
  };
}
