if (path === '/nft/sync' && request.method === 'POST') {
  let body;

  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }

  const telegramId = String(body?.telegram_id ?? '').trim();
  const key = String(body?.key ?? '').trim().toUpperCase();
  const items = body?.items ?? body?.nfts;

  if (!telegramId || !key) {
    return json({
      ok: false,
      error: 'telegram_id and key are required'
    }, 400);
  }

  if (!Array.isArray(items) || items.length > 500) {
    return json({
      ok: false,
      error: 'items must be an array of at most 500 items'
    }, 400);
  }

  const license = await sql`
    SELECT license_key
    FROM licenses
    WHERE license_key = ${key}
      AND account_id = ${telegramId}
      AND revoked = FALSE
    LIMIT 1
  `;

  if (!license.length) {
    return json({
      ok: false,
      error: 'license not found for this account'
    }, 403);
  }

  await sql`
    CREATE TABLE IF NOT EXISTS global_nft_items (
      owner_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_id, item_key)
    )
  `;

  let synced = 0;

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;

    const itemKey = String(
      item.key ?? item.dialog_id ?? item.slug ?? ''
    ).trim();

    if (!itemKey) continue;

    await sql`
      INSERT INTO global_nft_items
        (owner_id, item_key, payload, updated_at)
      VALUES (
        ${telegramId},
        ${itemKey},
        ${sql.json(item)},
        NOW()
      )
      ON CONFLICT (owner_id, item_key)
      DO UPDATE SET
        payload = EXCLUDED.payload,
        updated_at = NOW()
    `;

    synced++;
  }

  return json({
    ok: true,
    success: true,
    synced,
    count: synced
  });
}

if (path === '/nft/lookup' && request.method === 'POST') {
  let body;

  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }

  const telegramId = String(body?.telegram_id ?? '').trim();
  const key = String(body?.key ?? '').trim().toUpperCase();
  const targets = Array.isArray(body?.targets)
    ? body.targets.map(String)
    : [];

  if (!telegramId || !key) {
    return json({
      ok: false,
      error: 'telegram_id and key are required'
    }, 400);
  }

  const license = await sql`
    SELECT license_key
    FROM licenses
    WHERE license_key = ${key}
      AND account_id = ${telegramId}
      AND revoked = FALSE
    LIMIT 1
  `;

  if (!license.length) {
    return json({
      ok: false,
      error: 'license not found for this account'
    }, 403);
  }

  await sql`
    CREATE TABLE IF NOT EXISTS global_nft_items (
      owner_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_id, item_key)
    )
  `;

  const users = {};

  for (const target of targets.slice(0, 50)) {
    const rows = await sql`
      SELECT payload
      FROM global_nft_items
      WHERE owner_id = ${target}
      ORDER BY updated_at DESC
      LIMIT 500
    `;

    users[target] = rows.map(row => row.payload);
  }

  return json({
    ok: true,
    success: true,
    users
  });
}
