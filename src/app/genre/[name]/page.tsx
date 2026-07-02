import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { PublicWorkCard } from "@/components/public-work-card";
import { getCatalogWorks } from "@/lib/queries/catalog";
const decode=(value:string)=>{try{return decodeURIComponent(value)}catch{return value}};
export async function generateMetadata({params}:{params:Promise<{name:string}>}):Promise<Metadata>{const name=decode((await params).name);return {title:`${name}ジャンルの作品`,description:`${name}ジャンルの人気作品・新着作品一覧です。`,alternates:{canonical:`/genre/${encodeURIComponent(name)}`}}}
export default async function GenrePage({params,searchParams}:{params:Promise<{name:string}>;searchParams:Promise<{page?:string}>}){const name=decode((await params).name),page=Math.max(1,Number((await searchParams).page)||1),size=24,works=await getCatalogWorks({genre:name,limit:size,offset:(page-1)*size});return <main className="mx-auto max-w-6xl px-5 py-12"><Breadcrumbs items={[{name:"トップ",href:"/"},{name:"ジャンル",href:"/genres"},{name}]}/><h1 className="mt-6 text-3xl font-black">{name}の作品</h1><div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">{works.map(work=><PublicWorkCard key={work.id} work={work}/>)}</div><div className="mt-10 flex justify-center gap-3">{page>1&&<Link href={`?page=${page-1}`} className="rounded bg-slate-800 px-5 py-3">前へ</Link>}{works.length===size&&<Link href={`?page=${page+1}`} className="rounded bg-violet-600 px-5 py-3">次へ</Link>}</div></main>}
