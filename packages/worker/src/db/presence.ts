/** Who is editing a page right now: open editors say so every BEAT_SECONDS. */
export const BEAT_SECONDS = 20;
const FRESH_SECONDS = 60;

export async function beat(db: D1Database, artifactId: string, user: { userId: string; name: string }): Promise<void> {
  await db
    .prepare("insert into presence (artifact_id, user_id, name, at) values (?, ?, ?, ?) on conflict (artifact_id, user_id) do update set name = excluded.name, at = excluded.at")
    .bind(artifactId, user.userId, user.name, new Date().toISOString())
    .run();
}

export async function leave(db: D1Database, artifactId: string, userId: string): Promise<void> {
  await db.prepare("delete from presence where artifact_id = ? and user_id = ?").bind(artifactId, userId).run();
}

/** The names of the others editing a page now. */
export async function editing(db: D1Database, artifactId: string, except: string): Promise<string[]> {
  const since = new Date(Date.now() - FRESH_SECONDS * 1000).toISOString();
  const { results } = await db
    .prepare("select name from presence where artifact_id = ? and user_id != ? and at > ? order by name")
    .bind(artifactId, except, since)
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

export function presenceCleanup(db: D1Database, now: Date): D1PreparedStatement {
  return db.prepare("delete from presence where at <= ?").bind(new Date(now.getTime() - 864e5).toISOString());
}
