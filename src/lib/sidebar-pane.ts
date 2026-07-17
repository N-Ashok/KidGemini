// Sidebar collapse policy — framework-free so it's unit-testable (repo pattern:
// no @testing-library; logic lives here, components stay presentational).
// Desktop-only icon rail (mobile's drawer is already collapsible via open/close).

const COLLAPSED_KEY = "kidgemini:sidebar-collapsed:v1";

export function saveSidebarCollapsed(storage: Storage, collapsed: boolean): void {
  try {
    storage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    /* quota/private mode — toggle still works this session */
  }
}

export function loadSidebarCollapsed(storage: Storage): boolean {
  try {
    return storage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}
