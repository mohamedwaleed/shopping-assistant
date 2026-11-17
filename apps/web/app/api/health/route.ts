// SPDX-License-Identifier: AGPL-3.0-or-later
import { getDb } from "@/lib/core";

export async function GET(): Promise<Response> {
  try {
    await getDb().raw("select 1");
    return Response.json({ status: "ok", database: "up" });
  } catch {
    return Response.json(
      { status: "degraded", database: "down" },
      { status: 503 },
    );
  }
}
