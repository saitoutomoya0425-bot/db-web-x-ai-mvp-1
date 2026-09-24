import postgres from "postgres";
import { toMyFansPublicWorks } from "../src/lib/myfans/public-ui.ts";
import { MYFANS_SOURCE_NAME } from "../src/lib/myfans/publication.ts";
import type { MyFansApprovedPublicationProjection } from "../src/types/database.ts";

const databaseUrl = process.env.SUPABASE_DB_URL;
if (!databaseUrl) throw new Error("SUPABASE_DB_URL_REQUIRED");

const sql = postgres(databaseUrl, {
  ssl: "require",
  max: 1,
  prepare: false,
  idle_timeout: 20,
  connect_timeout: 20,
});

try {
  const snapshot = await sql.begin(async (tx) => {
    await tx`set transaction read only`;
    const sources = await tx<{ id: string; is_active: boolean }[]>`
      select id, is_active
      from public.data_sources
      where name = ${MYFANS_SOURCE_NAME}
    `;
    if (sources.length !== 1) throw new Error("MYFANS_SOURCE_NOT_EXACT");
    const rows = await tx<MyFansApprovedPublicationProjection[]>`
      select
        p.external_post_id,
        p.title,
        p.official_url as canonical_outbound_url,
        p.price,
        p.currency,
        coalesce(p.media_indicator, p.content_type, 'unknown') as media_type,
        p.affiliate_link_status,
        p.affiliate_url,
        false as show_affiliate_cta,
        c.external_creator_id,
        c.profile_slug as creator_profile_slug,
        c.display_name as creator_display_name,
        c.official_url as creator_canonical_url,
        'MyFans'::text as source_badge
      from public.myfans_posts p
      join public.myfans_creators c
        on c.id = p.creator_id
       and c.data_source_id = p.data_source_id
      where p.data_source_id = ${sources[0].id}
        and c.publication_review_state = 'approved'
        and c.publication_visibility in ('public_general','affiliate_visible','approved_affiliate_only')
        and p.publication_review_state = 'approved'
        and p.publication_visibility in ('public_general','affiliate_visible','approved_affiliate_only')
      order by p.external_post_id
    `;
    const [projection] = await tx<{ count: number }[]>`
      select count(*)::int as count
      from public.myfans_approved_publication_projection
    `;
    return { source: sources[0], rows, projectionRows: projection.count };
  });

  const works = toMyFansPublicWorks(snapshot.rows);
  const report = {
    mode: "PRIVATE_READ_ONLY_PUBLIC_UI_PREVIEW",
    source: { active: snapshot.source.is_active },
    approvedProjectionInput: snapshot.rows.length,
    publicModels: works.length,
    cardsRenderable: works.filter((work) => work.title && work.creatorName && work.detailHref).length,
    detailsRenderable: works.filter((work) => work.canonicalOutboundUrl && work.externalPostId).length,
    neutralPlaceholders: works.filter((work) => work.placeholder.kind === "local_neutral").length,
    canonicalOutboundLinks: works.filter((work) => work.canonicalOutboundUrl).length,
    affiliateCtaVisible: works.filter((work) => work.showAffiliateCta).length,
    brokenTitles: works.filter((work) => !work.title).length,
    missingCreators: works.filter((work) => !work.creatorName).length,
    nullPrices: works.filter((work) => work.priceJpy === null).length,
    unknownMedia: works.filter((work) => work.mediaType === "unknown").length,
    currentProjectionRows: snapshot.projectionRows,
    db: { selectStatements: 3, writes: 0 },
    imageRetrievals: 0,
    individualValuesLogged: 0,
  };
  if (
    report.source.active !== false
    || report.approvedProjectionInput !== 100
    || report.publicModels !== 100
    || report.cardsRenderable !== 100
    || report.detailsRenderable !== 100
    || report.neutralPlaceholders !== 100
    || report.canonicalOutboundLinks !== 100
    || report.affiliateCtaVisible !== 0
    || report.brokenTitles !== 0
    || report.missingCreators !== 0
    || report.nullPrices !== 12
    || report.unknownMedia !== 1
    || report.currentProjectionRows !== 0
  ) throw new Error("MYFANS_PRIVATE_PUBLIC_UI_PREVIEW_MISMATCH");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await sql.end();
}
