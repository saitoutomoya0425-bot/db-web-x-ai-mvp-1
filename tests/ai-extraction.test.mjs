import test from "node:test";
import assert from "node:assert/strict";
import { fallbackExtraction } from "../src/lib/ai/extraction.ts";
import { canAutoApprove, classifyCandidate } from "../src/lib/ai/quality.ts";

test("fallback extraction preserves normalized candidate and emits bounded confidence", () => {
  const result = fallbackExtraction({
    id: 42,
    text: "品番 IPX-123",
    existing: { product_code: "IPX-123", actress_name: "テスト女優" },
  });
  assert.equal(result.source_item_id, 42);
  assert.equal(result.product_code, "IPX-123");
  assert.equal(result.actress_name, "テスト女優");
  assert.ok(result.confidence >= 0 && result.confidence <= 1);
  assert.ok(result.field_confidence.product_code >= result.field_confidence.actress_name);
});

test("fallback extraction does not invent missing entities", () => {
  const result = fallbackExtraction({ id: 7, text: "情報なし", existing: {} });
  assert.equal(result.product_code, null);
  assert.equal(result.title, null);
  assert.equal(result.actress_name, null);
});

const settings={high_threshold:.9,medium_threshold:.65,auto_approve_enabled:true,auto_approve_threshold:.98,minimum_evaluated_samples:200,minimum_precision:.98};
test("quality routing prioritizes duplicate and invalid candidates",()=>{
  assert.equal(classifyCandidate({confidence:.99,hasDuplicate:true,hasCode:true,hasTitle:true},settings),"duplicate");
  assert.equal(classifyCandidate({confidence:.99,hasDuplicate:false,hasCode:true,hasTitle:false},settings),"invalid");
  assert.equal(classifyCandidate({confidence:.91,hasDuplicate:false,hasCode:true,hasTitle:true},settings),"high");
});
test("automatic approval requires every safety gate",()=>{
  assert.equal(canAutoApprove({confidence:.99,hasDuplicate:false,hasCode:true,hasTitle:true,qualityGatePassed:true},settings),true);
  assert.equal(canAutoApprove({confidence:.99,hasDuplicate:true,hasCode:true,hasTitle:true,qualityGatePassed:true},settings),false);
  assert.equal(canAutoApprove({confidence:.99,hasDuplicate:false,hasCode:true,hasTitle:true,qualityGatePassed:false},settings),false);
});
