export type Actress = { id: string; name: string; name_kana: string | null; profile_url: string | null; created_at: string };
export type Maker = { id: string; name: string; official_url: string | null; created_at: string };
export type Tag = { id: string; name: string; created_at: string };
export type Work = {
  id: string;
  product_code: string;
  title: string;
  actress_id: string | null;
  maker_id: string | null;
  release_date: string | null;
  thumbnail_url: string | null;
  sample_url: string | null;
  affiliate_url: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
};
export type WorkDetail = Work & {
  series_name?: string | null;
  label_name?: string | null;
  genre?: string | null;
  duration?: number | null;
  sample_images?: string[];
  popularity?: number;
  favorite_count?: number;
  actresses: Pick<Actress, "id" | "name" | "name_kana" | "profile_url"> | null;
  makers: Pick<Maker, "id" | "name" | "official_url"> | null;
  work_tags: { tags: Pick<Tag, "id" | "name"> | null }[];
};
export type PopularWork = WorkDetail & { search_count: number };
export type Video = {
  id: string;
  product_code: string;
  title: string;
  actress_name: string | null;
  maker_name: string | null;
  series_name: string | null;
  label_name: string | null;
  genre: string | null;
  duration: number | null;
  release_date: string | null;
  sample_images: string[];
  thumbnail_url: string | null;
  video_url: string | null;
  affiliate_url: string | null;
  description: string | null;
  popularity: number;
  favorite_count: number;
  created_at: string;
  updated_at: string;
};

