import { createAdminClient } from "@/lib/supabase/admin";
import { extractWithAI, fallbackExtraction, type Extraction, type ExtractionInput } from "@/lib/ai/extraction";
import { canAutoApprove, classifyCandidate, type QualitySettings } from "@/lib/ai/quality";

function inputText(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const value = (payload as Record<string,unknown>).text;
  return typeof value === "string" ? value.slice(0, 8000) : "";
}
function mediaUrls(payload: unknown) {
  if (!payload || typeof payload !== "object") return [];
  const item = payload as Record<string,unknown>;
  const values = [item.thumbnail_url,item.video_url,...(Array.isArray(item.media_urls) ? item.media_urls : [])];
  return [...new Set(values.filter((value):value is string => typeof value === "string" && /^https?:\/\//.test(value)))].slice(0,20);
}

export async function runCandidateEnrichment(batchSize = 20) {
  const supabase = createAdminClient();
  const [{data:quality},{data:qualitySnapshots}]=await Promise.all([
    supabase.from("ai_quality_settings").select("*").eq("id",true).maybeSingle(),
    supabase.from("ai_quality_snapshots").select("passed_gate").order("calculated_at",{ascending:false}).limit(1),
  ]);
  await supabase.from("source_items").update({ extraction_status:"failed", error_message:"AI processing timeout" })
    .eq("extraction_status","processing").lt("updated_at",new Date(Date.now()-15*60_000).toISOString());
  const { data: items, error } = await supabase.rpc("claim_source_items_for_extraction",{batch_size:batchSize});
  if (error) throw new Error(error.message);
  if (!items?.length) return { processed:0,provider:null,fallback:false };
  const inputs:ExtractionInput[] = items.map(item=>({id:item.id,text:inputText(item.payload),existing:{
    product_code:item.product_code,title:item.title,actress_name:item.actress_name,maker_name:item.maker_name,series_name:item.series_name,
  }}));
  let results:Extraction[],provider="fallback",model="deterministic-v1",fallback=true;
  try {
    const ai = await extractWithAI(inputs);
    results=ai.candidates; provider=ai.provider; model=ai.model; fallback=false;
    await supabase.from("ai_extraction_runs").insert({source_item_id:null,provider,model,status:"completed",request_id:ai.requestId,
      input_tokens:ai.usage.input,output_tokens:ai.usage.output,total_tokens:ai.usage.total,latency_ms:ai.latencyMs,raw_output:ai.raw});
  } catch (cause) {
    const message=cause instanceof Error?cause.message:String(cause);
    results=inputs.map(fallbackExtraction);
    await supabase.from("ai_extraction_runs").insert({source_item_id:null,provider:"openai",model:process.env.AI_EXTRACTION_MODEL||"gpt-5.4-mini",
      status:"failed",error_code:"extraction_failed",error_message:message.slice(0,2000),latency_ms:0,raw_output:null});
  }
  const byId=new Map(results.map(result=>[result.source_item_id,result]));
  let duplicates=0,failed=0,autoApproved=0;
  for (const item of items) {
    const result=byId.get(item.id) ?? fallbackExtraction(inputs.find(input=>input.id===item.id)!);
    const productCode=result.product_code || item.product_code;
    const duplicate=productCode ? (await supabase.rpc("find_candidate_duplicate",{candidate_code:productCode,exclude_source_id:item.id})).data?.[0] : null;
    const hasDuplicate=Boolean(duplicate?.duplicate_source_id||duplicate?.duplicate_video_id);
    if (hasDuplicate) duplicates++;
    const settings:QualitySettings={high_threshold:Number(quality?.high_threshold??.9),medium_threshold:Number(quality?.medium_threshold??.65),
      auto_approve_enabled:Boolean(quality?.auto_approve_enabled),auto_approve_threshold:Number(quality?.auto_approve_threshold??.98),
      minimum_evaluated_samples:Number(quality?.minimum_evaluated_samples??200),minimum_precision:Number(quality?.minimum_precision??.98)};
    const reviewInput={confidence:result.confidence,hasDuplicate,hasCode:Boolean(productCode),hasTitle:Boolean(result.title||item.title)};
    const reviewBucket=classifyCandidate(reviewInput,settings);
    const shouldAutoApprove=canAutoApprove({...reviewInput,qualityGatePassed:Boolean(qualitySnapshots?.[0]?.passed_gate)},settings);
    const { error:updateError }=await supabase.from("source_items").update({
      product_code:productCode,title:result.title||item.title,actress_name:result.actress_name||item.actress_name,
      maker_name:result.maker_name||item.maker_name,series_name:result.series_name||item.series_name,
      confidence:result.confidence,field_confidence:result.field_confidence,extraction_status:fallback?"fallback":"completed",
      extraction_provider:provider,extraction_model:model,duplicate_of:duplicate?.duplicate_source_id??null,
      duplicate_video_id:duplicate?.duplicate_video_id??null,extracted_at:new Date().toISOString(),error_message:null,
      review_bucket:shouldAutoApprove?"auto_approved":reviewBucket,
    }).eq("id",item.id);
    if (updateError) { failed++; await supabase.from("source_items").update({extraction_status:"failed",error_message:updateError.message}).eq("id",item.id); }
    const urls=mediaUrls(item.payload);
    if (urls.length) await supabase.from("media_analysis_jobs").upsert(urls.map(url=>({source_item_id:item.id,media_url:url,media_type:/\.(mp4|webm|mov)(\?|$)/i.test(url)?"video":"image"})),{onConflict:"source_item_id,media_url",ignoreDuplicates:true});
    if(shouldAutoApprove&&productCode) {
      const promoted=await supabase.from("videos").upsert({product_code:productCode,title:result.title||item.title!,actress_name:result.actress_name||item.actress_name,
        maker_name:result.maker_name||item.maker_name,series_name:result.series_name||item.series_name,label_name:null,genre:null,duration:null,
        release_date:null,sample_images:[],card_thumbnail_url:null,thumbnail_url:null,video_url:null,affiliate_url:null,description:null,popularity:0,favorite_count:0},
      {onConflict:"product_code",ignoreDuplicates:true});
      if(!promoted.error) {
        autoApproved++;
        await supabase.from("source_items").update({status:"promoted",reviewed_at:new Date().toISOString()}).eq("id",item.id);
        await supabase.from("ai_correction_examples").insert({source_item_id:item.id,input_text:inputText(item.payload),model_output:result,
          corrected_output:result,changed_fields:[],reviewer_id:null,decision:"approved"});
      }
    }
  }
  if(autoApproved)await supabase.rpc("sync_catalog_dimensions");
  return {processed:items.length,duplicates,failed,autoApproved,provider,fallback};
}
