import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { LoadMoreWorkGrid } from "@/components/load-more-work-grid";
import { getCatalogWorks } from "@/lib/queries/catalog";
const decode=(value:string)=>{try{return decodeURIComponent(value)}catch{return value}};
export async function generateMetadata({params}:{params:Promise<{name:string}>}):Promise<Metadata>{const name=decode((await params).name);return {title:`${name}ジャンルの作品`,description:`${name}ジャンルの人気作品・新着作品一覧です。`,alternates:{canonical:`/genre/${encodeURIComponent(name)}`}}}
export default async function GenrePage({params}:{params:Promise<{name:string}>}){const name=decode((await params).name),works=await getCatalogWorks({genre:name,limit:96,offset:0});if(!works.length)notFound();return <main className="mx-auto max-w-7xl px-5 py-12"><Breadcrumbs items={[{name:"トップ",href:"/"},{name:"ジャンル",href:"/genres"},{name}]}/><h1 className="mt-6 text-3xl font-black">{name}の作品</h1><LoadMoreWorkGrid works={works} className="mt-8"/></main>}
