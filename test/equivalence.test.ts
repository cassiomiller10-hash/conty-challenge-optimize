import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { deliveriesSince } from "../src/clock.ts";
import { all, get, openDatabase } from "../src/db.ts";
import { type CreatorMatch, type CreatorPage, listCreators } from "../src/list-creators.ts";
import { CAMPAIGN_ID, seed } from "../src/seed.ts";

// Implementação original (uma consulta por criador e por conta), mantida como referência
// para provar que a versão em lote devolve exatamente a mesma listagem.
async function referenceListCreators(db: DatabaseSync, campaignId: string): Promise<CreatorPage | null> {
  const campaign = await get<{ niches_json: string }>(db, "SELECT * FROM campaigns WHERE id = ?", campaignId);
  if (!campaign) return null;
  const creators = await all<{ id: string; name: string; niches_json: string }>(db, "SELECT * FROM creators");
  const scored: CreatorMatch[] = [];
  for (const creator of creators) {
    let nicheScore = 0;
    for (const campaignNiche of JSON.parse(campaign.niches_json) as string[]) {
      for (const creatorNiche of JSON.parse(creator.niches_json) as string[]) {
        if (campaignNiche === creatorNiche) nicheScore += 1;
      }
    }
    if (nicheScore === 0) continue;
    const accounts = await all<{ id: string }>(db, "SELECT * FROM social_accounts WHERE creator_id = ?", creator.id);
    let latestReach = 0;
    for (const account of accounts) {
      const metric = await get<{ views: number }>(
        db,
        "SELECT * FROM metrics WHERE account_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1",
        account.id,
      );
      if (metric) latestReach += metric.views;
    }
    const deliveries = await get<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM deliveries WHERE creator_id = ? AND delivered_at >= ?",
      creator.id,
      deliveriesSince(),
    );
    scored.push({
      id: creator.id,
      name: creator.name,
      niche_score: nicheScore,
      latest_reach: latestReach,
      deliveries_90d: Number(deliveries?.n ?? 0),
    });
  }
  scored.sort((left, right) => {
    if (right.niche_score !== left.niche_score) return right.niche_score - left.niche_score;
    if (right.latest_reach !== left.latest_reach) return right.latest_reach - left.latest_reach;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return { campaign_id: campaignId, total: scored.length, creators: scored };
}

function mulberry32(seedValue: number): () => number {
  let state = seedValue;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Base cheia de empates: views em poucos valores, captured_at repetido na mesma conta,
// nicho repetido no JSON, criador sem conta, conta sem métrica e entregas em cima do limite de 90 dias.
function seedWithTies(db: DatabaseSync, creators: number, seedValue: number): void {
  const rand = mulberry32(seedValue);
  const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)] as T;
  const niches = ["beleza", "moda", "tech", "games"];
  const capturedAt = ["2026-05-30T00:00:00.000Z", "2026-05-29T00:00:00.000Z"];
  const deliveredAt = ["2026-03-03T12:00:00.000Z", "2026-03-03T11:59:59.999Z", "2026-05-01T00:00:00.000Z"];
  db.exec("BEGIN");
  db.prepare("INSERT INTO campaigns VALUES ('cmp_ties', 'Empates', ?)").run(JSON.stringify(["beleza", "moda", "beleza"]));
  for (let i = 0; i < creators; i += 1) {
    const creatorId = `crt_${String(Math.floor(rand() * creators * 10)).padStart(6, "0")}_${i}`;
    const creatorNiches = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(niches));
    db.prepare("INSERT INTO creators VALUES (?, ?, ?, '')").run(creatorId, `Criador ${i}`, JSON.stringify(creatorNiches));
    const accounts = Math.floor(rand() * 3);
    for (let a = 0; a < accounts; a += 1) {
      const accountId = `acc_${i}_${a}`;
      db.prepare("INSERT INTO social_accounts VALUES (?, ?, 'instagram')").run(accountId, creatorId);
      const metrics = Math.floor(rand() * 4);
      for (let m = 0; m < metrics; m += 1) {
        db.prepare("INSERT INTO metrics VALUES (?, ?, ?, ?, '')").run(
          `met_${Math.floor(rand() * 1_000_000)}_${i}_${a}_${m}`,
          accountId,
          pick([0, 10, 99, 100]),
          pick(capturedAt),
        );
      }
    }
    const deliveries = Math.floor(rand() * 4);
    for (let d = 0; d < deliveries; d += 1) {
      db.prepare("INSERT INTO deliveries VALUES (?, ?, ?)").run(`del_${i}_${d}`, creatorId, pick(deliveredAt));
    }
  }
  db.exec("COMMIT");
}

const PAGES = [
  { limit: 1, offset: 0 },
  { limit: 20, offset: 0 },
  { limit: 20, offset: 19 },
  { limit: 20, offset: 20 },
  { limit: 50, offset: 37 },
  { limit: 20, offset: 100 },
  { limit: 20, offset: 999_999 },
];

async function expectSameListing(db: DatabaseSync, campaignId: string): Promise<void> {
  const reference = await referenceListCreators(db, campaignId);
  expect(reference).not.toBeNull();
  for (const { limit, offset } of PAGES) {
    const page = await listCreators(db, { campaignId, limit, offset });
    expect(page).toEqual({
      campaign_id: campaignId,
      total: reference?.total,
      creators: reference?.creators.slice(offset, offset + limit),
    });
  }
}

describe("listagem igual à implementação original", () => {
  it.each([600, 1200])("no seed com %i criadores", async (creators) => {
    const db = openDatabase(":memory:");
    seed(db, { creators, seed: 7 });
    await expectSameListing(db, CAMPAIGN_ID);
  });

  it.each([1, 2, 3])("numa base cheia de empates (variação %i)", async (variation) => {
    const db = openDatabase(":memory:");
    seedWithTies(db, 400, variation);
    await expectSameListing(db, "cmp_ties");
  });
});
