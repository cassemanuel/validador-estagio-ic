/**
 * Persistência da preferência de tema (light/dark) em localStorage,
 * com fallback em memória quando o storage está indisponível.
 */

const STORAGE_KEY = 'validador-estagio-theme';
let memoriaFallback = null;

function storageGet() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return memoriaFallback;
  }
}

function storageSet(value) {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    memoriaFallback = value;
  }
}

/**
 * Carrega a preferência de tema salva. Padrão: 'light'.
 * @returns {'light' | 'dark'}
 */
export function loadThemePreference() {
  const stored = storageGet();
  return stored === 'dark' || stored === 'light' ? stored : 'light';
}

/**
 * Persiste a preferência de tema.
 * @param {'light' | 'dark'} theme
 */
export function saveThemePreference(theme) {
  storageSet(theme);
}
