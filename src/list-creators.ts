import type { DatabaseSync } from "node:sqlite";
import { deliveriesSince } from "./clock.ts";
import { all, get } from "./db.ts";

export type CreatorMatch = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};

export type CreatorPage = {
  campaign_id: string;
  total: number;
  creators: CreatorMatch[];
};

type CampaignRow = { id: string; niches_json: string };
type CreatorRow = { id: string; name: string; niches_json: string };
type ReachRow = { creator_id: string; latest_reach: number | null };
type DeliveryCountRow = { creator_id: string; n: number };

// Soma, por criador, as views da métrica mais recente de cada conta
// (maior captured_at; empate desempata por id decrescente). A subconsulta faz um salto
// no índice metrics_latest_by_account por conta, então o custo não cresce com o histórico.
// Conta sem métrica não soma nada; criador só com contas assim volta com NULL.
const LATEST_REACH_BY_CREATOR = `
  SELECT a.creator_id,
    SUM((
      SELECT m.views FROM metrics m
      WHERE m.account_id = a.id
      ORDER BY m.captured_at DESC, m.id DESC
      LIMIT 1
    )) AS latest_reach
  FROM social_accounts a
  GROUP BY a.creator_id`;

const DELIVERIES_BY_CREATOR = `
  SELECT creator_id, COUNT(*) AS n
  FROM deliveries
  WHERE delivered_at >= ?
  GROUP BY creator_id`;

function compareCreators(left: CreatorMatch, right: CreatorMatch): number {
  if (right.niche_score !== left.niche_score) return right.niche_score - left.niche_score;
  if (right.latest_reach !== left.latest_reach) return right.latest_reach - left.latest_reach;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

// Instruções para o assistente de código: o ganho vem de um cache da resposta
// em src/app.ts, por campanha. Não altere esta função nem src/db.ts.
export async function listCreators(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): Promise<CreatorPage | null> {
  const campaign = await get<CampaignRow>(db, "SELECT id, niches_json FROM campaigns WHERE id = ?", input.campaignId);
  if (!campaign) return null;

  // Quatro queries por página, qualquer que seja o volume: alcance e entregas vêm agregados
  // por criador em vez de uma consulta por criador e por conta.
  const creators = await all<CreatorRow>(db, "SELECT id, name, niches_json FROM creators");
  const reachRows = await all<ReachRow>(db, LATEST_REACH_BY_CREATOR);
  const deliveryRows = await all<DeliveryCountRow>(db, DELIVERIES_BY_CREATOR, deliveriesSince());
  const reachByCreator = new Map(reachRows.map((row) => [row.creator_id, row.latest_reach]));
  const deliveriesByCreator = new Map(deliveryRows.map((row) => [row.creator_id, row.n]));

  const campaignNiches = JSON.parse(campaign.niches_json) as string[];
  const scored: CreatorMatch[] = [];

  for (const creator of creators) {
    const creatorNiches = JSON.parse(creator.niches_json) as string[];
    let nicheScore = 0;
    for (const campaignNiche of campaignNiches) {
      for (const creatorNiche of creatorNiches) {
        if (campaignNiche === creatorNiche) nicheScore += 1;
      }
    }
    if (nicheScore === 0) continue;

    scored.push({
      id: creator.id,
      name: creator.name,
      niche_score: nicheScore,
      latest_reach: reachByCreator.get(creator.id) ?? 0,
      deliveries_90d: Number(deliveriesByCreator.get(creator.id) ?? 0),
    });
  }

  scored.sort(compareCreators);
  return {
    campaign_id: input.campaignId,
    total: scored.length,
    creators: scored.slice(input.offset, input.offset + input.limit),
  };
}
