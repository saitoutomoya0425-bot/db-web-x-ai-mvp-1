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
  official_url?: string | null;
  affiliate_url: string | null;
  source_name?: string | null;
  external_product_id?: string | null;
  source_checked_at?: string | null;
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
  card_thumbnail_url?: string | null;
  popularity?: number;
  favorite_count?: number;
  actresses: Pick<Actress, "id" | "name" | "name_kana" | "profile_url"> | null;
  actress_list?: Pick<Actress, "id" | "name" | "name_kana" | "profile_url">[];
  makers: Pick<Maker, "id" | "name" | "official_url"> | null;
  work_tags: { tags: Pick<Tag, "id" | "name"> | null }[];
};
export type PopularWork = WorkDetail & { search_count: number };
export type Video = {
  id: string;
  product_code: string;
  title: string;
  actress_id: string | null;
  maker_id: string | null;
  series_id: string | null;
  actress_name: string | null;
  maker_name: string | null;
  series_name: string | null;
  label_name: string | null;
  genre: string | null;
  duration: number | null;
  release_date: string | null;
  sample_images: string[];
  card_thumbnail_url: string | null;
  thumbnail_url: string | null;
  video_url: string | null;
  official_url: string | null;
  affiliate_url: string | null;
  source_name: string | null;
  external_product_id: string | null;
  source_checked_at: string | null;
  description: string | null;
  popularity: number;
  favorite_count: number;
  is_published: boolean;
  content_category: "commercial_av" | "creator" | "doujin";
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
      videos: Table<Video,
        Omit<Video, "id" | "created_at" | "updated_at" | "actress_id" | "maker_id" | "series_id" | "is_published" | "content_category" | "official_url" | "source_name" | "external_product_id" | "source_checked_at" | "card_thumbnail_url"> &
        { id?: string; actress_id?: string | null; maker_id?: string | null; series_id?: string | null;
          is_published?: boolean; content_category?: "commercial_av" | "creator" | "doujin";
          official_url?: string | null; source_name?: string | null; external_product_id?: string | null;
          card_thumbnail_url?: string | null;
          source_checked_at?: string | null; created_at?: string; updated_at?: string }
      >;
      contact_messages: Table<{
        id:string;name:string;email:string;subject:string;message:string;status:string;
        user_agent:string|null;referrer:string|null;created_at:string;
      },{id?:string;name:string;email:string;subject:string;message:string;status?:string;user_agent?:string|null;referrer?:string|null;created_at?:string}>;
      import_jobs: Table<{
        id: string; user_id: string; file_name: string; file_size: number; status: string;
        processed_count: number; imported_count: number; failed_count: number;
        duplicate_count: number; updated_count: number; total_count: number | null; file_fingerprint: string | null;
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
        referrer: string | null; user_agent: string | null; video_id: string | null;
        session_id: string | null; source: string | null; created_at: string;
      }, {
        id?: number; product_code: string; store?: string | null; destination_url?: string | null;
        referrer?: string | null; user_agent?: string | null; video_id?: string | null;
        session_id?: string | null; source?: string | null; created_at?: string;
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
      video_actresses: Table<
        {video_id:string;actress_id:string;position:number;created_at:string},
        {video_id:string;actress_id:string;position?:number;created_at?:string}
      >;
      series: Table<{id:string;name:string;maker_id:string|null;created_at:string}>;
      genres: Table<{id:string;name:string;created_at:string}>;
      video_genres: Table<{video_id:string;genre_id:string},{video_id:string;genre_id:string}>;
      data_sources: Table<{
        id:string;name:string;source_type:string;priority:number;terms_note:string|null;
        is_active:boolean;created_at:string;updated_at:string;
      }>;
      source_products: Table<{
        id:string;data_source_id:string;external_product_id:string;product_code:string|null;
        original_product_code:string|null;normalized_product_code:string|null;normalized_data:unknown;
        preview_status:string;review_status:string;duplicate_video_id:string|null;promoted_video_id:string|null;
        reviewed_at:string|null;reviewed_by:string|null;error_message:string|null;
        raw_payload:unknown;payload_hash:string|null;fetched_at:string;
        import_job_id:string|null;attempt_count:number;last_attempt_at:string|null;next_retry_at:string|null;
        created_at:string;updated_at:string;
      }>;
      fanza_import_jobs: Table<{
        id:string;requested_by:string|null;data_source_id:string;status:string;keyword:string|null;
        page_size:number;max_items:number;next_offset:number;processed_count:number;staged_count:number;
        unchanged_count:number;duplicate_count:number;needs_review_count:number;failed_count:number;
        retry_count:number;dry_run:boolean;last_error:string|null;started_at:string|null;completed_at:string|null;
        created_at:string;updated_at:string;
      }>;
      fanza_import_errors: Table<{
        id:number;job_id:string;external_product_id:string|null;original_product_code:string|null;
        api_offset:number|null;processing_stage:string;error_type:string;attempt_count:number;
        error_code:string|null;message:string;raw_payload:unknown|null;retryable:boolean;
        resolved_at:string|null;created_at:string;
      }>;
      product_offers: Table<{
        id:string;video_id:string;data_source_id:string;external_product_id:string;seller_name:string;
        official_url:string|null;affiliate_url:string|null;price:number|null;currency:string;
        availability_status:string;last_checked_at:string|null;source_product_id:string|null;created_at:string;updated_at:string;
      }>;
      video_source_links: Table<{
        id:string;video_id:string;source_product_id:string;confidence:number|null;created_at:string;
      }>;
      video_change_logs: Table<{
        id:number;video_id:string;changed_fields:string[];before_data:unknown;after_data:unknown;
        change_source:string;created_at:string;
      }>;
      video_page_views: Table<{
        id:number;video_id:string;session_id:string|null;referrer:string|null;source:string;created_at:string;
      },{id?:number;video_id:string;session_id?:string|null;referrer?:string|null;source?:string;created_at?:string}>;
      related_video_clicks: Table<{
        id:number;video_id:string;related_video_id:string;session_id:string|null;referrer:string|null;source:string;created_at:string;
      },{id?:number;video_id:string;related_video_id:string;session_id?:string|null;referrer?:string|null;source?:string;created_at?:string}>;
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
        { id: string; product_code: string; source: string; user_agent: string | null; referrer: string | null; session_id:string|null; created_at: string },
        { id?: string; product_code: string; source?: string; user_agent?: string | null; referrer?: string | null; session_id?:string|null; created_at?: string }
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
      match_videos_for_import:{
        Args:{external_ids:string[];normalized_codes:string[]};
        Returns:Video[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
