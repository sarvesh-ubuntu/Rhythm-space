export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      console.error('rhythm-space worker error', err);
      return json({ error: err?.message || 'Internal server error' }, 500);
    }
  }
};

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (!url.pathname.startsWith('/api/sheets')) {
    return env.ASSETS.fetch(request);
  }

  const userId = request.headers.get('X-Rym-User-Id');
  if (!userId) {
    return json({ error: 'Missing user id' }, 401);
  }

  if (!env.DB) {
    return json({ error: 'Sheet storage is not configured' }, 503);
  }

  await ensureSchema(env.DB);

  // OMR Proxy Routes
  if (url.pathname === '/api/sheets/omr/predict' && request.method === 'POST') {
    const hfSpaceUrl = 'https://YOUR_HF_USERNAME-YOUR_SPACE_NAME.hf.space/predict';
    try {
      const hfResponse = await fetch(hfSpaceUrl, {
        method: 'POST',
        body: request.body,
        headers: { 'Accept': 'application/json' }
      });
      if (!hfResponse.ok) return json({ error: `OMR Server Error: ${await hfResponse.text()}` }, hfResponse.status);
      return new Response(await hfResponse.text(), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    } catch (err) {
      return json({ error: `Failed to contact OMR backend: ${err.message}` }, 502);
    }
  }

  if (url.pathname.startsWith('/api/sheets/omr/status/') && request.method === 'GET') {
    const taskId = url.pathname.split('/').pop();
    const hfSpaceUrl = `https://YOUR_HF_USERNAME-YOUR_SPACE_NAME.hf.space/status/${taskId}`;
    try {
      const hfResponse = await fetch(hfSpaceUrl);
      if (!hfResponse.ok) return json({ error: `OMR Server Error: ${await hfResponse.text()}` }, hfResponse.status);
      return new Response(await hfResponse.text(), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    } catch (err) {
      return json({ error: `Failed to contact OMR backend: ${err.message}` }, 502);
    }
  }

  const sheetId = url.pathname.split('/').filter(Boolean)[2] || '';

  if (request.method === 'GET' && !sheetId) {
    const { results } = await env.DB.prepare(
      'SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM sheets WHERE user_id = ? ORDER BY updated_at DESC'
    ).bind(userId).all();

    return json(results.map(row => ({
      id: row.id,
      title: row.title,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    })));
  }

  if (request.method === 'GET' && sheetId) {
    const row = await env.DB.prepare(
      'SELECT id, title, data, created_at AS createdAt, updated_at AS updatedAt FROM sheets WHERE id = ? AND user_id = ?'
    ).bind(sheetId, userId).first();

    if (!row) return json({ error: 'Not found' }, 404);
    return json({
      id: row.id,
      title: row.title,
      data: JSON.parse(row.data),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    });
  }

  if (request.method === 'POST') {
    const body = await request.json();
    const sheet = normalizeSheet(body);
    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      'INSERT INTO sheets (id, user_id, title, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(id, userId, sheet.title, JSON.stringify(sheet.data), now, now).run();
    return json({ id, title: sheet.title, data: sheet.data, createdAt: now, updatedAt: now }, 201);
  }

  if (request.method === 'PUT' && sheetId) {
    const body = await request.json();
    const sheet = normalizeSheet(body);
    const now = Date.now();
    const result = await env.DB.prepare(
      'UPDATE sheets SET title = ?, data = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    ).bind(sheet.title, JSON.stringify(sheet.data), now, sheetId, userId).run();
    if (result.meta?.changes === 0) {
      return json({ error: 'Not found' }, 404);
    }
    return json({ id: sheetId, title: sheet.title, data: sheet.data, updatedAt: now });
  }

  if (request.method === 'DELETE' && sheetId) {
    await env.DB.prepare('DELETE FROM sheets WHERE id = ? AND user_id = ?').bind(sheetId, userId).run();
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
}

async function ensureSchema(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS sheets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `).run();

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_sheets_user_updated
      ON sheets(user_id, updated_at DESC)
  `).run();
}

function normalizeSheet(body) {
  if (!body || typeof body !== 'object') {
    return { title: 'Untitled composition', data: {} };
  }

  return {
    title: String(body.title || 'Untitled composition').trim().slice(0, 120) || 'Untitled composition',
    data: body.data && typeof body.data === 'object' ? body.data : {}
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}
