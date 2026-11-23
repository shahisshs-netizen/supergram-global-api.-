import postgres from "postgres";

function reply(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" }
  });
}

function authorized(request, env) {
  return Boolean(
    env.API_SECRET &&
    request.headers.get("X-API-Secret") === env.API_SECRET
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!env.HYPERDRIVE?.connectionString) {
      return reply({
        ok: false,
        error: "HYPERDRIVE_NOT_CONFIGURED"
      }, 500);
    }

    const db = postgres(env.HYPERDRIVE.connectionString, {
      max: 1,
      fetch_types: false,
      prepare: false
    });

    try {
      await db`
        CREATE TABLE IF NOT EXISTS global_nfts (
          nft_key TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          owner_id TEXT NOT NULL DEFAULT '',
          serial_number BIGINT,
          comment TEXT NOT NULL DEFAULT '',
          nft_date TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;

      await db`
        CREATE TABLE IF NOT EXISTS global_bans (
          account_id TEXT PRIMARY KEY,
          reason TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;

      if (path === "/" || path === "/health") {
        await db`SELECT 1`;
        return reply({
          ok: true,
          service: "supergram-global-api",
          database: "connected"
        });
      }

      if (path === "/nft" && request.method === "GET") {
        const nfts = await db`
          SELECT nft_key, title, owner_id, serial_number,
                 comment, nft_date, updated_at
          FROM global_nfts
          ORDER BY updated_at DESC
          LIMIT 1000
        `;
        return reply({ ok: true, nfts });
      }

      if (path === "/nft/sync" && request.method === "POST") {
        if (!authorized(request, env)) {
          return reply({
            ok: false,
            error: "UNAUTHORIZED"
          }, 401);
        }

        const body = await request.json().catch(() => null);

        if (!body || !Array.isArray(body.nfts)) {
          return reply({
            ok: false,
            error: "NFTS_ARRAY_REQUIRED"
          }, 400);
        }

        let stored = 0;

        for (const nft of body.nfts.slice(0, 1000)) {
          if (!nft || !String(nft.nft_key || "")) continue;

          const serial = nft.serial_number == null
            ? null
            : Number(nft.serial_number);

          if (serial !== null && !Number.isSafeInteger(serial)) {
            continue;
          }

          await db`
            INSERT INTO global_nfts (
              nft_key, title, owner_id, serial_number,
              comment, nft_date, updated_at
            )
            VALUES (
              ${String(nft.nft_key)},
              ${String(nft.title || "")},
              ${String(nft.owner_id || "")},
              ${serial},
              ${String(nft.comment || "")},
              ${String(nft.nft_date || "")},
              NOW()
            )
            ON CONFLICT (nft_key) DO UPDATE SET
              title = EXCLUDED.title,
              owner_id = EXCLUDED.owner_id,
              serial_number = EXCLUDED.serial_number,
              comment = EXCLUDED.comment,
              nft_date = EXCLUDED.nft_date,
              updated_at = NOW()
          `;

          stored++;
        }

        return reply({ ok: true, stored });
      }

      if (path === "/ban/check" && request.method === "GET") {
        const id = url.searchParams.get("account_id");

        if (!id) {
          return reply({
            ok: false,
            error: "ACCOUNT_ID_REQUIRED"
          }, 400);
        }

        const rows = await db`
          SELECT account_id, reason, created_at
          FROM global_bans
          WHERE account_id = ${id}
          LIMIT 1
        `;

        return reply({
          ok: true,
          banned: rows.length > 0,
          ban: rows[0] || null
        });
      }

      if (path === "/ban" && request.method === "POST") {
        if (!authorized(request, env)) {
          return reply({
            ok: false,
            error: "UNAUTHORIZED"
          }, 401);
        }

        const body = await request.json().catch(() => null);
        const id = String(body?.account_id || "");

        if (!id) {
          return reply({
            ok: false,
            error: "ACCOUNT_ID_REQUIRED"
          }, 400);
        }

        const reason = String(body?.reason || "").slice(0, 500);

        const rows = await db`
          INSERT INTO global_bans (account_id, reason)
          VALUES (${id}, ${reason})
          ON CONFLICT (account_id) DO UPDATE SET
            reason = EXCLUDED.reason,
            created_at = NOW()
          RETURNING account_id, reason, created_at
        `;

        return reply({ ok: true, ban: rows[0] });
      }

      if (path === "/ban" && request.method === "DELETE") {
        if (!authorized(request, env)) {
          return reply({
            ok: false,
            error: "UNAUTHORIZED"
          }, 401);
        }

        const id = url.searchParams.get("account_id");

        if (!id) {
          return reply({
            ok: false,
            error: "ACCOUNT_ID_REQUIRED"
          }, 400);
        }

        const rows = await db`
          DELETE FROM global_bans
          WHERE account_id = ${id}
          RETURNING account_id
        `;

        return reply({
          ok: true,
          removed: rows.length > 0
        });
      }

      return reply({
        ok: false,
        error: "NOT_FOUND"
      }, 404);

    } catch (error) {
      return reply({
        ok: false,
        error: "INTERNAL_ERROR",
        detail: String(error?.message || error).slice(0, 200)
      }, 500);
    } finally {
      await db.end({ timeout: 1 }).catch(() => {});
    }
  }
};
