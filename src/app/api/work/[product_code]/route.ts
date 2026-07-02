import { NextResponse } from "next/server";
import { getWorkByCode } from "@/lib/queries/public-works";

export async function GET(_request: Request, { params }: { params: Promise<{ product_code: string }> }) {
  const { product_code } = await params;
  const work = await getWorkByCode(product_code);
  if (!work) return NextResponse.json({ error: "Work not found" }, { status: 404 });
  return NextResponse.json({ data: work }, { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } });
}
