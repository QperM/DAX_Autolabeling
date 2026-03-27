const CURRENT_PROJECT_KEY = 'currentProject';
const SELECTED_MODULES_KEY = 'selectedModules';

function getSessionStorageSafe(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function getLocalStorageSafe(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readJsonValue<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function migrateLegacyValue<T>(key: string): T | null {
  const local = getLocalStorageSafe();
  const session = getSessionStorageSafe();
  const legacyValue = readJsonValue<T>(local?.getItem(key) ?? null);
  if (legacyValue && session) {
    session.setItem(key, JSON.stringify(legacyValue));
  }
  if (local) {
    local.removeItem(key);
  }
  return legacyValue;
}

export function getStoredCurrentProject<T = any>(): T | null {
  const session = getSessionStorageSafe();
  const fromSession = readJsonValue<T>(session?.getItem(CURRENT_PROJECT_KEY) ?? null);
  if (fromSession) return fromSession;
  return migrateLegacyValue<T>(CURRENT_PROJECT_KEY);
}

export function setStoredCurrentProject(project: unknown): void {
  const session = getSessionStorageSafe();
  const local = getLocalStorageSafe();
  if (session) {
    session.setItem(CURRENT_PROJECT_KEY, JSON.stringify(project));
  }
  if (local) {
    local.removeItem(CURRENT_PROJECT_KEY);
  }
}

export function clearStoredCurrentProject(): void {
  const session = getSessionStorageSafe();
  const local = getLocalStorageSafe();
  session?.removeItem(CURRENT_PROJECT_KEY);
  local?.removeItem(CURRENT_PROJECT_KEY);
}

export function getStoredSelectedModules(): string[] {
  const session = getSessionStorageSafe();
  const fromSession = readJsonValue<string[]>(session?.getItem(SELECTED_MODULES_KEY) ?? null);
  if (Array.isArray(fromSession)) return fromSession;
  const legacyValue = migrateLegacyValue<string[]>(SELECTED_MODULES_KEY);
  return Array.isArray(legacyValue) ? legacyValue : [];
}

export function setStoredSelectedModules(selectedModules: string[]): void {
  const session = getSessionStorageSafe();
  const local = getLocalStorageSafe();
  if (session) {
    session.setItem(SELECTED_MODULES_KEY, JSON.stringify(selectedModules));
  }
  if (local) {
    local.removeItem(SELECTED_MODULES_KEY);
  }
}

export function clearStoredSelectedModules(): void {
  const session = getSessionStorageSafe();
  const local = getLocalStorageSafe();
  session?.removeItem(SELECTED_MODULES_KEY);
  local?.removeItem(SELECTED_MODULES_KEY);
}