type Table<Row, Insert = Partial<Row>> = {
  Row: Row;
  Insert: Insert;
  Update: Partial<Row>;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      actresses: Table<Actress>;
      makers: Table<Maker>;
      tags: Table<Tag>;
      works: Table<Work>;
      videos: Table<Video, Omit<Video, "id" | "created_at" | "updated_at"> & { id?: string; created_at?: string; updated_at?: string }>;
      import_jobs: Table<{
        id: string; user_id: string; file_name: string; file_size: number; status: string;
        processed_count: number; imported_count: number; failed_count: number;
        duplicate_count: number; total_count: number | null; file_fingerprint: string | null;
        last_error: string | null; errors: unknown[]; created_at: string; updated_at: string;
      }>;
      import_errors: Table<{
        id: number; job_id: string; row_number: number; product_code: string | null;
        message: string; raw_data: unknown | null; created_at: string;
      }, {
        id?: number; job_id: string; row_number: number; product_code?: string | null;
        message: string; raw_data?: unknown | null; created_at?: string;
      }>;
      affiliate_clicks: Table<{
        id: number; product_code: string; store: string | null; destination_url: string | null;
        referrer: string | null; user_agent: string | null; created_at: string;
      }, {
        id?: number; product_code: string; store?: string | null; destination_url?: string | null;
        referrer?: string | null; user_agent?: string | null; created_at?: string;
      }>;
      source_items: Table<{
        id: number; source: string; source_key: string; source_url: string | null; observed_at: string;
        product_code: string | null; title: string | null; actress_name: string | null; maker_name: string | null;
        series_name: string | null; tags: string[]; payload: unknown; status: string; error_message: string | null;
        extraction_status: string; extraction_provider: string | null; extraction_model: string | null;
        confidence: number | null; field_confidence: unknown; duplicate_of: number | null; duplicate_video_id: string | null;
        review_bucket: string;
        extracted_at: string | null; reviewed_at: string | null; reviewed_by: string | null;
        created_at: string; updated_at: string;
      }>;
      ai_extraction_runs: Table<{
        id: string; source_item_id: number | null; provider: string; model: string; status: string;
        request_id: string | null; input_tokens: number; output_tokens: number; total_tokens: number;
        latency_ms: number; estimated_cost: number | null; error_code: string | null; error_message: string | null;
        raw_output: unknown; created_at: string;
      }>;
      ai_correction_examples: Table<{
        id: number; source_item_id: number; input_text: string; model_output: unknown; corrected_output: unknown;
        changed_fields: string[]; reviewer_id: string | null; decision: string; created_at: string;
      }>;
      media_analysis_jobs: Table<{
        id: string; source_item_id: number; media_type: string; media_url: string; status: string;
        provider: string | null; model: string | null; result: unknown; confidence: number | null;
        error_message: string | null; attempts: number; next_attempt_at: string | null; created_at: string; updated_at: string;
      }>;
      ai_quality_settings: Table<{
        id:boolean;high_threshold:number;medium_threshold:number;auto_approve_enabled:boolean;auto_approve_threshold:number;
        minimum_evaluated_samples:number;minimum_precision:number;updated_by:string|null;updated_at:string;
      }>;
      ai_quality_snapshots: Table<{
        id:number;model:string;sample_count:number;approved_count:number;rejected_count:number;corrected_count:number;
        approval_rate:number|null;correction_rate:number|null;average_confidence:number|null;high_confidence_precision:number|null;
        passed_gate:boolean;calculated_at:string;
      }>;
      affiliate_settings: Table<{id:boolean;enabled:boolean;url_template:string|null;affiliate_id:string|null;updated_by:string|null;updated_at:string}>;
      entity_aliases: Table<{id:number;entity_type:string;canonical_name:string;alias:string;normalized_alias:string;created_at:string}>;
      site_settings: Table<{id:boolean;site_name:string;default_title:string;default_description:string;canonical_base_url:string|null;og_image_url:string|null;robots_index:boolean;updated_by:string|null;updated_at:string}>;
      system_error_logs: Table<{id:number;source:string;severity:string;code:string|null;message:string;context:unknown;resolved_at:string|null;created_at:string}>;
      backup_jobs: Table<{id:string;kind:string;status:string;requested_by:string|null;object_path:string|null;metadata:unknown;error_message:string|null;created_at:string;completed_at:string|null}>;
      discovery_metrics: Table<{
        entity_type: string; entity_key: string; period: string; views: number; searches: number;
        clicks: number; score: number; rank: number | null; metadata: unknown; calculated_at: string;
      }>;
      video_tags: Table<{ video_id: string; tag_id: string }, { video_id: string; tag_id: string }>;
      collection_sources: Table<{
        id: string; source: string; query: string; enabled: boolean; since_id: string | null;
        next_run_at: string | null; last_run_at: string | null; last_error: string | null;
        created_at: string; updated_at: string;
      }>;
      collection_runs: Table<{
        id: string; source: string; status: string; fetched_count: number; accepted_count: number;
        duplicate_count: number; error_message: string | null; started_at: string; finished_at: string | null;
      }>;
      x_reply_requests: Table<{
        id: string; request_key: string; product_code: string; reply_text: string; source_tweet_id: string | null; created_at: string;
      }>;
      work_tags: Table<{ work_id: string; tag_id: string }, { work_id: string; tag_id: string }>;
      search_logs: Table<
        { id: string; product_code: string; source: string; user_agent: string | null; referrer: string | null; created_at: string },
        { id?: string; product_code: string; source?: string; user_agent?: string | null; referrer?: string | null; created_at?: string }
      >;
    };
    Views: Record<string, never>;
    Functions: {
      get_popular_works: {
        Args: { result_limit?: number };
        Returns: { product_code: string; search_count: number }[];
      };
      get_popular_works_period: {
        Args: { period_days?: number | null; result_limit?: number; result_offset?: number };
        Returns: { product_code: string; search_count: number }[];
      };
      search_videos: {
        Args: { search_query: string; sort_by?: string; result_limit?: number; result_offset?: number };
        Returns: Video[];
      };
      get_actress_works: {
        Args: { target_actress: string; search_query?: string; sort_by?: string; result_limit?: number; result_offset?: number };
        Returns: Video[];
      };
      count_actress_works: {
        Args: { target_actress: string; search_query?: string };
        Returns: number;
      };
      get_actress_stats: {
        Args: { target_actress: string };
        Returns: { work_count: number; maker_count: number }[];
      };
      get_same_maker_actresses: {
        Args: { target_actress: string; result_limit?: number };
        Returns: { actress_name: string; work_count: number; popularity: number }[];
      };
      get_related_actresses: {
        Args: { target_actress: string; result_limit?: number };
        Returns: { actress_name: string; work_count: number; popularity: number }[];
      };
      refresh_discovery_metrics: { Args: Record<PropertyKey, never>; Returns: undefined };
      claim_source_items_for_extraction: {
        Args: { batch_size?: number };
        Returns: Database["public"]["Tables"]["source_items"]["Row"][];
      };
      find_candidate_duplicate: {
        Args: { candidate_code: string; exclude_source_id: number };
        Returns: { duplicate_source_id: number | null; duplicate_video_id: string | null }[];
      };
      get_admin_operations_metrics: {
        Args: Record<PropertyKey, never>;
        Returns: { collected:number;candidates:number;approved:number;rejected:number;duplicates:number;errors:number;ai_requests:number;input_tokens:number;output_tokens:number;affiliate_clicks:number }[];
      };
      refresh_keyword_metrics: { Args: Record<PropertyKey, never>; Returns: undefined };
      classify_source_candidate: {
        Args:{candidate_confidence:number;has_duplicate:boolean;has_code:boolean;has_title:boolean};
        Returns:string;
      };
      refresh_ai_quality_snapshot: {
        Args:Record<PropertyKey,never>;
        Returns:Database["public"]["Tables"]["ai_quality_snapshots"]["Row"];
      };
      apply_affiliate_template:{Args:{batch_limit?:number};Returns:number};
      sync_catalog_dimensions:{Args:Record<PropertyKey,never>;Returns:undefined};
      get_catalog_makers:{Args:{result_limit?:number;result_offset?:number};Returns:{name:string;work_count:number;popularity:number}[]};
      get_catalog_genres:{Args:{result_limit?:number;result_offset?:number};Returns:{name:string;work_count:number;popularity:number}[]};
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
