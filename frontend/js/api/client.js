/**
 * Cliente HTTP da API (mesmo host; sessão via cookie httpOnly).
 */

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class AuthError extends ApiError {
  constructor(message = 'Sessão expirada.') {
    super(message, 401);
  }
}

/**
 * @param {string} path
 * @param {{method?: string, body?: object, form?: FormData}} [opts]
 * @returns {Promise<any>}
 */
export async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {} };
  if (form) {
    opts.body = form; // multipart: o browser define o boundary
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  const resp = await fetch(path, opts);

  let data = null;
  const text = await resp.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (resp.status === 401) {
    const detail = data?.detail;
    throw new AuthError(
      typeof detail === 'string' ? detail : 'Sessão expirada.'
    );
  }

  if (!resp.ok) {
    const detail = data?.detail;
    throw new ApiError(
      typeof detail === 'string' ? detail : `Erro ${resp.status}`,
      resp.status
    );
  }
  return data;
}
