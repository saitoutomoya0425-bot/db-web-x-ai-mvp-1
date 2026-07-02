export type QualitySettings={
  high_threshold:number;medium_threshold:number;auto_approve_enabled:boolean;
  auto_approve_threshold:number;minimum_evaluated_samples:number;minimum_precision:number;
};
export type ReviewBucket="high"|"medium"|"low"|"duplicate"|"invalid";
export function classifyCandidate(input:{confidence:number;hasDuplicate:boolean;hasCode:boolean;hasTitle:boolean},settings:Pick<QualitySettings,"high_threshold"|"medium_threshold">):ReviewBucket {
  if(input.hasDuplicate)return "duplicate";
  if(!input.hasCode||!input.hasTitle)return "invalid";
  if(input.confidence>=settings.high_threshold)return "high";
  if(input.confidence>=settings.medium_threshold)return "medium";
  return "low";
}
export function canAutoApprove(input:{confidence:number;hasDuplicate:boolean;hasCode:boolean;hasTitle:boolean;qualityGatePassed:boolean},settings:QualitySettings){
  return settings.auto_approve_enabled&&input.qualityGatePassed&&!input.hasDuplicate&&input.hasCode&&input.hasTitle&&input.confidence>=settings.auto_approve_threshold;
}
