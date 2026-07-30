import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const nullableText = z.string().trim().max(5000).nullable().optional();
const imageUrl = z.string().trim().refine((value) => {
  if (value.startsWith("/card-thumbnails/") && !value.includes("..")) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}, "画像URLを確認してください").nullable().optional();
const workSchema = z.object({
  product_code: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(1000),
  actress_name: nullableText,
  maker_name: nullableText,
  series_name: nullableText,
  label_name: nullableText,
  genre: nullableText,
  duration: z.number().int().nonnegative().nullable().optional(),
  release_date: z.string().date().nullable().optional(),
  card_thumbnail_url: imageUrl,
  thumbnail_url: z.string().trim().url().nullable().optional(),
  video_url: z.string().trim().url().nullable().optional(),
  official_url: z.string().trim().url().nullable().optional(),
  affiliate_url: z.string().trim().url().nullable().optional(),
  source_name: nullableText,
  external_product_id: nullableText,
  description: nullableText,
  is_published: z.boolean().default(false),
  content_category: z.enum(["commercial_av", "creator", "doujin"]).default("commercial_av"),
});
const updateSchema = workSchema.extend({ id: z.string().uuid() });

function isOfficialSalesUrl(value: string | null | undefined) {
  if (!value) return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return ["dmm.com", "dmm.co.jp", "fanza.com", "fanza.co.jp"]
      .some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function publicationError(input: z.infer<typeof workSchema>) {
  if (!input.is_published) return null;
  if (!input.source_name || !input.external_product_id || !input.official_url) {
    return "公開するには、出典名・公式の外部商品ID・通常の公式商品URLが必要です。";
  }
  if (!isOfficialSalesUrl(input.official_url)) {
    return "公式商品URLはDMM/FANZAの正規ドメインを指定してください。";
  }
  return null;
}

async function authorize() {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  return user?.app_metadata?.role === "admin";
}

export async function GET(request: Request) {
  if (!await authorize()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const params = new URL(request.url).searchParams;
  const query = (params.get("q") ?? "").trim();
  const page = Math.max(1, Number(params.get("page") ?? 1) || 1);
  const limit = 30;
  const from = (page - 1) * limit;
  let builder = createAdminClient().from("videos")
    .select("id,product_code,title,actress_name,maker_name,series_name,label_name,genre,duration,release_date,sample_images,card_thumbnail_url,thumbnail_url,video_url,official_url,affiliate_url,source_name,external_product_id,source_checked_at,description,is_published,content_category,created_at,updated_at", { count: "estimated" })
    .order("updated_at", { ascending: false }).range(from, from + limit - 1);
  if (query) builder = builder.or(`product_code.ilike.%${query.replaceAll(",", "")}%,title.ilike.%${query.replaceAll(",", "")}%,actress_name.ilike.%${query.replaceAll(",", "")}%,maker_name.ilike.%${query.replaceAll(",", "")}%`);
  const { data, count, error } = await builder;
  return error
    ? NextResponse.json({ error: error.message }, { status: 500 })
    : NextResponse.json({ items: data ?? [], count: count ?? 0, page, limit });
}

export async function POST(request: Request) {
  if (!await authorize()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = workSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "入力内容を確認してください" }, { status: 400 });
  const publishError = publicationError(parsed.data);
  if (publishError) return NextResponse.json({ error: publishError }, { status: 400 });
  const values = {
    product_code: parsed.data.product_code.toUpperCase(),
    title: parsed.data.title,
    actress_name: parsed.data.actress_name ?? null,
    maker_name: parsed.data.maker_name ?? null,
    series_name: parsed.data.series_name ?? null,
    label_name: parsed.data.label_name ?? null,
    genre: parsed.data.genre ?? null,
    duration: parsed.data.duration ?? null,
    release_date: parsed.data.release_date ?? null,
    sample_images: [] as string[],
    card_thumbnail_url: parsed.data.card_thumbnail_url ?? null,
    thumbnail_url: parsed.data.thumbnail_url ?? null,
    video_url: parsed.data.video_url ?? null,
    official_url: parsed.data.official_url ?? null,
    affiliate_url: parsed.data.affiliate_url ?? null,
    source_name: parsed.data.source_name ?? null,
    external_product_id: parsed.data.external_product_id ?? null,
    source_checked_at: parsed.data.source_name && parsed.data.official_url ? new Date().toISOString() : null,
    description: parsed.data.description ?? null,
    popularity: 0,
    favorite_count: 0,
    is_published: parsed.data.is_published,
    content_category: parsed.data.content_category,
  };
  const { data, error } = await createAdminClient().from("videos").insert(values).select("*").single();
  return error ? NextResponse.json({ error: error.message }, { status: error.code === "23505" ? 409 : 500 }) : NextResponse.json(data, { status: 201 });
}

export async function PATCH(request: Request) {
  if (!await authorize()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "入力内容を確認してください" }, { status: 400 });
  const publishError = publicationError(parsed.data);
  if (publishError) return NextResponse.json({ error: publishError }, { status: 400 });
  const { id, ...input } = parsed.data;
  const values = {
    ...input,
    product_code: input.product_code.toUpperCase(),
    source_checked_at: input.source_name && input.official_url ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await createAdminClient().from("videos").update(values).eq("id", id).select("*").single();
  return error ? NextResponse.json({ error: error.message }, { status: error.code === "23505" ? 409 : 500 }) : NextResponse.json(data);
}

export async function DELETE(request: Request) {
  if (!await authorize()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const { error } = await createAdminClient().from("videos").delete().eq("id", id);
  return error ? NextResponse.json({ error: error.message }, { status: 500 }) : NextResponse.json({ deleted: true });
}
