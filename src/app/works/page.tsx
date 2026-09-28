import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { SourceAwarePaginatedWorkGrid } from "@/components/source-aware-paginated-work-grid";
import { getSourceAwareCatalogWorks } from "@/lib/queries/source-aware-public";
import type { CatalogSort } from "@/lib/queries/catalog";

type WorksSearchParams = {
  sort?: string;
  genre?: string;
  maker?: string;
  cursor?: string;
};

function parseSort(value?: string): CatalogSort {
  if (value === "new" || value === "newest") return "newest";
  if (value === "release" || value === "recommended") return value;
  return "popular";
}

function worksHref(options: { sort: CatalogSort; genre: string; maker: string; cursor?: string | null }) {
  const query = new URLSearchParams();
  if (options.sort !== "popular") query.set("sort", options.sort);
  if (options.genre) query.set("genre", options.genre);
  if (options.maker) query.set("maker", options.maker);
  if (options.cursor) query.set("cursor", options.cursor);
  const value = query.toString();
  return value ? `/works?${value}` : "/works";
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<WorksSearchParams>;
}): Promise<Metadata> {
  const params = await searchParams;
  const sort = parseSort(params.sort);
  const genre = params.genre?.slice(0, 100) ?? "";
  const maker = params.maker?.slice(0, 100) ?? "";
  return {
    title: params.cursor ? "作品一覧（続き）" : "作品一覧",
    description: "人気作品、新着作品、発売日順から作品を探せます。",
    alternates: { canonical: worksHref({ sort, genre, maker, cursor: params.cursor?.slice(0, 2048) }) },
    robots: { index: true, follow: true },
  };
}

export default async function WorksPage({
  searchParams,
}: {
  searchParams: Promise<WorksSearchParams>;
}) {
  const params = await searchParams;
  const sort = parseSort(params.sort);
  const genre = params.genre?.slice(0, 100) ?? "";
  const maker = params.maker?.slice(0, 100) ?? "";
  const cursor = params.cursor?.slice(0, 2048);
  const result = await getSourceAwareCatalogWorks({
    limit: 96,
    cursor,
    sort,
    genre: genre || undefined,
    maker: maker || undefined,
  });
  if (result.invalidCursor) notFound();
  const nextHref = result.nextCursor
    ? worksHref({ sort, genre, maker, cursor: result.nextCursor })
    : null;
  return (
    <main className="mx-auto max-w-7xl px-5 py-12">
      <Breadcrumbs items={[{ name: "トップ", href: "/" }, { name: "作品一覧" }]} />
      <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black">作品一覧</h1>
          <p className="mt-2 text-sm text-slate-400">人気・新着・発売日から作品を探せます。</p>
        </div>
        <form className="flex gap-2">
          <input type="hidden" name="genre" value={genre} />
          <input type="hidden" name="maker" value={maker} />
          <select name="sort" defaultValue={sort} className="rounded-lg border border-slate-700 bg-slate-900 px-3">
            <option value="popular">人気順</option>
            <option value="newest">新着順</option>
            <option value="recommended">おすすめ順</option>
            <option value="release">発売日順</option>
          </select>
          <button className="rounded-lg bg-violet-600 px-4 py-2 text-sm">適用</button>
        </form>
      </div>
      <SourceAwarePaginatedWorkGrid works={result.works} nextHref={nextHref} className="mt-8" />
    </main>
  );
}
