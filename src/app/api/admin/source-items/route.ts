import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const editable=z.object({product_code:z.string().trim().max(100).nullable().optional(),title:z.string().trim().max(1000).nullable().optional(),
  actress_name:z.string().trim().max(300).nullable().optional(),maker_name:z.string().trim().max(300).nullable().optional(),series_name:z.string().trim().max(500).nullable().optional()});
const schema = z.object({ ids: z.array(z.number().int().positive()).min(1).max(500), action: z.enum(["save","promote", "ignore"]), updates:editable.optional() });
export async function PATCH(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.app_metadata?.role !== "admin") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  const {data:originals,error:readError}=await supabase.from("source_items").select("*").in("id",parsed.data.ids);
  if (readError) return NextResponse.json({error:readError.message},{status:500});
  if (parsed.data.updates && parsed.data.ids.length===1 && originals?.[0]) {
    const before=originals[0],input=parsed.data.updates;
    const updates:{product_code?:string|null;title?:string|null;actress_name?:string|null;maker_name?:string|null;series_name?:string|null}={};
    if("product_code" in input) updates.product_code=input.product_code?.toUpperCase()||null;
    if("title" in input) updates.title=input.title||null;
    if("actress_name" in input) updates.actress_name=input.actress_name||null;
    if("maker_name" in input) updates.maker_name=input.maker_name||null;
    if("series_name" in input) updates.series_name=input.series_name||null;
    const changed=(Object.keys(updates) as (keyof typeof updates)[]).filter(key=>String(before[key]??"")!==String(updates[key]??""));
    if (changed.length) {
      const admin=createAdminClient(),code=updates.product_code??before.product_code;
      const [{data:duplicateRows},{data:quality}]=await Promise.all([
        code?admin.rpc("find_candidate_duplicate",{candidate_code:code,exclude_source_id:before.id}):Promise.resolve({data:null}),
        admin.from("ai_quality_settings").select("high_threshold,medium_threshold").eq("id",true).maybeSingle(),
      ]);
      const duplicate=duplicateRows?.[0],hasDuplicate=Boolean(duplicate?.duplicate_source_id||duplicate?.duplicate_video_id);
      const hasCode=Boolean(code),hasTitle=Boolean(updates.title??before.title),confidence=Number(before.confidence??0);
      const review_bucket=hasDuplicate?"duplicate":!hasCode||!hasTitle?"invalid":confidence>=Number(quality?.high_threshold??.9)?"high":confidence>=Number(quality?.medium_threshold??.65)?"medium":"low";
      Object.assign(updates,{duplicate_of:duplicate?.duplicate_source_id??null,duplicate_video_id:duplicate?.duplicate_video_id??null,review_bucket});
      const {error:updateError}=await supabase.from("source_items").update(updates).eq("id",before.id);
      if (updateError) return NextResponse.json({error:updateError.message},{status:500});
      const text=typeof (before.payload as {text?:unknown}|null)?.text==="string" ? String((before.payload as {text:string}).text) : "";
      await supabase.from("ai_correction_examples").insert({source_item_id:before.id,input_text:text,model_output:{
        product_code:before.product_code,title:before.title,actress_name:before.actress_name,maker_name:before.maker_name,series_name:before.series_name,
        confidence:before.confidence,field_confidence:before.field_confidence,
      },corrected_output:{...updates},changed_fields:changed,reviewer_id:user.id,decision:"corrected"});
    }
  }
  if (parsed.data.action==="save") return NextResponse.json({updated:1});
  if (parsed.data.action === "ignore") {
    const { error } = await supabase.from("source_items").update({ status: "ignored", error_message: null,reviewed_at:new Date().toISOString(),reviewed_by:user.id }).in("id", parsed.data.ids);
    if (!error) await supabase.from("ai_correction_examples").insert((originals??[]).map(item=>({source_item_id:item.id,input_text:typeof (item.payload as {text?:unknown}|null)?.text==="string"?String((item.payload as {text:string}).text):"",model_output:{
      product_code:item.product_code,title:item.title,actress_name:item.actress_name,maker_name:item.maker_name,series_name:item.series_name,confidence:item.confidence,
    },corrected_output:{},changed_fields:[],reviewer_id:user.id,decision:"rejected"})));
    return error ? NextResponse.json({ error: error.message }, { status: 500 }) : NextResponse.json({ updated: parsed.data.ids.length });
  }
  const { data: items, error } = await supabase.from("source_items").select("*").in("id", parsed.data.ids).eq("status", "pending");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const valid = (items ?? []).filter((item) => item.product_code && item.title);
  const invalid = (items ?? []).filter((item) => !item.product_code || !item.title);
  if (valid.length) {
    const { error: promoteError } = await supabase.from("videos").upsert(valid.map((item) => ({
      product_code: item.product_code!, title: item.title!, actress_name: item.actress_name,
      maker_name: item.maker_name, series_name: item.series_name, sample_images: [],
      label_name: null, genre: null, duration: null, release_date: null, card_thumbnail_url: null, thumbnail_url: null,
      video_url: null, affiliate_url: null, description: null, popularity: 0, favorite_count: 0,
    })), { onConflict: "product_code", ignoreDuplicates: true });
    if (promoteError) return NextResponse.json({ error: promoteError.message }, { status: 500 });
    await supabase.from("source_items").update({ status: "promoted", error_message: null,reviewed_at:new Date().toISOString(),reviewed_by:user.id }).in("id", valid.map((item) => item.id));
    const actressNames=[...new Set(valid.map(item=>item.actress_name).filter((name):name is string=>Boolean(name)))];
    const makerNames=[...new Set(valid.map(item=>item.maker_name).filter((name):name is string=>Boolean(name)))];
    await Promise.all([
      actressNames.length?supabase.from("actresses").upsert(actressNames.map(name=>({name})),{onConflict:"name",ignoreDuplicates:true}):Promise.resolve(),
      makerNames.length?supabase.from("makers").upsert(makerNames.map(name=>({name})),{onConflict:"name",ignoreDuplicates:true}):Promise.resolve(),
    ]);
    await supabase.from("ai_correction_examples").insert(valid.map(item=>({source_item_id:item.id,input_text:typeof (item.payload as {text?:unknown}|null)?.text==="string"?String((item.payload as {text:string}).text):"",model_output:{
      product_code:item.product_code,title:item.title,actress_name:item.actress_name,maker_name:item.maker_name,series_name:item.series_name,confidence:item.confidence,
    },corrected_output:{product_code:item.product_code,title:item.title,actress_name:item.actress_name,maker_name:item.maker_name,series_name:item.series_name},
    changed_fields:[],reviewer_id:user.id,decision:"approved"})));
  }
  if (invalid.length) await supabase.from("source_items").update({ status: "error", error_message: "品番とタイトルが必要です" }).in("id", invalid.map((item) => item.id));
  return NextResponse.json({ promoted: valid.length, errors: invalid.length });
}
