// Same-origin by default (the backend serves this app). The Vite dev/preview
// servers run on other ports, so they talk to the backend on :8000.
const DEV_PORTS = new Set(['5173', '4173']);
const defaultBase = DEV_PORTS.has(window.location.port) ? 'http://127.0.0.1:8000' : '';
const API_BASE = (import.meta.env.VITE_API_BASE_URL || defaultBase).replace(/\/$/, '');
async function request(path, init) {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined) {
        headers.set('Content-Type', 'application/json');
    }
    const response = await fetch(`${API_BASE}${path}`, {
        ...init,
        headers,
    });
    if (!response.ok) {
        let message = `${response.status} ${response.statusText}`;
        try {
            const body = await response.json();
            message = body.detail || message;
        }
        catch {
            // Preserve the HTTP status when an error body is not JSON.
        }
        throw new Error(message);
    }
    return response.json();
}
export const api = {
    topology: () => request('/topology'),
    metrics: () => request('/metrics'),
    events: () => request('/events?since=0&limit=1000'),
    start: () => request('/simulation/start', { method: 'POST' }),
    startWith: (payload) => request('/simulation/start', {
        method: 'POST', body: JSON.stringify(payload),
    }),
    pause: () => request('/simulation/pause', { method: 'POST' }),
    reset: () => request('/simulation/reset', { method: 'POST' }),
    normalTraffic: (payload) => request('/traffic/normal', {
        method: 'POST',
        body: JSON.stringify(payload),
    }),
    emergencyTraffic: (payload) => request('/traffic/emergency', {
        method: 'POST',
        body: JSON.stringify(payload),
    }),
    failNode: (id) => request(`/nodes/${encodeURIComponent(id)}/fail`, { method: 'POST' }),
    recoverNode: (id) => request(`/nodes/${encodeURIComponent(id)}/recover`, { method: 'POST' }),
    failLink: (id) => request(`/links/${encodeURIComponent(id)}/fail`, { method: 'POST' }),
    recoverLink: (id) => request(`/links/${encodeURIComponent(id)}/recover`, { method: 'POST' }),
    createNode: (payload) => request('/nodes', {
        method: 'POST', body: JSON.stringify(payload),
    }),
    updateNode: (id, payload) => (request(`/nodes/${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify(payload),
    })),
    deleteNode: (id) => request(`/nodes/${encodeURIComponent(id)}`, {
        method: 'DELETE',
    }),
    createLink: (payload) => request('/links', {
        method: 'POST', body: JSON.stringify(payload),
    }),
    updateLink: (id, payload) => (request(`/links/${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify(payload),
    })),
    deleteLink: (id) => request(`/links/${encodeURIComponent(id)}`, {
        method: 'DELETE',
    }),
    triggerDisaster: (payload) => request('/disasters/trigger', {
        method: 'POST', body: JSON.stringify(payload),
    }),
};
