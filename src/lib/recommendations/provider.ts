import type { WorkDetail } from "@/types/database";

export type RecommendationContext = {
  actress?: string;
  maker?: string;
  series?: string;
  genres?: string[];
};

export interface RecommendationProvider {
  recommend(candidates: WorkDetail[], context?: RecommendationContext, limit?: number): Promise<WorkDetail[]>;
}

/** 高速で説明可能な標準実装。将来は同じ境界でモデルAPIやベクトル検索へ差し替える。 */
export const weightedRecommendationProvider: RecommendationProvider = {
  async recommend(candidates, context = {}, limit = 12) {
    const score = (work: WorkDetail) =>
      (work.popularity ?? 0) * 2 + (work.favorite_count ?? 0) * 3
      + (context.actress && work.actresses?.name === context.actress ? 100 : 0)
      + (context.maker && work.makers?.name === context.maker ? 40 : 0)
      + (context.series && work.series_name === context.series ? 60 : 0)
      + (context.genres?.includes(work.genre ?? "") ? 30 : 0);
    return [...candidates].sort((a, b) => score(b) - score(a)).slice(0, limit);
  },
};
