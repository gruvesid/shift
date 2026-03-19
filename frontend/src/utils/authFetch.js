/**
 * Drop-in replacement for fetch() that automatically adds the JWT
 * Authorization header from localStorage.
 */
const TOKEN_KEY = 'sf2d_token';

export function authFetch(url, options = {}) {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers = {
    ...(options.headers || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  return fetch(url, { ...options, headers });
}
