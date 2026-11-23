stgres';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  }
});

function checkSecret(request, env) {
  const expected = env.API_SECRET || env.ADMIN_SECRET;
  const actual = request.headers.get('X-API-Secret')
    || request.headers.get('X-Admin-Secret') || '';
  return Boolean(expected && actual && expected === actual);
}

function createKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0'))
    .join('').toUpperCase();
  return `SGM-${hex.slice(0, 8)}-${hex.slice(8, 16)}-${hex.slice(16, 24)}`;
}

function connect(env) {
  if (!env.HYPERDRIVE?.connectionString) {
    throw new Error('HYPERDRIVE_NOT_CONFIGURED');
  }
  return postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 20
  });
}

async function setup(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS licenses (
      id BIGSERIAL PRIMARY KEY,
      license_key TEXT UNIQUE NOT NULL,
      account_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      activated_at TIMESTAMPTZ,
      revoked BOOLEAN NOT NULL DEFAULT FALSE
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS global_nfts (
      nft_key TEXT PRIMARY KEY,
      title TEXT,
      owner_id TEXT,
      serial_number TEXT,
      comment TEXT,
      nft_date TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS global_nft_items (
      owner_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_id, item_key)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS global_bans (
      account_id TEXT PRIMARY KEY,
      reason TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

async function validateLicense(sql, key, account) {
  if (!key || !account) return false;

  const rows = await sql`
    SELECT license_key
    FROM licenses
    WHERE license_key = ${key}
      AND account_id = ${account}
      AND revoked = FALSE
    LIMIT 1
  `;

  return rows.length > 0;
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers':
          'Content-Type,X-API-Secret,X-Admin-Secret'
      }
    });
  }

  let sql;

  try {
    sql = connect(env);
    await setup(sql);

    if (path === '/health' && request.method === 'GET') {
      await sql`SELECT 1`;
      return json({
        ok: true,
        service: 'supergram-global-api',
        database: 'connected'
      });
    }

    if (path === '/admin/generate' && request.method === 'POST') {
      if (!checkSecret(request, env)) {
        return json({ ok: false, error: 'invalid admin secret' }, 401);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: 'invalid JSON' }, 400);
      }

      const amount = Number(body?.amount ?? 1);

      if (!Number.isInteger(amount) || amount < 1 || amount > 100) {
        return json({
          ok: false,
          error: 'amount must be from 1 to 100'
        }, 400);
      }

      const keys = [];

      for (let i = 0; i < amount; i++) {
        let saved = false;

        for (let attempt = 0; attempt < 5 && !saved; attempt++) {
          const key = createKey();
          const result = await sql`
            INSERT INTO licenses (license_key)
            VALUES (${key})
            ON CONFLICT (license_key) DO NOTHING
            RETURNING license_key
          `;

          if (result.length) {
            keys.push(key);
            saved = true;
          }
        }

        if (!saved) {
          return json({ ok: false, error: 'key generation failed' }, 500);
        }
      }

      return json({ ok: true, amount: keys.length, key: keys[0], keys });
    }

    if (path === '/activate' && request.method === 'POST') {
      let body;

      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: 'invalid JSON' }, 400);
      }

      const key = String(
        body?.key ?? body?.license_key ?? ''
      ).trim().toUpperCase();

      const account = String(
        body?.account_id ??
        body?.my_id ??
        body?.telegram_id ??
        body?.user_id ??
        ''
      ).trim();

      if (!key || !account) {
        return json({
          ok: false,
          error: 'key and account_id are required'
        }, 400);
      }

      const result = await sql`
        UPDATE licenses
        SET account_id = COALESCE(account_id, ${account}),
            activated_at = COALESCE(activated_at, NOW())
        WHERE license_key = ${key}
          AND revoked = FALSE
          AND (account_id IS NULL OR account_id = ${account})
        RETURNING license_key, account_id, activated_at
      `;

      if (!result.length) {
        const existing = await sql`
          SELECT account_id, revoked
          FROM licenses
          WHERE license_key = ${key}
        `;

        if (!existing.length) {
          return json({ ok: false, error: 'invalid key' }, 404);
        }

        if (existing[0].revoked) {
          return json({ ok: false, error: 'key revoked' }, 403);
        }

        return json({
          ok: false,
          error: 'key already bound to another account'
        }, 409);
      }

      return json({
        ok: true,
        activated: true,
        key,
        account_id: account,
        my_id: account
      });
    }

    if (path === '/admin/licenses' && request.method === 'GET') {
      if (!checkSecret(request, env)) {
        return json({ ok: false, error: 'invalid admin secret' }, 401);
      }

      const limit = Math.min(
        100,
        Math.max(1, Number(url.searchParams.get('limit') || 50))
      );

      const rows = await sql`
        SELECT license_key, account_id, created_at, activated_at, revoked
        FROM licenses
        ORDER BY id DESC
        LIMIT ${limit}
      `;

      return json({ ok: true, licenses: rows });
    }

    if (path === '/admin/revoke' && request.method === 'POST') {
      if (!checkSecret(request, env)) {
        return json({ ok: false, error: 'invalid admin secret' }, 401);
      }

      let body;

      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: 'invalid JSON' }, 400);
      }

      const key = String(
        body?.key ?? body?.license_key ?? ''
      ).trim().toUpperCase();

      if (!key) {
        return json({ ok: false, error: 'key is required' }, 400);
      }

      const rows = await sql`
        UPDATE licenses
        SET revoked = TRUE
        WHERE license_key = ${key}
        RETURNING license_key
      `;

      return rows.length
        ? json({ ok: true, key, revoked: true })
        : json({ ok: false, error: 'key not found' }, 404);
    }

    if (path === '/nft' && request.method === 'GET') {
      const owner = url.searchParams.get('owner_id');

      const rows = owner
        ? await sql`
            SELECT *
            FROM global_nfts
            WHERE owner_id = ${owner}
            ORDER BY updated_at DESC
            LIMIT 500
          `
        : await sql`
            SELECT *
            FROM global_nfts
            ORDER BY updated_at DESC
            LIMIT 500
          `;

      return json({ ok: true, nfts: rows });
    }

    if (path === '/nft/sync' && request.method === 'POST') {
      let body;

      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: 'invalid JSON' }, 400);
      }

      const telegramId = String(body?.telegram_id ?? '').trim();
      const key = String(
        body?.key ?? body?.license_key ?? ''
      ).trim().toUpperCase();

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

      if (!(await validateLicense(sql, key, telegramId))) {
        return json({
          ok: false,
          error: 'license not found for this account'
        }, 403);
      }

      let synced = 0;

      for (const item of items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          continue;
        }

        const itemKey = String(
          item.key ??
          item.dialog_id ??
          item.slug ??
          item.nft_key ??
          ''
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

        const title = String(item.title ?? item.name ?? 'NFT').slice(0, 200);
        const slug = String(item.slug ?? itemKey).slice(0, 200);

        await sql`
          INSERT INTO global_nfts
            (nft_key, title, owner_id, serial_number, comment, nft_date, updated_at)
          VALUES (
            ${telegramId + ':' + itemKey},
            ${title},
            ${telegramId},
            ${slug},
            ${String(item.message ?? '').slice(0, 1000)},
            ${String(item.date ?? item.ts ?? '')},
            NOW()
          )
          ON CONFLICT (nft_key)
          DO UPDATE SET
            title = EXCLUDED.title,
            owner_id = EXCLUDED.owner_id,
            serial_number = EXCLUDED.serial_number,
            comment = EXCLUDED.comment,
            nft_date = EXCLUDED.nft_date,
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

    if (path === '/nft/lookup' &&
        (request.method === 'POST' || request.method === 'GET')) {
      let body = {};

      if (request.method === 'POST') {
        try {
          body = await request.json();
        } catch {
          return json({ ok: false, error: 'invalid JSON' }, 400);
        }
      }

      const telegramId = String(
        body?.telegram_id ??
        url.searchParams.get('telegram_id') ??
        ''
      ).trim();

      const key = String(
        body?.key ?? body?.license_key ?? ''
      ).trim().toUpperCase();

      if (!telegramId || !key) {
        return json({
          ok: false,
          error: 'telegram_id and key are required'
        }, 400);
      }

      if (!(await validateLicense(sql, key, telegramId))) {
        return json({
          ok: false,
          error: 'license not found for this account'
        }, 403);
      }

      const target = String(
        body?.target_id ??
        body?.owner_id ??
        (Array.isArray(body?.targets) ? body.targets[0] : '') ??
        url.searchParams.get('owner_id') ??
        telegramId
      ).trim();

      const rows = await sql`
        SELECT payload
        FROM global_nft_items
        WHERE owner_id = ${target}
        ORDER BY updated_at DESC
        LIMIT 500
      `;

      const items = rows.map(row => row.payload);

      return json({
        ok: true,
        success: true,
        items,
        nfts: items,
        users: { [target]: items }
      });
    }

    if (path === '/ban/check' && request.method === 'GET') {
      const account = String(
        url.searchParams.get('account_id') || ''
      ).trim();

      if (!account) {
        return json({ ok: false, error: 'account_id is required' }, 400);
      }

      const rows = await sql`
        SELECT account_id, reason, created_at
        FROM global_bans
        WHERE account_id = ${account}
        LIMIT 1
      `;

      return json({
        ok: true,
        banned: rows.length > 0,
        ban: rows[0] ?? null
      });
    }

    if (path === '/ban' && request.method === 'POST') {
      if (!checkSecret(request, env)) {
        return json({ ok: false, error: 'invalid API secret' }, 401);
      }

      let body;

      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: 'invalid JSON' }, 400);
      }

      const account = String(body?.account_id ?? '').trim();

      if (!account) {
        return json({ ok: false, error: 'account_id is required' }, 400);
      }

      await sql`
        INSERT INTO global_bans (account_id, reason)
        VALUES (${account}, ${String(body?.reason ?? '')})
        ON CONFLICT (account_id)
        DO UPDATE SET
          reason = EXCLUDED.reason,
          created_at = NOW()
      `;

      return json({ ok: true, account_id: account, banned: true });
    }

    if (path === '/ban' && request.method === 'DELETE') {
      if (!checkSecret(request, env)) {
        return json({ ok: false, error: 'invalid API secret' }, 401);
      }

      const account = String(
        url.searchParams.get('account_id') || ''
      ).trim();

      if (!account) {
        return json({ ok: false, error: 'account_id is required' }, 400);
      }

      const rows = await sql`
        DELETE FROM global_bans
        WHERE account_id = ${account}
        RETURNING account_id
      `;

      return json({
        ok: true,
        account_id: account,
        banned: false,
        removed: rows.length > 0
      });
    }

    return json({ ok: false, error: 'not found' }, 404);

  } catch (error) {
    console.error('API error:', error?.message || error);

    if (String(error?.message || '').includes('HYPERDRIVE_NOT_CONFIGURED')) {
      return json({
        ok: false,
        error: 'HYPERDRIVE_NOT_CONFIGURED'
      }, 500);
    }

    return json({ ok: false, error: 'internal server error' }, 500);

  } finally {
    if (sql) {
      try {
        await sql.end({ timeout: 1 });
      } catch {}
    }
  }
}

export default {
  fetch(request, env) {
    return handle(request, env      
