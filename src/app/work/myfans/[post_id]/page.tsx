import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MyFansPublicWorkDetail } from "@/components/myfans-public-work-detail";
import { isMyFansPublicEnabled } from "@/lib/myfans/public-feature";
import { getMyFansPublicWorkById } from "@/lib/queries/myfans-public";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ post_id: string }>;
}): Promise<Metadata> {
  if (!isMyFansPublicEnabled()) {
    return { title: "作品が見つかりません", robots: { index: false, follow: false } };
  }
  const work = await getMyFansPublicWorkById((await params).post_id);
  if (!work) return { title: "作品が見つかりません", robots: { index: false, follow: false } };
  const description = `${work.creatorName}「${work.title}」のMyFans作品情報。画像は掲載せず、公式作品ページへの導線を掲載しています。`;
  return {
    title: `${work.title}｜MyFans`,
    description,
    alternates: { canonical: work.detailHref },
    openGraph: { title: `${work.title}｜MyFans`, description, url: work.detailHref },
  };
}

export default async function MyFansWorkPage({
  params,
}: {
  params: Promise<{ post_id: string }>;
}) {
  if (!isMyFansPublicEnabled()) notFound();
  const work = await getMyFansPublicWorkById((await params).post_id);
  if (!work) notFound();
  return <MyFansPublicWorkDetail work={work} />;
}
