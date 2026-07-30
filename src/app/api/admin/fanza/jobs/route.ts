import { NextResponse } from "next/server";
import { z } from "zod";
import { FanzaJobStepError, runFanzaImportJobStep } from "@/lib/fanza/job-runner";
import { fanzaConfiguration } from "@/lib/fanza/client";
import { nextErrorAttempt, safeImportErrorMessage } from "@/lib/fanza/import-state";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const createSchema = z.object({
  action: z.literal("create"),
  keyword: z.string().trim().max(100).nullable().optional(),
  pageSize: z.number().int().min(1).max(100).default(50),
  maxItems: z.number().int().min(1).max(1_000_000),
  dryRun: z.boolean().default(true),
});
const stepSchema = z.object({
  action: z.literal("step"),
  jobId: z.string().uuid(),
});
const bodySchema = z.discriminatedUnion("action", [createSchema, stepSchema]);

export async function POST(request: Request) {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || user.app_metadata?.role !== "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  if (!fanzaConfiguration().configured) {
    return NextResponse.json({ status: "waiting_credentials", message: "認証情報未設定のため実行待ち" });
  }
  const admin = createAdminClient();

  if (parsed.data.action === "create") {
    const { data: source, error: sourceError } = await admin.from("data_sources")
      .select("id").eq("name", "FANZA Webサービス").single();
    if (sourceError) return NextResponse.json({ error: sourceError.message }, { status: 500 });
    const { data, error } = await admin.from("fanza_import_jobs").insert({
      requested_by: user.id,
      data_source_id: source.id,
      status: "pending",
      keyword: parsed.data.keyword || null,
      page_size: parsed.data.pageSize,
      max_items: parsed.data.maxItems,
      dry_run: parsed.data.dryRun,
    }).select("*").single();
    return error
      ? NextResponse.json({ error: error.message }, { status: 500 })
      : NextResponse.json({ job: data }, { status: 201 });
  }

  const { data: job, error: jobError } = await admin.from("fanza_import_jobs")
    .select("*").eq("id", parsed.data.jobId).maybeSingle();
  if (jobError || !job) return NextResponse.json({ error: jobError?.message ?? "Job not found" }, { status: 404 });
  if (job.status === "completed" || job.status === "cancelled") {
    return NextResponse.json({ job, message: "このジョブは終了済みです。" });
  }
  await admin.from("fanza_import_jobs").update({ status: "running", last_error: null }).eq("id", job.id);
  try {
    const result = await runFanzaImportJobStep({ ...job, status: "running" });
    await admin.from("fanza_import_errors").update({ resolved_at: new Date().toISOString() })
      .eq("job_id", job.id)
      .eq("api_offset", job.next_offset)
      .is("resolved_at", null);
    return NextResponse.json(result);
  } catch (error) {
    const stage = error instanceof FanzaJobStepError ? error.stage : "unknown";
    const errorType = `${stage}_step_failed`;
    const message = safeImportErrorMessage(error, [
      process.env.FANZA_API_ID ?? "",
      process.env.FANZA_AFFILIATE_ID ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    ]);
    const { data: previousError } = await admin.from("fanza_import_errors").select("id,attempt_count")
      .eq("job_id", job.id)
      .eq("api_offset", job.next_offset)
      .eq("processing_stage", stage)
      .eq("error_type", errorType)
      .is("resolved_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const errorRecord = {
        job_id: job.id,
        api_offset: job.next_offset,
        processing_stage: stage,
        error_type: errorType,
        attempt_count: nextErrorAttempt(previousError?.attempt_count),
        message: message.slice(0, 2000),
        retryable: true,
    };
    await Promise.all([
      admin.from("fanza_import_jobs").update({
        status: "failed", retry_count: Number(job.retry_count) + 1, last_error: message.slice(0, 2000),
      }).eq("id", job.id),
      previousError
        ? admin.from("fanza_import_errors").update(errorRecord).eq("id", previousError.id)
        : admin.from("fanza_import_errors").insert(errorRecord),
    ]);
    return NextResponse.json({ error: message, retryable: true, resumeOffset: job.next_offset }, { status: 502 });
  }
}
