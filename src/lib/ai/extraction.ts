import { z } from "zod";

export type ExtractionInput = {
  id: number;
  text: string;
  existing: { product_code?: string | null; title?: string | null; actress_name?: string | null; maker_name?: string | null; series_name?: string | null };
};
const candidateSchema = z.object({
  source_item_id: z.number().int(),
  product_code: z.string().nullable(),
  title: z.string().nullable(),
  actress_name: z.string().nullable(),
  maker_name: z.string().nullable(),
  series_name: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  field_confidence: z.object({
    product_code: z.number().min(0).max(1), title: z.number().min(0).max(1),
    actress_name: z.number().min(0).max(1), maker_name: z.number().min(0).max(1), series_name: z.number().min(0).max(1),
  }),
});
const outputSchema = z.object({ candidates: z.array(candidateSchema) });
export type Extraction = z.infer<typeof candidateSchema>;
export type ExtractionResult = {
  candidates: Extraction[]; provider: string; model: string; requestId: string | null;
  usage: { input: number; output: number; total: number }; latencyMs: number; raw: unknown;
};

const jsonSchema = {
  type: "object", additionalProperties: false, required: ["candidates"],
  properties: { candidates: { type: "array", items: {
    type: "object", additionalProperties: false,
    required: ["source_item_id","product_code","title","actress_name","maker_name","series_name","confidence","field_confidence"],
    properties: {
      source_item_id: { type: "integer" }, product_code: { type: ["string","null"] }, title: { type: ["string","null"] },
      actress_name: { type: ["string","null"] }, maker_name: { type: ["string","null"] }, series_name: { type: ["string","null"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      field_confidence: { type: "object", additionalProperties: false,
        required: ["product_code","title","actress_name","maker_name","series_name"],
        properties: Object.fromEntries(["product_code","title","actress_name","maker_name","series_name"].map((key) => [key,{type:"number",minimum:0,maximum:1}])) },
    },
  } } },
} as const;

function outputText(response: { output?: { content?: { type?: string; text?: string }[] }[] }) {
  return response.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text")?.text;
}
export async function extractWithAI(inputs: ExtractionInput[]): Promise<ExtractionResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  const model = process.env.AI_EXTRACTION_MODEL || "gpt-5.4-mini";
  const started = Date.now();
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", signal: AbortSignal.timeout(60_000),
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      instructions: "日本語投稿から成人向け作品の品番、作品名、女優名、メーカー名、シリーズ名を抽出する。推測で補完せず、根拠がなければnull。品番は英字大文字-数字へ正規化する。各項目と全体に0〜1の校正された信頼度を付ける。入力IDを必ず維持する。",
      input: JSON.stringify(inputs),
      text: { format: { type: "json_schema", name: "work_candidate_extraction", strict: true, schema: jsonSchema } },
    }),
  });
  const body = await response.json() as { id?:string; output?: { content?: { type?:string;text?:string }[] }[]; usage?: { input_tokens?:number;output_tokens?:number;total_tokens?:number }; error?: { code?:string;message?:string } };
  if (!response.ok) throw new Error(`OpenAI ${response.status}: ${body.error?.message ?? "request failed"}`);
  const text = outputText(body);
  if (!text) throw new Error("AI response did not contain structured output");
  const parsed = outputSchema.parse(JSON.parse(text));
  return { candidates: parsed.candidates, provider:"openai", model, requestId:body.id ?? null,
    usage:{input:body.usage?.input_tokens??0,output:body.usage?.output_tokens??0,total:body.usage?.total_tokens??0},
    latencyMs:Date.now()-started,raw:parsed };
}

export function fallbackExtraction(input: ExtractionInput): Extraction {
  const present = (value?:string|null) => value ? .7 : 0;
  return { source_item_id:input.id, product_code:input.existing.product_code ?? null, title:input.existing.title ?? null,
    actress_name:input.existing.actress_name ?? null, maker_name:input.existing.maker_name ?? null, series_name:input.existing.series_name ?? null,
    confidence:input.existing.product_code ? .62 : .2,
    field_confidence:{product_code:input.existing.product_code?.match(/^[A-Z]+-\d+$/) ? .85 : present(input.existing.product_code),
      title:present(input.existing.title),actress_name:present(input.existing.actress_name),maker_name:present(input.existing.maker_name),series_name:present(input.existing.series_name)} };
}
