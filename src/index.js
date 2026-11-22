
import postgres from "postgres";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Secret",
  "Content-Type": "application/json; charset=utf-8"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: cors });
}

function authorized(request, env) {
  return Boolean(env.API_SECRET) &&
    request.headers.get("X-API-Secret") === env.API_SECRET;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (!env.HYPERDRIVE?.connectionString) {
      return json({ ok: false, error: "Hyperdrive is not configured" }, 500);
    }

    const url = new URL(request.url);
    const path = url.pathname;
    let sql;

    try {
      sql = postgres(env.HYPERDRIVE.connectionString, {
        max: 1,
        fetch_types: false,
        prepare: false
      });

      await sql`
        CREATE TABLE IF NOT EXISTS global_nfts (
          id BIGSERIAL PRIMARY KEY,
          nft_key TEXT UNIQUE NOT NULL,
          title TEXT NOT NULL,
          owner_id TEXT NOT NULL DEFAULT '',
          serial_number BIGINT,
          comment TEXT NOT NULL DEFAULT '',
          nft_date TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS global_bans (
          account_id TEXT PRIMARY KEY,
          reason TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;

      if (path === "/" || path === "/health") {
        await sql`SELECT 1`;
        return json({
          ok: true,
          service: "SuperGram API",
          database: "connected"
        });
      }

      if (path === "/nft" && request.method === "GET") {
        const nfts = await sql`
          SELECT nft_key, title, owner_id, serial_number,
                 comment, nft_date, updated_at
          FROM global_nfts
          ORDER BY id DESC
          LIMIT 1000
        `;
        return json({ ok: true, nfts });
      }

      if (path === "/nft/sync" && request.method === "POST") {
        if (!authorized(request, env)) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }

        const body = await request.json();

        if (!Array.isArray(body.nfts) || body.nfts.length > 500) {
          return json({ ok: false, error: "nfts must be an array of up to 500 items" }, 400);
        }

        let synced = 0;

        for (const nft of body.nfts) {
          if (!nft?.nft_key || !nft?.title) continue;

          const serial = nft.serial_number == null
            ? null
            : Number(nft.serial_number);

          if (serial !== null && !Number.isSafeInteger(serial)) {
            return json({ ok: false, error: "Invalid serial_number" }, 400);
          }

          await sql`
            INSERT INTO global_nfts
              (nft_key, title, owner_id, serial_number, comment, nft_date, updated_at)
            VALUES (
              ${String(nft.nft_key)},
              ${String(nft.title)},
              ${String(nft.owner_id ?? "")},
              ${serial},
              ${String(nft.comment ?? "")},
              ${String(nft.nft_date ?? "")},
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

          synced++;
        }

        return json({ ok: true, synced });
      }

      if (path === "/ban/check" && request.method === "GET") {
        const account = url.searchParams.get("account_id");
        if (!account) {
          return json({ ok: false, error: "account_id required" }, 400);
        }

        const rows = await sql`
          SELECT reason, created_at
          FROM global_bans
          WHERE account_id = ${account}
        `;

        return json({
          ok: true,
          banned: rows.length > 0,
          ban: rows[0] ?? null
        });
      }

      if (path === "/ban" && request.method === "POST") {
        if (!authorized(request, env)) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }

        const body = await request.json();
        if (!body.account_id) {
          return json({ ok: false, error: "account_id required" }, 400);
        }

        await sql`
          INSERT INTO global_bans (account_id, reason)
          VALUES (${String(body.account_id)}, ${String(body.reason ?? "")})
          ON CONFLICT (account_id) DO UPDATE
          SET reason = EXCLUDED.reason
        `;

        return json({ ok: true });
      }

      if (path === "/ban" && request.method === "DELETE") {
        if (!authorized(request, env)) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }

        const account = url.searchParams.get("account_id");
        if (!account) {
          return json({ ok: false, error: "account_id required" }, 400);
        }

        await sql`
          DELETE FROM global_bans WHERE account_id = ${account}
        `;

        return json({ ok: true });
      }

      return json({ ok: false, error: "Not found" }, 404);
    } catch (error) {
      console.error("SuperGram API error:", error);
      return json({ ok: false, error: "Internal server error" }, 500);
    } finally {
      if (sql) {
        try {
          await sql.end({ timeout: 2 });
        } catch (error) {
          console.error("Database close error:", error);
        }
      }
    }
  }
};
