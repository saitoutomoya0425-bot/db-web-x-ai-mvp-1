import Papa from "papaparse";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

export const runtime = "nodejs";

type VideoInsert = Database["public"]["Tables"]["videos"]["Insert"];
type ImportError = { row: number; product_code?: string; message: string };

const headerAliases: Record<string, keyof VideoInsert> = {
  product_code: "product_code", "品番": "product_code",
  title: "title", "タイトル": "title",
  actress_name: "actress_name", "女優名": "actress_name",
  maker_name: "maker_name", "メーカー": "maker_name",
  release_date: "release_date", "発売日": "release_date",
  thumbnail_url: "thumbnail_url", "サムネ画像url": "thumbnail_url", "サムネイルurl": "thumbnail_url",
  video_url: "video_url", "動画url": "video_url",
  affiliate_url: "affiliate_url", "アフィリエイトurl": "affiliate_url",
  description: "description", "説明": "description",
};

function cleanHeader(header: string) {
  const normalized = header.replace(/^\uFEFF/, "").trim().toLowerCase();
  return headerAliases[normalized] ?? normalized;
}

function nullable(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function validUrl(value: string | null) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "CSVファイルを選択してください。" }, { status: 400 });
  if (!file.name.toLowerCase().endsWith(".csv")) return NextResponse.json({ error: "CSV形式のファイルを選択してください。" }, { status: 400 });
  if (file.size > 5 * 1024 * 1024) return NextResponse.json({ error: "ファイルサイズは5MB以下にしてください。" }, { status: 400 });

  const parsed = Papa.parse<Record<string, string>>(await file.text(), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: cleanHeader,
    transform: (value) => value.trim(),
  });
  if (parsed.data.length > 2000) return NextResponse.json({ error: "1回に登録できるのは2,000件までです。" }, { status: 400 });

  const errors: ImportError[] = parsed.errors.map((error) => ({
    row: (error.row ?? 0) + 2,
    message: `CSV解析エラー: ${error.message}`,
  }));
  const validRows: { row: number; value: VideoInsert }[] = [];

  parsed.data.forEach((raw, index) => {
    const row = index + 2;
    const productCode = nullable(raw.product_code)?.toUpperCase() ?? "";
    const title = nullable(raw.title) ?? "";
    const releaseDate = nullable(raw.release_date);
    const thumbnailUrl = nullable(raw.thumbnail_url);
    const videoUrl = nullable(raw.video_url);
    const affiliateUrl = nullable(raw.affiliate_url);
    if (!productCode) errors.push({ row, message: "品番（product_code）は必須です。" });
    else if (!title) errors.push({ row, product_code: productCode, message: "タイトル（title）は必須です。" });
    else if (releaseDate && !/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) errors.push({ row, product_code: productCode, message: "発売日はYYYY-MM-DD形式で入力してください。" });
    else if (![thumbnailUrl, videoUrl, affiliateUrl].every(validUrl)) errors.push({ row, product_code: productCode, message: "URLはhttp://またはhttps://で入力してください。" });
    else validRows.push({
      row,
      value: {
        product_code: productCode,
        title,
        actress_name: nullable(raw.actress_name),
        maker_name: nullable(raw.maker_name),
        series_name: null,
        label_name: null,
        genre: null,
        duration: null,
        release_date: releaseDate,
        sample_images: [],
        thumbnail_url: thumbnailUrl,
        video_url: videoUrl,
        affiliate_url: affiliateUrl,
        description: nullable(raw.description),
        popularity: 0,
        favorite_count: 0,
      },
    });
  });

  let imported = 0;
  for (let offset = 0; offset < validRows.length; offset += 100) {
    const batch = validRows.slice(offset, offset + 100);
    const { error } = await supabase.from("videos").upsert(batch.map((item) => item.value), { onConflict: "product_code" });
    if (!error) {
      imported += batch.length;
      continue;
    }
    for (const item of batch) {
      const { error: rowError } = await supabase.from("videos").upsert(item.value, { onConflict: "product_code" });
      if (rowError) errors.push({ row: item.row, product_code: item.value.product_code, message: rowError.message });
      else imported += 1;
    }
  }
  return NextResponse.json({ imported, failed: errors.length, total: parsed.data.length, errors });
}
