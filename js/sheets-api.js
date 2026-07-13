'use strict';

window.RymSheets = (() => {
  const API_BASE = '/api/sheets';

  function getUserId() {
    const user = window.RymAuth && window.RymAuth.getCurrentUser();
    return user ? user.uid : '';
  }

  async function request(path = '', options = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    const userId = getUserId();
    if (userId) headers['X-Rym-User-Id'] = userId;

    const res = await fetch(API_BASE + path, {
      ...options,
      headers
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `Request failed (${res.status})`);
    }

    const type = res.headers.get('content-type') || '';
    return type.includes('application/json') ? res.json() : res.text();
  }

  async function listSheets() {
    return request('', { method: 'GET' });
  }

  async function loadSheet(id) {
    return request(`/${encodeURIComponent(id)}`, { method: 'GET' });
  }

  async function saveSheet(sheet) {
    const payload = {
      title: sheet.title || 'Untitled composition',
      data: sheet.data || {}
    };

    if (sheet.id) {
      return request(`/${encodeURIComponent(sheet.id)}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
    }

    return request('', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }

  async function deleteSheet(id) {
    return request(`/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  return {
    listSheets,
    loadSheet,
    saveSheet,
    deleteSheet
  };
})();
