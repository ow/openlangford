
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "agenda_item_topics": {
                  Row: {
                    "agenda_item_id": number,"topic_id": number
                  }
                  ComputedFields: never
                  Insert: {
                    "agenda_item_id": number,"topic_id": number
                  }
                  Update: {
                    "agenda_item_id"?: number,"topic_id"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "agenda_item_topics_agenda_item_id_fkey"
      columns: ["agenda_item_id"]
isOneToOne: false
      referencedRelation: "agenda_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "agenda_item_topics_topic_id_fkey"
      columns: ["topic_id"]
isOneToOne: false
      referencedRelation: "topics"
      referencedColumns: ["id"]
    }
                  ]
                },"agenda_items": {
                  Row: {
                    "category": string | null,"created_at": string,"debate_summary": string | null,"description": string | null,"discussion_end_time": number | null,"discussion_start_time": number | null,"embedding": unknown,"financial_cost": number | null,"funding_source": string | null,"geo_location": Json | null,"id": number,"is_consent_agenda": boolean | null,"is_controversial": boolean | null,"item_order": string | null,"keywords": (string)[] | null,"matter_id": number | null,"matter_status_snapshot": string | null,"meeting_id": number,"meta": Json | null,"neighborhood": string | null,"parent_id": number | null,"plain_english_summary": string | null,"related_address": string | null,"slug": string,"source_file": string | null,"text_search": unknown,"title": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "category"?: string | null,"created_at"?: string,"debate_summary"?: string | null,"description"?: string | null,"discussion_end_time"?: number | null,"discussion_start_time"?: number | null,"embedding"?: unknown,"financial_cost"?: number | null,"funding_source"?: string | null,"geo_location"?: Json | null,"id"?: number,"is_consent_agenda"?: boolean | null,"is_controversial"?: boolean | null,"item_order"?: string | null,"keywords"?: (string)[] | null,"matter_id"?: number | null,"matter_status_snapshot"?: string | null,"meeting_id": number,"meta"?: Json | null,"neighborhood"?: string | null,"parent_id"?: number | null,"plain_english_summary"?: string | null,"related_address"?: string | null,"slug": string,"source_file"?: string | null,"text_search"?: never,"title": string,"updated_at"?: string
                  }
                  Update: {
                    "category"?: string | null,"created_at"?: string,"debate_summary"?: string | null,"description"?: string | null,"discussion_end_time"?: number | null,"discussion_start_time"?: number | null,"embedding"?: unknown,"financial_cost"?: number | null,"funding_source"?: string | null,"geo_location"?: Json | null,"id"?: number,"is_consent_agenda"?: boolean | null,"is_controversial"?: boolean | null,"item_order"?: string | null,"keywords"?: (string)[] | null,"matter_id"?: number | null,"matter_status_snapshot"?: string | null,"meeting_id"?: number,"meta"?: Json | null,"neighborhood"?: string | null,"parent_id"?: number | null,"plain_english_summary"?: string | null,"related_address"?: string | null,"slug"?: string,"source_file"?: string | null,"text_search"?: never,"title"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "agenda_items_matter_id_fkey"
      columns: ["matter_id"]
isOneToOne: false
      referencedRelation: "matters"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "agenda_items_meeting_id_fkey"
      columns: ["meeting_id"]
isOneToOne: false
      referencedRelation: "meetings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "agenda_items_parent_id_fkey"
      columns: ["parent_id"]
isOneToOne: false
      referencedRelation: "agenda_items"
      referencedColumns: ["id"]
    }
                  ]
                },"ai_usage": {
                  Row: {
                    "attempts": number | null,"created_at": string,"error": string | null,"id": number,"input_tokens": number | null,"job": string | null,"latency_ms": number | null,"meeting_id": number | null,"model": string,"ok": boolean,"operation": string | null,"output_tokens": number | null,"pipeline_job_id": number | null,"request_id": string | null,"source": string,"stage": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts"?: number | null,"created_at"?: string,"error"?: string | null,"id"?: number,"input_tokens"?: number | null,"job"?: string | null,"latency_ms"?: number | null,"meeting_id"?: number | null,"model": string,"ok": boolean,"operation"?: string | null,"output_tokens"?: number | null,"pipeline_job_id"?: number | null,"request_id"?: string | null,"source": string,"stage": string
                  }
                  Update: {
                    "attempts"?: number | null,"created_at"?: string,"error"?: string | null,"id"?: number,"input_tokens"?: number | null,"job"?: string | null,"latency_ms"?: number | null,"meeting_id"?: number | null,"model"?: string,"ok"?: boolean,"operation"?: string | null,"output_tokens"?: number | null,"pipeline_job_id"?: number | null,"request_id"?: string | null,"source"?: string,"stage"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "ai_usage_pipeline_job_id_fkey"
      columns: ["pipeline_job_id"]
isOneToOne: false
      referencedRelation: "pipeline_jobs"
      referencedColumns: ["id"]
    }
                  ]
                },"ai_usage_daily": {
                  Row: {
                    "calls": number,"day": string,"failures": number,"input_tokens": number,"latency_ms": number,"model": string,"operation": string,"output_tokens": number,"source": string,"stage": string
                  }
                  ComputedFields: never
                  Insert: {
                    "calls"?: number,"day": string,"failures"?: number,"input_tokens"?: number,"latency_ms"?: number,"model"?: string,"operation"?: string,"output_tokens"?: number,"source"?: string,"stage"?: string
                  }
                  Update: {
                    "calls"?: number,"day"?: string,"failures"?: number,"input_tokens"?: number,"latency_ms"?: number,"model"?: string,"operation"?: string,"output_tokens"?: number,"source"?: string,"stage"?: string
                  }
                  Relationships: [
                    
                  ]
                },"api_keys": {
                  Row: {
                    "created_at": string,"id": string,"is_active": boolean,"key_hash": string,"key_prefix": string,"last_used_at": string | null,"name": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"is_active"?: boolean,"key_hash": string,"key_prefix": string,"last_used_at"?: string | null,"name"?: string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"is_active"?: boolean,"key_hash"?: string,"key_prefix"?: string,"last_used_at"?: string | null,"name"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"attendance": {
                  Row: {
                    "arrival_time": string | null,"attendance_mode": string | null,"created_at": string,"departure_time": string | null,"id": number,"meeting_id": number,"notes": string | null,"person_id": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "arrival_time"?: string | null,"attendance_mode"?: string | null,"created_at"?: string,"departure_time"?: string | null,"id"?: number,"meeting_id": number,"notes"?: string | null,"person_id": number,"updated_at"?: string
                  }
                  Update: {
                    "arrival_time"?: string | null,"attendance_mode"?: string | null,"created_at"?: string,"departure_time"?: string | null,"id"?: number,"meeting_id"?: number,"notes"?: string | null,"person_id"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "attendance_meeting_id_fkey"
      columns: ["meeting_id"]
isOneToOne: false
      referencedRelation: "meetings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "attendance_person_id_fkey"
      columns: ["person_id"]
isOneToOne: false
      referencedRelation: "people"
      referencedColumns: ["id"]
    }
                  ]
                },"bylaw_chunks": {
                  Row: {
                    "bylaw_id": number,"chunk_index": number,"created_at": string,"embedding": unknown,"id": number,"text_content": string,"text_search": unknown
                  }
                  ComputedFields: never
                  Insert: {
                    "bylaw_id": number,"chunk_index": number,"created_at"?: string,"embedding"?: unknown,"id"?: number,"text_content": string,"text_search"?: never
                  }
                  Update: {
                    "bylaw_id"?: number,"chunk_index"?: number,"created_at"?: string,"embedding"?: unknown,"id"?: number,"text_content"?: string,"text_search"?: never
                  }
                  Relationships: [
                    {
      foreignKeyName: "bylaw_chunks_bylaw_id_fkey"
      columns: ["bylaw_id"]
isOneToOne: false
      referencedRelation: "bylaws"
      referencedColumns: ["id"]
    }
                  ]
                },"bylaws": {
                  Row: {
                    "bylaw_number": string | null,"category": string | null,"created_at": string,"embedding": unknown,"file_path": string | null,"full_text": string | null,"id": number,"meta": NonNullable<Json>,"municipality_id": number | null,"plain_english_summary": string | null,"slug": string,"source_url": string | null,"status": string | null,"title": string,"updated_at": string,"year": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "bylaw_number"?: string | null,"category"?: string | null,"created_at"?: string,"embedding"?: unknown,"file_path"?: string | null,"full_text"?: string | null,"id"?: number,"meta"?: NonNullable<Json>,"municipality_id"?: number | null,"plain_english_summary"?: string | null,"slug": string,"source_url"?: string | null,"status"?: string | null,"title": string,"updated_at"?: string,"year"?: number | null
                  }
                  Update: {
                    "bylaw_number"?: string | null,"category"?: string | null,"created_at"?: string,"embedding"?: unknown,"file_path"?: string | null,"full_text"?: string | null,"id"?: number,"meta"?: NonNullable<Json>,"municipality_id"?: number | null,"plain_english_summary"?: string | null,"slug"?: string,"source_url"?: string | null,"status"?: string | null,"title"?: string,"updated_at"?: string,"year"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "bylaws_municipality_id_fkey"
      columns: ["municipality_id"]
isOneToOne: false
      referencedRelation: "municipalities"
      referencedColumns: ["id"]
    }
                  ]
                },"calendar_sync_state": {
                  Row: {
                    "finished_at": string | null,"last_error": string | null,"last_trigger": string,"lease_until": string | null,"municipality_id": number,"result": NonNullable<Json>,"started_at": string | null,"status": string,"token": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "finished_at"?: string | null,"last_error"?: string | null,"last_trigger"?: string,"lease_until"?: string | null,"municipality_id": number,"result"?: NonNullable<Json>,"started_at"?: string | null,"status": string,"token"?: string | null
                  }
                  Update: {
                    "finished_at"?: string | null,"last_error"?: string | null,"last_trigger"?: string,"lease_until"?: string | null,"municipality_id"?: number,"result"?: NonNullable<Json>,"started_at"?: string | null,"status"?: string,"token"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "calendar_sync_state_municipality_id_fkey"
      columns: ["municipality_id"]
isOneToOne: true
      referencedRelation: "municipalities"
      referencedColumns: ["id"]
    }
                  ]
                },"candidacies": {
                  Row: {
                    "created_at": string,"election_office_id": number,"id": number,"is_acclaimed": boolean | null,"is_elected": boolean | null,"meta": Json | null,"person_id": number,"updated_at": string,"votes_received": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"election_office_id": number,"id"?: number,"is_acclaimed"?: boolean | null,"is_elected"?: boolean | null,"meta"?: Json | null,"person_id": number,"updated_at"?: string,"votes_received"?: number | null
                  }
                  Update: {
                    "created_at"?: string,"election_office_id"?: number,"id"?: number,"is_acclaimed"?: boolean | null,"is_elected"?: boolean | null,"meta"?: Json | null,"person_id"?: number,"updated_at"?: string,"votes_received"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "candidacies_election_office_id_fkey"
      columns: ["election_office_id"]
isOneToOne: false
      referencedRelation: "election_offices"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "candidacies_person_id_fkey"
      columns: ["person_id"]
isOneToOne: false
      referencedRelation: "people"
      referencedColumns: ["id"]
    }
                  ]
                },"channel_posts": {
                  Row: {
                    "attempts": number,"channel": string,"created_at": string,"last_error": string | null,"meeting_id": number,"message_id": string | null,"payload_hash": string | null,"posted_at": string | null,"status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts"?: number,"channel": string,"created_at"?: string,"last_error"?: string | null,"meeting_id": number,"message_id"?: string | null,"payload_hash"?: string | null,"posted_at"?: string | null,"status": string,"updated_at"?: string
                  }
                  Update: {
                    "attempts"?: number,"channel"?: string,"created_at"?: string,"last_error"?: string | null,"meeting_id"?: number,"message_id"?: string | null,"payload_hash"?: string | null,"posted_at"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "channel_posts_meeting_id_fkey"
      columns: ["meeting_id"]
isOneToOne: false
      referencedRelation: "meetings"
      referencedColumns: ["id"]
    }
                  ]
                },"contact_messages": {
                  Row: {
                    "client_ip": string | null,"created_at": string | null,"email": string,"handled_at": string | null,"handled_by": string | null,"id": string,"message": string,"name": string | null,"notified_at": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "client_ip"?: string | null,"created_at"?: string | null,"email": string,"handled_at"?: string | null,"handled_by"?: string | null,"id"?: string,"message": string,"name"?: string | null,"notified_at"?: string | null
                  }
                  Update: {
                    "client_ip"?: string | null,"created_at"?: string | null,"email"?: string,"handled_at"?: string | null,"handled_by"?: string | null,"id"?: string,"message"?: string,"name"?: string | null,"notified_at"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"council_terms": {
                  Row: {
                    "created_at": string,"election_id": number | null,"end_date": string | null,"id": number,"meta": Json | null,"municipality_id": number,"name": string,"start_date": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"election_id"?: number | null,"end_date"?: string | null,"id"?: number,"meta"?: Json | null,"municipality_id": number,"name": string,"start_date": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"election_id"?: number | null,"end_date"?: string | null,"id"?: number,"meta"?: Json | null,"municipality_id"?: number,"name"?: string,"start_date"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "council_terms_election_id_fkey"
      columns: ["election_id"]
isOneToOne: false
      referencedRelation: "elections"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "council_terms_municipality_id_fkey"
      columns: ["municipality_id"]
isOneToOne: false
      referencedRelation: "municipalities"
      referencedColumns: ["id"]
    }
                  ]
                },"councillor_highlights": {
                  Row: {
                    "approved_at": string | null,"approved_by": string | null,"draft_evidence": Json | null,"draft_generated_at": string | null,"draft_highlights": Json | null,"draft_overview": string | null,"generated_at": string | null,"highlights": Json | null,"id": number,"narrative": string | null,"narrative_generated_at": string | null,"overview": string | null,"person_id": number,"published_stances": Json | null
                  }
                  ComputedFields: never
                  Insert: {
                    "approved_at"?: string | null,"approved_by"?: string | null,"draft_evidence"?: Json | null,"draft_generated_at"?: string | null,"draft_highlights"?: Json | null,"draft_overview"?: string | null,"generated_at"?: string | null,"highlights"?: Json | null,"id"?: number,"narrative"?: string | null,"narrative_generated_at"?: string | null,"overview"?: string | null,"person_id": number,"published_stances"?: Json | null
                  }
                  Update: {
                    "approved_at"?: string | null,"approved_by"?: string | null,"draft_evidence"?: Json | null,"draft_generated_at"?: string | null,"draft_highlights"?: Json | null,"draft_overview"?: string | null,"generated_at"?: string | null,"highlights"?: Json | null,"id"?: number,"narrative"?: string | null,"narrative_generated_at"?: string | null,"overview"?: string | null,"person_id"?: number,"published_stances"?: Json | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "councillor_highlights_person_id_fkey"
      columns: ["person_id"]
isOneToOne: true
      referencedRelation: "people"
      referencedColumns: ["id"]
    }
                  ]
                },"councillor_stances": {
                  Row: {
                    "confidence": string,"created_at": string,"evidence_motion_ids": (number)[] | null,"evidence_quotes": Json | null,"evidence_vote_ids": (number)[] | null,"generated_at": string,"id": number,"person_id": number,"position": string,"position_score": number | null,"statement_count": number,"summary": string,"topic": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "confidence": string,"created_at"?: string,"evidence_motion_ids"?: (number)[] | null,"evidence_quotes"?: Json | null,"evidence_vote_ids"?: (number)[] | null,"generated_at"?: string,"id"?: number,"person_id": number,"position": string,"position_score"?: number | null,"statement_count": number,"summary": string,"topic": string,"updated_at"?: string
                  }
                  Update: {
                    "confidence"?: string,"created_at"?: string,"evidence_motion_ids"?: (number)[] | null,"evidence_quotes"?: Json | null,"evidence_vote_ids"?: (number)[] | null,"generated_at"?: string,"id"?: number,"person_id"?: number,"position"?: string,"position_score"?: number | null,"statement_count"?: number,"summary"?: string,"topic"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "councillor_stances_person_id_fkey"
      columns: ["person_id"]
isOneToOne: false
      referencedRelation: "people"
      referencedColumns: ["id"]
    }
                  ]
                },"data_reports": {
                  Row: {
                    "assessed_at": string | null,"assessment": Json | null,"category": string,"created_at": string,"duplicate_of": number | null,"entry_key": string | null,"id": number,"note": string | null,"notified_at": string | null,"notify_reporter": boolean,"path": string,"quote": string | null,"resolution": string | null,"resolved_at": string | null,"resolved_by": string | null,"source_url": string | null,"status": string,"suggestion": string | null,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "assessed_at"?: string | null,"assessment"?: Json | null,"category": string,"created_at"?: string,"duplicate_of"?: number | null,"entry_key"?: string | null,"id"?: never,"note"?: string | null,"notified_at"?: string | null,"notify_reporter"?: boolean,"path": string,"quote"?: string | null,"resolution"?: string | null,"resolved_at"?: string | null,"resolved_by"?: string | null,"source_url"?: string | null,"status"?: string,"suggestion"?: string | null,"user_id"?: string | null
                  }
                  Update: {
                    "assessed_at"?: string | null,"assessment"?: Json | null,"category"?: string,"created_at"?: string,"duplicate_of"?: number | null,"entry_key"?: string | null,"id"?: never,"note"?: string | null,"notified_at"?: string | null,"notify_reporter"?: boolean,"path"?: string,"quote"?: string | null,"resolution"?: string | null,"resolved_at"?: string | null,"resolved_by"?: string | null,"source_url"?: string | null,"status"?: string,"suggestion"?: string | null,"user_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "data_reports_duplicate_of_fkey"
      columns: ["duplicate_of"]
isOneToOne: false
      referencedRelation: "data_reports"
      referencedColumns: ["id"]
    }
                  ]
                },"document_images": {
                  Row: {
                    "created_at": string,"description": string | null,"document_section_id": number | null,"extracted_document_id": number,"file_size": number | null,"format": string | null,"height": number | null,"id": number,"image_type": string | null,"municipality_id": number | null,"page": number,"r2_key": string,"width": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"description"?: string | null,"document_section_id"?: number | null,"extracted_document_id": number,"file_size"?: number | null,"format"?: string | null,"height"?: number | null,"id"?: number,"image_type"?: string | null,"municipality_id"?: number | null,"page": number,"r2_key": string,"width"?: number | null
                  }
                  Update: {
                    "created_at"?: string,"description"?: string | null,"document_section_id"?: number | null,"extracted_document_id"?: number,"file_size"?: number | null,"format"?: string | null,"height"?: number | null,"id"?: number,"image_type"?: string | null,"municipality_id"?: number | null,"page"?: number,"r2_key"?: string,"width"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "document_images_document_section_id_fkey"
      columns: ["document_section_id"]
isOneToOne: false
      referencedRelation: "document_sections"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "document_images_extracted_document_id_fkey"
      columns: ["extracted_document_id"]
isOneToOne: false
      referencedRelation: "extracted_documents"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "document_images_municipality_id_fkey"
      columns: ["municipality_id"]
isOneToOne: false
      referencedRelation: "municipalities"
      referencedColumns: ["id"]
    }
                  ]
                },"document_sections": {
                  Row: {
                    "agenda_item_id": number | null,"created_at": string,"document_id": number,"embedding": unknown,"extracted_document_id": number | null,"id": number,"municipality_id": number | null,"page_end": number | null,"page_start": number | null,"section_order": number,"section_text": string,"section_title": string | null,"text_search": unknown,"token_count": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "agenda_item_id"?: number | null,"created_at"?: string,"document_id": number,"embedding"?: unknown,"extracted_document_id"?: number | null,"id"?: number,"municipality_id"?: number | null,"page_end"?: number | null,"page_start"?: number | null,"section_order": number,"section_text": string,"section_title"?: string | null,"text_search"?: never,"token_count"?: number | null
                  }
                  Update: {
                    "agenda_item_id"?: number | null,"created_at"?: string,"document_id"?: number,"embedding"?: unknown,"extracted_document_id"?: number | null,"id"?: number,"municipality_id"?: number | null,"page_end"?: number | null,"page_start"?: number | null,"section_order"?: number,"section_text"?: string,"section_title"?: string | null,"text_search"?: never,"token_count"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "document_sections_agenda_item_id_fkey"
      columns: ["agenda_item_id"]
isOneToOne: false
      referencedRelation: "agenda_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "document_sections_document_id_fkey"
      columns: ["document_id"]
isOneToOne: false
      referencedRelation: "documents"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "document_sections_extracted_document_id_fkey"
      columns: ["extracted_document_id"]
isOneToOne: false
      referencedRelation: "extracted_documents"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "document_sections_municipality_id_fkey"
      columns: ["municipality_id"]
isOneToOne: false
      referencedRelation: "municipalities"
      referencedColumns: ["id"]
    }
                  ]
                },"documents": {
                  Row: {
                    "category": string,"created_at": string,"embedding": unknown,"file_hash": string | null,"file_path": string,"full_text": string | null,"id": number,"meeting_id": number,"municipality_id": number | null,"page_count": number | null,"source_url": string | null,"title": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "category"?: string,"created_at"?: string,"embedding"?: unknown,"file_hash"?: string | null,"file_path": string,"full_text"?: string | null,"id"?: number,"meeting_id": number,"municipality_id"?: number | null,"page_count"?: number | null,"source_url"?: string | null,"title": string,"updated_at"?: string
                  }
                  Update: {
                    "category"?: string,"created_at"?: string,"embedding"?: unknown,"file_hash"?: string | null,"file_path"?: string,"full_text"?: string | null,"id"?: number,"meeting_id"?: number,"municipality_id"?: number | null,"page_count"?: number | null,"source_url"?: string | null,"title"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "documents_meeting_id_fkey"
      columns: ["meeting_id"]
isOneToOne: false
      referencedRelation: "meetings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "documents_municipality_id_fkey"
      columns: ["municipality_id"]
isOneToOne: false
      referencedRelation: "municipalities"
      referencedColumns: ["id"]
    }
                  ]
                },"election_offices": {
                  Row: {
                    "created_at": string,"election_id": number,"id": number,"office": string,"seats_available": number | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"election_id": number,"id"?: number,"office": string,"seats_available"?: number | null,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"election_id"?: number,"id"?: number,"office"?: string,"seats_available"?: number | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "election_offices_election_id_fkey"
      columns: ["election_id"]
isOneToOne: false
      referencedRelation: "elections"
      referencedColumns: ["id"]
    }
                  ]
                },"elections": {
                  Row: {
                    "classification": string | null,"created_at": string,"election_date": string,"id": number,"meta": Json | null,"name": string,"notes": string | null,"results_status": string,"slug": string,"source_id": number | null,"source_url": string | null,"term_length_years": number | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "classification"?: string | null,"created_at"?: string,"election_date": string,"id"?: number,"meta"?: Json | null,"name": string,"notes"?: string | null,"results_status"?: string,"slug": string,"source_id"?: number | null,"source_url"?: string | null,"term_length_years"?: number | null,"updated_at"?: string
                  }
                  Update: {
                    "classification"?: string | null,"created_at"?: string,"election_date"?: string,"id"?: number,"meta"?: Json | null,"name"?: string,"notes"?: string | null,"results_status"?: string,"slug"?: string,"source_id"?: number | null,"source_url"?: string | null,"term_length_years"?: number | null,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"email_enqueue_receipts": {
                  Row: {
                    "attempts": number,"first_attempt_at": string,"kind": string,"last_error": string | null,"meeting_id": number,"next_attempt_at": string,"state": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts"?: number,"first_attempt_at"?: string,"kind"?: string,"last_error"?: string | null,"meeting_id": number,"next_attempt_at"?: string,"state": string,"updated_at"?: string
                  }
                  Update: {
                    "attempts"?: number,"first_attempt_at"?: string,"kind"?: string,"last_error"?: string | null,"meeting_id"?: number,"next_attempt_at"?: string,"state"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "email_enqueue_receipts_meeting_id_fkey"
      columns: ["meeting_id"]
isOneToOne: false
      referencedRelation: "meetings"
      referencedColumns: ["id"]
    }
                  ]
                },"email_events": {
                  Row: {
                    "attempt_number": number | null,"error_text": string | null,"event_type": string,"id": string,"message_id": string,"occurred_at": string,"provider_event_id": string | null,"provider_message_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "attempt_number"?: number | null,"error_text"?: string | null,"event_type": string,"id"?: string,"message_id": string,"occurred_at"?: string,"provider_event_id"?: string | null,"provider_message_id"?: string | null
                  }
                  Update: {
                    "attempt_number"?: number | null,"error_text"?: string | null,"event_type"?: string,"id"?: string,"message_id"?: string,"occurred_at"?: string,"provider_event_id"?: string | null,"provider_message_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "email_events_message_id_fkey"
      columns: ["message_id"]
isOneToOne: false
      referencedRelation: "email_messages"
      referencedColumns: ["id"]
    }
                  ]
                },"email_messages": {
                  Row: {
                    "accepted_at": string | null,"attempt_count": number,"consent_at": string | null,"created_at": string,"deduplication_key": string,"delivered_at": string | null,"expires_at": string,"failed_at": string | null,"id": string,"is_test": boolean,"last_error": string | null,"lease_token": string | null,"lease_until": string | null,"meeting_id": number | null,"message_type": string,"next_attempt_at": string,"payload": NonNullable<Json>,"preview_text": string | null,"provider_message_id": string | null,"provider_payload": Json | null,"recipient": string,"status": string,"subject": string,"unsubscribe_token": string,"updated_at": string,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "accepted_at"?: string | null,"attempt_count"?: number,"consent_at"?: string | null,"created_at"?: string,"deduplication_key": string,"delivered_at"?: string | null,"expires_at"?: string,"failed_at"?: string | null,"id"?: string,"is_test"?: boolean,"last_error"?: string | null,"lease_token"?: string | null,"lease_until"?: string | null,"meeting_id"?: number | null,"message_type": string,"next_attempt_at"?: string,"payload"?: NonNullable<Json>,"preview_text"?: string | null,"provider_message_id"?: string | null,"provider_payload"?: Json | null,"recipient": string,"status"?: string,"subject": string,"unsubscribe_token"?: string,"updated_at"?: string,"user_id"?: string | null
                  }
                  Update: {
                    "accepted_at"?: string | null,"attempt_count"?: number,"consent_at"?: string | null,"created_at"?: string,"deduplication_key"?: string,"delivered_at"?: string | null,"expires_at"?: string,"failed_at"?: string | null,"id"?: string,"is_test"?: boolean,"last_error"?: string | null,"lease_token"?: string | null,"lease_until"?: string | null,"meeting_id"?: number | null,"message_type"?: string,"next_attempt_at"?: string,"payload"?: NonNullable<Json>,"preview_text"?: string | null,"provider_message_id"?: string | null,"provider_payload"?: Json | null,"recipient"?: string,"status"?: string,"subject"?: string,"unsubscribe_token"?: string,"updated_at"?: string,"user_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "email_messages_meeting_id_fkey"
      columns: ["meeting_id"]
isOneToOne: false
      referencedRelation: "meetings"
      referencedColumns: ["id"]
    }
                  ]
                },"email_suppressions": {
                  Row: {
                    "created_at": string,"reason": string,"recipient": string,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"reason": string,"recipient": string,"user_id"?: string | null
                  }
                  Update: {
                    "created_at"?: string,"reason"?: string,"recipient"?: string,"user_id"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"extracted_documents": {
                  Row: {
                    "agenda_item_id": number | null,"created_at": string,"document_id": number,"document_type": string,"id": number,"key_facts": Json | null,"municipality_id": number | null,"page_end": number | null,"page_start": number | null,"summary": string | null,"title": string
                  }
                  ComputedFields: never
                  Insert: {
                    "agenda_item_id"?: number | null,"created_at"?: string,"document_id": number,"document_type"?: string,"id"?: number,"key_facts"?: Json | null,"municipality_id"?: number | null,"page_end"?: number | null,"page_start"?: number | null,"summary"?: string | null,"title": string
                  }
                  Update: {
                    "agenda_item_id"?: number | null,"created_at"?: string,"document_id"?: number,"document_type"?: string,"id"?: number,"key_facts"?: Json | null,"municipality_id"?: number | null,"page_end"?: number | null,"page_start"?: number | null,"summary"?: string | null,"title"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "extracted_documents_agenda_item_id_fkey"
      columns: ["agenda_item_id"]
isOneToOne: false
      referencedRelation: "agenda_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "extracted_documents_document_id_fkey"
      columns: ["document_id"]
isOneToOne: false
      referencedRelation: "documents"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "extracted_documents_municipality_id_fkey"
      columns: ["municipality_id"]
isOneToOne: false
      referencedRelation: "municipalities"
      referencedColumns: ["id"]
    }
                  ]
                },"hidden_pages": {
                  Row: {
                    "hidden_at": string,"hidden_by": string | null,"path": string,"record_id": number,"record_table": string
                  }
                  ComputedFields: never
                  Insert: {
                    "hidden_at"?: string,"hidden_by"?: string | null,"path": string,"record_id": number,"record_table": string
                  }
                  Update: {
                    "hidden_at"?: string,"hidden_by"?: string | null,"path"?: string,"record_id"?: number,"record_table"?: string
                  }
                  Relationships: [
                    
                  ]
                },"key_statements": {
                  Row: {
                    "agenda_item_id": number | null,"context": string | null,"created_at": string,"embedding": unknown,"evidence_kind": string | null,"id": number,"meeting_id": number,"municipality_id": number | null,"person_id": number | null,"source_segment_ids": (number)[] | null,"speaker_name": string | null,"start_time": number | null,"statement_text": string,"statement_type": string,"text_search": unknown,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "agenda_item_id"?: number | null,"context"?: string | null,"created_at"?: string,"embedding"?: unknown,"evidence_kind"?: string | null,"id"?: number,"meeting_id": number,"municipality_id"?: number | null,"person_id"?: number | null,"source_segment_ids"?: (number)[] | null,"speaker_name"?: string | null,"start_time"?: number | null,"statement_text": string,"statement_type": string,"text_search"?: never,"updated_at"?: string
                  }
                  Update: {
                    "agenda_item_id"?: number | null,"context"?: string | null,"created_at"?: string,"embedding"?: unknown,"evidence_kind"?: string | null,"id"?: number,"meeting_id"?: number,"municipality_id"?: number | null,"person_id"?: number | null,"source_segment_ids"?: (number)[] | null,"speaker_name"?: string | null,"start_time"?: number | null,"statement_text"?: string,"statement_type"?: string,"text_search"?: never,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "key_statements_agenda_item_id_fkey"
      columns: ["agenda_item_id"]
isOneToOne: false
      referencedRelation: "agenda_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "key_statements_meeting_id_fkey"
      columns: ["meeting_id"]
isOneToOne: false
      referencedRelation: "meetings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "key_statements_municipality_id_fkey"
      columns: ["municipality_id"]
isOneToOne: false
      referencedRelation: "municipalities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "key_statements_person_id_fkey"
      columns: ["person_id"]
isOneToOne: false
      referencedRelation: "people"
      referencedColumns: ["id"]
    }
                  ]
                },"key_votes": {
                  Row: {
                    "ally_breaks": Json | null,"composite_score": number,"context_summary": string | null,"created_at": string,"detection_type": (string)[],"generated_at": string | null,"id": number,"motion_id": number,"person_id": number,"updated_at": string,"vote": string,"vote_split": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "ally_breaks"?: Json | null,"composite_score": number,"context_summary"?: string | null,"created_at"?: string,"detection_type": (string)[],"generated_at"?: string | null,"id"?: number,"motion_id": number,"person_id": number,"updated_at"?: string,"vote": string,"vote_split"?: string | null
                  }
                  Update: {
                    "ally_breaks"?: Json | null,"composite_score"?: number,"context_summary"?: string | null,"created_at"?: string,"detection_type"?: (string)[],"generated_at"?: string | null,"id"?: number,"motion_id"?: number,"person_id"?: number,"updated_at"?: string,"vote"?: string,"vote_split"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "key_votes_motion_id_fkey"
      columns: ["motion_id"]
isOneToOne: false
      referencedRelation: "motions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "key_votes_person_id_fkey"
      columns: ["person_id"]
isOneToOne: false
      referencedRelation: "people"
      referencedColumns: ["id"]
    }
                  ]
                },"matter_evidence": {
                  Row: {
                    "agenda_item_id": number | null,"confidence": number,"created_at": string,"document_section_id": number | null,"evidence_type": string,"hidden": boolean,"id": number,"matter_id": number,"reason": string | null,"review": string | null,"reviewed_at": string | null,"reviewed_by": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "agenda_item_id"?: number | null,"confidence"?: number,"created_at"?: string,"document_section_id"?: number | null,"evidence_type"?: string,"hidden"?: boolean,"id"?: number,"matter_id": number,"reason"?: string | null,"review"?: string | null,"reviewed_at"?: string | null,"reviewed_by"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "agenda_item_id"?: number | null,"confidence"?: number,"created_at"?: string,"document_section_id"?: number | null,"evidence_type"?: string,"hidden"?: boolean,"id"?: number,"matter_id"?: number,"reason"?: string | null,"review"?: string | null,"reviewed_at"?: string | null,"reviewed_by"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "matter_evidence_agenda_item_id_fkey"
      columns: ["agenda_item_id"]
isOneToOne: false
      referencedRelation: "agenda_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "matter_evidence_document_section_id_fkey"
      columns: ["document_section_id"]
isOneToOne: false
      referencedRelation: "document_sections"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "matter_evidence_matter_id_fkey"
      columns: ["matter_id"]
isOneToOne: false
      referencedRelation: "matters"
      referencedColumns: ["id"]
    }
                  ]
                },"matter_links": {
                  Row: {
                    "agenda_item_id": number | null,"confidence": number | null,"created_at": string,"found_in": string | null,"hidden": boolean,"id": number,"kind": string,"matter_id": number,"quote": string | null,"related_matter_id": number | null,"review": string | null,"reviewed_at": string | null,"reviewed_by": string | null,"source": string,"suggest_reason": string | null,"suggested_at": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "agenda_item_id"?: number | null,"confidence"?: number | null,"created_at"?: string,"found_in"?: string | null,"hidden"?: boolean,"id"?: number,"kind": string,"matter_id": number,"quote"?: string | null,"related_matter_id"?: number | null,"review"?: string | null,"reviewed_at"?: string | null,"reviewed_by"?: string | null,"source"?: string,"suggest_reason"?: string | null,"suggested_at"?: string | null
                  }
                  Update: {
                    "agenda_item_id"?: number | null,"confidence"?: number | null,"created_at"?: string,"found_in"?: string | null,"hidden"?: boolean,"id"?: number,"kind"?: string,"matter_id"?: number,"quote"?: string | null,"related_matter_id"?: number | null,"review"?: string | null,"reviewed_at"?: string | null,"reviewed_by"?: string | null,"source"?: string,"suggest_reason"?: string | null,"suggested_at"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "matter_links_agenda_item_id_fkey"
      columns: ["agenda_item_id"]
isOneToOne: false
      referencedRelation: "agenda_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "matter_links_matter_id_fkey"
      columns: ["matter_id"]
isOneToOne: false
      referencedRelation: "matters"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "matter_links_related_matter_id_fkey"
      columns: ["related_matter_id"]
isOneToOne: false
      referencedRelation: "matters"
      referencedColumns: ["id"]
    }
                  ]
                },"matter_merge_proposals": {
                  Row: {
                    "created_at": string,"decided_at": string | null,"decided_by": string | null,"decisions": NonNullable<Json>,"id": number,"matter_ids": (number)[],"source": string,"status": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"decisions"?: NonNullable<Json>,"id"?: number,"matter_ids": (number)[],"source"?: string,"status"?: string
                  }
                  Update: {
                    "created_at"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"decisions"?: NonNullable<Json>,"id"?: number,"matter_ids"?: (number)[],"source"?: string,"status"?: string
                  }
                  Relationships: [
                    
                  ]
                },"matter_merges": {
                  Row: {
                    "alias_ids": (number)[],"canonical_id": number,"id": number,"merged_at": string,"merged_by": string | null,"moved": NonNullable<Json>,"notes": NonNullable<Json>,"reason": string | null,"removed": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "alias_ids": (number)[],"canonical_id": number,"id"?: never,"merged_at"?: string,"merged_by"?: string | null,"moved"?: NonNullable<Json>,"notes"?: NonNullable<Json>,"reason"?: string | null,"removed"?: NonNullable<Json>
                  }
                  Update: {
                    "alias_ids"?: (number)[],"canonical_id"?: number,"id"?: never,"merged_at"?: string,"merged_by"?: string | null,"moved"?: NonNullable<Json>,"notes"?: NonNullable<Json>,"reason"?: string | null,"removed"?: NonNullable<Json>
                  }
                  Relationships: [
                    
                  ]
                },"matter_report_mentions": {
                  Row: {
                    "confidence": number | null,"created_at": string,"hidden": boolean,"id": number,"matter_id": number,"page": number,"quote": string,"report_id": number,"review": string | null,"reviewed_at": string | null,"reviewed_by": string | null,"source": string,"suggest_reason": string | null,"suggested_at": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "confidence"?: number | null,"created_at"?: string,"hidden"?: boolean,"id"?: number,"matter_id": number,"page": number,"quote": string,"report_id": number,"review"?: string | null,"reviewed_at"?: string | null,"reviewed_by"?: string | null,"source"?: string,"suggest_reason"?: string | null,"suggested_at"?: string | null
                  }
                  Update: {
                    "confidence"?: number | null,"created_at"?: string,"hidden"?: boolean,"id"?: number,"matter_id"?: number,"page"?: number,"quote"?: string,"report_id"?: number,"review"?: string | null,"reviewed_at"?: string | null,"reviewed_by"?: string | null,"source"?: string,"suggest_reason"?: string | null,"suggested_at"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "matter_report_mentions_matter_id_fkey"
      columns: ["matter_id"]
isOneToOne: false
      referencedRelation: "matters"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "matter_report_mentions_report_id_fkey"
      columns: ["report_id"]
isOneToOne: false
      referencedRelation: "public_reports"
      referencedColumns: ["id"]
    }
                  ]
                },"matters": {
                  Row: {
                    "bylaw_id": number | null,"category": string | null,"content_updated_at": string | null,"created_at": string,"description": string | null,"embedding": unknown,"first_seen": string | null,"geo_location": Json | null,"id": number,"identifier": string | null,"last_seen": string | null,"merged_into": number | null,"meta": Json | null,"municipality_id": number | null,"plain_english_summary": string | null,"slug": string,"status": string | null,"text_search": unknown,"title": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "bylaw_id"?: number | null,"category"?: string | null,"content_updated_at"?: string | null,"created_at"?: string,"description"?: string | null,"embedding"?: unknown,"first_seen"?: string | null,"geo_location"?: Json | null,"id"?: number,"identifier"?: string | null,"last_seen"?: string | null,"merged_into"?: number | null,"meta"?: Json | null,"municipality_id"?: number | null,"plain_english_summary"?: string | null,"slug": string,"status"?: string | null,"text_search"?: never,"title": string,"updated_at"?: string
                  }
                  Update: {
                    "bylaw_id"?: number | null,"category"?: string | null,"content_updated_at"?: string | null,"created_at"?: string,"description"?: string | null,"embedding"?: unknown,"first_seen"?: string | null,"geo_location"?: Json | null,"id"?: number,"identifier"?: string | null,"last_seen"?: string | null,"merged_into"?: number | null,"meta"?: Json | null,"municipality_id"?: number | null,"plain_english_summary"?: string | null,"slug"?: string,"status"?: string | null,"text_search"?: never,"title"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "matters_bylaw_id_fkey"
      columns: ["bylaw_id"]
isOneToOne: false
      referencedRelation: "bylaws"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "matters_merged_into_fkey"
      columns: ["merged_into"]
isOneToOne: false
      referencedRelation: "matters"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "matters_municipality_id_fkey"
      columns: ["municipality_id"]
isOneToOne: false
      referencedRelation: "municipalities"
      referencedColumns: ["id"]
    }
                  ]
                },"meeting_events": {
                  Row: {
                    "created_at": string,"event_type": string,"id": number,"meeting_id": number,"person_id": number,"time_offset_seconds": number | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"event_type": string,"id"?: number,"meeting_id": number,"person_id": number,"time_offset_seconds"?: number | null,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"event_type"?: string,"id"?: number,"meeting_id"?: number,"person_id"?: number,"time_offset_seconds"?: number | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "meeting_events_meeting_id_fkey"
      columns: ["meeting_id"]
isOneToOne: false
      referencedRelation: "meetings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "meeting_events_person_id_fkey"
      columns: ["person_id"]
isOneToOne: false
      referencedRelation: "people"
      referencedColumns: ["id"]
    }
                  ]
                },"meeting_slug_history": {
                  Row: {
                    "created_at": string,"id": number,"meeting_id": number,"municipality_id": number,"old_slug": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: number,"meeting_id": number,"municipality_id": number,"old_slug": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: number,"meeting_id"?: number,"municipality_id"?: number,"old_slug"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "meeting_slug_history_meeting_id_fkey"
      columns: ["meeting_id"]
isOneToOne: false
      referencedRelation: "meetings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "meeting_slug_history_municipality_id_fkey"
      columns: ["municipality_id"]
isOneToOne: false
      referencedRelation: "municipalities"
      referencedColumns: ["id"]
    }
                  ]
                },"meeting_speaker_aliases": {
                  Row: {
                    "created_at": string,"id": number,"meeting_id": number,"person_id": number,"speaker_label": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: number,"meeting_id": number,"person_id": number,"speaker_label": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: number,"meeting_id"?: number,"person_id"?: number,"speaker_label"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "meeting_speaker_aliases_meeting_id_fkey"
      columns: ["meeting_id"]
isOneToOne: false
      referencedRelation: "meetings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "meeting_speaker_aliases_person_id_fkey"
      columns: ["person_id"]
isOneToOne: false
      referencedRelation: "people"
      referencedColumns: ["id"]
    }
                  ]
                },"meetings": {
                  Row: {
                    "agenda_url": string | null,"archive_path": string | null,"calendar_source_id": number | null,"chair_person_id": number | null,"created_at": string,"embedding": unknown,"has_agenda": boolean | null,"has_minutes": boolean | null,"has_transcript": boolean | null,"id": number,"meeting_date": string,"meta": Json | null,"minutes_url": string | null,"municipality_id": number | null,"organization_id": number | null,"slug": string,"status": string | null,"summary": string | null,"title": string,"type": Database["public"]['Enums']["meeting_type"] | null,"updated_at": string,"video_duration_seconds": number | null,"video_url": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "agenda_url"?: string | null,"archive_path"?: string | null,"calendar_source_id"?: number | null,"chair_person_id"?: number | null,"created_at"?: string,"embedding"?: unknown,"has_agenda"?: boolean | null,"has_minutes"?: boolean | null,"has_transcript"?: boolean | null,"id"?: number,"meeting_date": string,"meta"?: Json | null,"minutes_url"?: string | null,"municipality_id"?: number | null,"organization_id"?: number | null,"slug": string,"status"?: string | null,"summary"?: string | null,"title": string,"type"?: Database["public"]['Enums']["meeting_type"] | null,"updated_at"?: string,"video_duration_seconds"?: number | null,"video_url"?: string | null
                  }
                  Update: {
                    "agenda_url"?: string | null,"archive_path"?: string | null,"calendar_source_id"?: number | null,"chair_person_id"?: number | null,"created_at"?: string,"embedding"?: unknown,"has_agenda"?: boolean | null,"has_minutes"?: boolean | null,"has_transcript"?: boolean | null,"id"?: number,"meeting_date"?: string,"meta"?: Json | null,"minutes_url"?: string | null,"municipality_id"?: number | null,"organization_id"?: number | null,"slug"?: string,"status"?: string | null,"summary"?: string | null,"title"?: string,"type"?: Database["public"]['Enums']["meeting_type"] | null,"updated_at"?: string,"video_duration_seconds"?: number | null,"video_url"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "meetings_calendar_source_id_fkey"
      columns: ["calendar_source_id"]
isOneToOne: false
      referencedRelation: "source_meetings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "meetings_chair_person_id_fkey"
      columns: ["chair_person_id"]
isOneToOne: false
      referencedRelation: "people"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "meetings_municipality_id_fkey"
      columns: ["municipality_id"]
isOneToOne: false
      referencedRelation: "municipalities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "meetings_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"memberships": {
                  Row: {
                    "council_term_id": number | null,"created_at": string,"end_date": string | null,"id": number,"meta": Json | null,"organization_id": number,"person_id": number,"role": string | null,"start_date": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "council_term_id"?: number | null,"created_at"?: string,"end_date"?: string | null,"id"?: number,"meta"?: Json | null,"organization_id": number,"person_id": number,"role"?: string | null,"start_date"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "council_term_id"?: number | null,"created_at"?: string,"end_date"?: string | null,"id"?: number,"meta"?: Json | null,"organization_id"?: number,"person_id"?: number,"role"?: string | null,"start_date"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "memberships_council_term_id_fkey"
      columns: ["council_term_id"]
isOneToOne: false
      referencedRelation: "council_terms"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "memberships_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "memberships_person_id_fkey"
      columns: ["person_id"]
isOneToOne: false
      referencedRelation: "people"
      referencedColumns: ["id"]
    }
                  ]
                },"motions": {
                  Row: {
                    "absent_votes": number | null,"abstain_votes": number | null,"agenda_item_id": number,"created_at": string,"disposition": string | null,"embedding": unknown,"financial_cost": number | null,"funding_source": string | null,"id": number,"meeting_id": number,"meta": Json | null,"mover": string | null,"mover_id": number | null,"no_votes": number | null,"plain_english_summary": string | null,"result": string | null,"seconder": string | null,"seconder_id": number | null,"slug": string,"text_content": string,"text_search": unknown,"time_offset_seconds": number | null,"updated_at": string,"yes_votes": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "absent_votes"?: number | null,"abstain_votes"?: number | null,"agenda_item_id": number,"created_at"?: string,"disposition"?: string | null,"embedding"?: unknown,"financial_cost"?: number | null,"funding_source"?: string | null,"id"?: number,"meeting_id": number,"meta"?: Json | null,"mover"?: string | null,"mover_id"?: number | null,"no_votes"?: number | null,"plain_english_summary"?: string | null,"result"?: string | null,"seconder"?: string | null,"seconder_id"?: number | null,"slug": string,"text_content": string,"text_search"?: never,"time_offset_seconds"?: number | null,"updated_at"?: string,"yes_votes"?: number | null
                  }
                  Update: {
                    "absent_votes"?: number | null,"abstain_votes"?: number | null,"agenda_item_id"?: number,"created_at"?: string,"disposition"?: string | null,"embedding"?: unknown,"financial_cost"?: number | null,"funding_source"?: string | null,"id"?: number,"meeting_id"?: number,"meta"?: Json | null,"mover"?: string | null,"mover_id"?: number | null,"no_votes"?: number | null,"plain_english_summary"?: string | null,"result"?: string | null,"seconder"?: string | null,"seconder_id"?: number | null,"slug"?: string,"text_content"?: string,"text_search"?: never,"time_offset_seconds"?: number | null,"updated_at"?: string,"yes_votes"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "motions_agenda_item_id_fkey"
      columns: ["agenda_item_id"]
isOneToOne: false
      referencedRelation: "agenda_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "motions_meeting_id_fkey"
      columns: ["meeting_id"]
isOneToOne: false
      referencedRelation: "meetings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "motions_mover_id_fkey"
      columns: ["mover_id"]
isOneToOne: false
      referencedRelation: "people"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "motions_seconder_id_fkey"
      columns: ["seconder_id"]
isOneToOne: false
      referencedRelation: "people"
      referencedColumns: ["id"]
    }
                  ]
                },"municipalities": {
                  Row: {
                    "classification": string | null,"contact_email": string | null,"created_at": string,"id": number,"map_center_lat": number | null,"map_center_lng": number | null,"meta": Json | null,"name": string,"ocd_id": string | null,"province": string | null,"rss_url": string | null,"short_name": string,"slug": string,"source_config": NonNullable<Json>,"updated_at": string,"website_url": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "classification"?: string | null,"contact_email"?: string | null,"created_at"?: string,"id"?: number,"map_center_lat"?: number | null,"map_center_lng"?: number | null,"meta"?: Json | null,"name": string,"ocd_id"?: string | null,"province"?: string | null,"rss_url"?: string | null,"short_name": string,"slug": string,"source_config"?: NonNullable<Json>,"updated_at"?: string,"website_url"?: string | null
                  }
                  Update: {
                    "classification"?: string | null,"contact_email"?: string | null,"created_at"?: string,"id"?: number,"map_center_lat"?: number | null,"map_center_lng"?: number | null,"meta"?: Json | null,"name"?: string,"ocd_id"?: string | null,"province"?: string | null,"rss_url"?: string | null,"short_name"?: string,"slug"?: string,"source_config"?: NonNullable<Json>,"updated_at"?: string,"website_url"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"ocd_divisions": {
                  Row: {
                    "country": string,"created_at": string | null,"csd_code": string | null,"division_id": string,"id": number,"name": string
                  }
                  ComputedFields: never
                  Insert: {
                    "country"?: string,"created_at"?: string | null,"csd_code"?: string | null,"division_id": string,"id"?: never,"name": string
                  }
                  Update: {
                    "country"?: string,"created_at"?: string | null,"csd_code"?: string | null,"division_id"?: string,"id"?: never,"name"?: string
                  }
                  Relationships: [
                    
                  ]
                },"organizations": {
                  Row: {
                    "classification": Database["public"]['Enums']["org_classification"] | null,"created_at": string,"id": number,"meta": Json | null,"municipality_id": number | null,"name": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "classification"?: Database["public"]['Enums']["org_classification"] | null,"created_at"?: string,"id"?: number,"meta"?: Json | null,"municipality_id"?: number | null,"name": string,"updated_at"?: string
                  }
                  Update: {
                    "classification"?: Database["public"]['Enums']["org_classification"] | null,"created_at"?: string,"id"?: number,"meta"?: Json | null,"municipality_id"?: number | null,"name"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "organizations_municipality_id_fkey"
      columns: ["municipality_id"]
isOneToOne: false
      referencedRelation: "municipalities"
      referencedColumns: ["id"]
    }
                  ]
                },"page_reviews": {
                  Row: {
                    "agent_at": string | null,"agent_note": string | null,"ai_checked_at": string | null,"ai_entries": number | null,"ai_flags": Json | null,"ai_guidance_version": number | null,"ai_model": string | null,"ai_page_issue": string | null,"ai_rated_history": Json | null,"ai_summary": string | null,"check_requested_at": string | null,"internal_note": string | null,"internal_note_at": string | null,"internal_note_by": string | null,"kind": string,"note": string | null,"path": string,"reviewed_at": string | null,"reviewed_by": string | null,"status": string | null,"title": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "agent_at"?: string | null,"agent_note"?: string | null,"ai_checked_at"?: string | null,"ai_entries"?: number | null,"ai_flags"?: Json | null,"ai_guidance_version"?: number | null,"ai_model"?: string | null,"ai_page_issue"?: string | null,"ai_rated_history"?: Json | null,"ai_summary"?: string | null,"check_requested_at"?: string | null,"internal_note"?: string | null,"internal_note_at"?: string | null,"internal_note_by"?: string | null,"kind": string,"note"?: string | null,"path": string,"reviewed_at"?: string | null,"reviewed_by"?: string | null,"status"?: string | null,"title"?: string | null
                  }
                  Update: {
                    "agent_at"?: string | null,"agent_note"?: string | null,"ai_checked_at"?: string | null,"ai_entries"?: number | null,"ai_flags"?: Json | null,"ai_guidance_version"?: number | null,"ai_model"?: string | null,"ai_page_issue"?: string | null,"ai_rated_history"?: Json | null,"ai_summary"?: string | null,"check_requested_at"?: string | null,"internal_note"?: string | null,"internal_note_at"?: string | null,"internal_note_by"?: string | null,"kind"?: string,"note"?: string | null,"path"?: string,"reviewed_at"?: string | null,"reviewed_by"?: string | null,"status"?: string | null,"title"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"people": {
                  Row: {
                    "bio": string | null,"created_at": string,"email": string | null,"id": number,"image_url": string | null,"is_councillor": boolean | null,"meta": Json | null,"name": string,"slug": string,"updated_at": string,"voice_fingerprint_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "bio"?: string | null,"created_at"?: string,"email"?: string | null,"id"?: number,"image_url"?: string | null,"is_councillor"?: boolean | null,"meta"?: Json | null,"name": string,"slug": string,"updated_at"?: string,"voice_fingerprint_id"?: string | null
                  }
                  Update: {
                    "bio"?: string | null,"created_at"?: string,"email"?: string | null,"id"?: number,"image_url"?: string | null,"is_councillor"?: boolean | null,"meta"?: Json | null,"name"?: string,"slug"?: string,"updated_at"?: string,"voice_fingerprint_id"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"pipeline_jobs": {
                  Row: {
                    "args": NonNullable<Json>,"attempt_count": number,"created_at": string,"finished_at": string | null,"id": number,"job_type": string,"last_error": string | null,"locked_at": string | null,"locked_by": string | null,"max_attempts": number,"municipality_id": number,"priority": number,"requested_at": string,"requested_by": string | null,"result": NonNullable<Json>,"started_at": string | null,"status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "args"?: NonNullable<Json>,"attempt_count"?: number,"created_at"?: string,"finished_at"?: string | null,"id"?: number,"job_type": string,"last_error"?: string | null,"locked_at"?: string | null,"locked_by"?: string | null,"max_attempts"?: number,"municipality_id": number,"priority"?: number,"requested_at"?: string,"requested_by"?: string | null,"result"?: NonNullable<Json>,"started_at"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "args"?: NonNullable<Json>,"attempt_count"?: number,"created_at"?: string,"finished_at"?: string | null,"id"?: number,"job_type"?: string,"last_error"?: string | null,"locked_at"?: string | null,"locked_by"?: string | null,"max_attempts"?: number,"municipality_id"?: number,"priority"?: number,"requested_at"?: string,"requested_by"?: string | null,"result"?: NonNullable<Json>,"started_at"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "pipeline_jobs_municipality_id_fkey"
      columns: ["municipality_id"]
isOneToOne: false
      referencedRelation: "municipalities"
      referencedColumns: ["id"]
    }
                  ]
                },"pipeline_run_events": {
                  Row: {
                    "created_at": string,"data": NonNullable<Json>,"id": number,"job_id": number,"level": string,"message": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"data"?: NonNullable<Json>,"id"?: number,"job_id": number,"level"?: string,"message": string
                  }
                  Update: {
                    "created_at"?: string,"data"?: NonNullable<Json>,"id"?: number,"job_id"?: number,"level"?: string,"message"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "pipeline_run_events_job_id_fkey"
      columns: ["job_id"]
isOneToOne: false
      referencedRelation: "pipeline_jobs"
      referencedColumns: ["id"]
    }
                  ]
                },"properties": {
                  Row: {
                    "address": string,"civic_number": string,"created_at": string,"geo": Json | null,"geocode_attempted_at": string | null,"hidden": boolean,"id": number,"meta": NonNullable<Json>,"municipality_id": number,"slug": string,"street": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "address": string,"civic_number": string,"created_at"?: string,"geo"?: Json | null,"geocode_attempted_at"?: string | null,"hidden"?: boolean,"id"?: number,"meta"?: NonNullable<Json>,"municipality_id"?: number,"slug": string,"street": string,"updated_at"?: string
                  }
                  Update: {
                    "address"?: string,"civic_number"?: string,"created_at"?: string,"geo"?: Json | null,"geocode_attempted_at"?: string | null,"hidden"?: boolean,"id"?: number,"meta"?: NonNullable<Json>,"municipality_id"?: number,"slug"?: string,"street"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"property_links": {
                  Row: {
                    "agenda_item_id": number | null,"created_at": string,"hidden": boolean,"id": number,"matter_id": number | null,"property_id": number,"source": string
                  }
                  ComputedFields: never
                  Insert: {
                    "agenda_item_id"?: number | null,"created_at"?: string,"hidden"?: boolean,"id"?: number,"matter_id"?: number | null,"property_id": number,"source": string
                  }
                  Update: {
                    "agenda_item_id"?: number | null,"created_at"?: string,"hidden"?: boolean,"id"?: number,"matter_id"?: number | null,"property_id"?: number,"source"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "property_links_agenda_item_id_fkey"
      columns: ["agenda_item_id"]
isOneToOne: false
      referencedRelation: "agenda_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "property_links_matter_id_fkey"
      columns: ["matter_id"]
isOneToOne: false
      referencedRelation: "matters"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "property_links_property_id_fkey"
      columns: ["property_id"]
isOneToOne: false
      referencedRelation: "properties"
      referencedColumns: ["id"]
    }
                  ]
                },"public_content_version": {
                  Row: {
                    "changed_at": string,"id": number
                  }
                  ComputedFields: never
                  Insert: {
                    "changed_at"?: string,"id"?: number
                  }
                  Update: {
                    "changed_at"?: string,"id"?: number
                  }
                  Relationships: [
                    
                  ]
                },"public_report_pages": {
                  Row: {
                    "content": string,"page": number,"report_id": number,"text_search": unknown
                  }
                  ComputedFields: never
                  Insert: {
                    "content": string,"page": number,"report_id": number,"text_search"?: never
                  }
                  Update: {
                    "content"?: string,"page"?: number,"report_id"?: number,"text_search"?: never
                  }
                  Relationships: [
                    {
      foreignKeyName: "public_report_pages_report_id_fkey"
      columns: ["report_id"]
isOneToOne: false
      referencedRelation: "public_reports"
      referencedColumns: ["id"]
    }
                  ]
                },"public_reports": {
                  Row: {
                    "created_at": string,"file_hash": string | null,"id": number,"kind": string,"meta": NonNullable<Json>,"municipality_id": number,"page_count": number | null,"source_url": string | null,"title": string,"updated_at": string,"year": number
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"file_hash"?: string | null,"id"?: number,"kind": string,"meta"?: NonNullable<Json>,"municipality_id": number,"page_count"?: number | null,"source_url"?: string | null,"title": string,"updated_at"?: string,"year": number
                  }
                  Update: {
                    "created_at"?: string,"file_hash"?: string | null,"id"?: number,"kind"?: string,"meta"?: NonNullable<Json>,"municipality_id"?: number,"page_count"?: number | null,"source_url"?: string | null,"title"?: string,"updated_at"?: string,"year"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "public_reports_municipality_id_fkey"
      columns: ["municipality_id"]
isOneToOne: false
      referencedRelation: "municipalities"
      referencedColumns: ["id"]
    }
                  ]
                },"public_speaker_names": {
                  Row: {
                    "agenda_item_id": number,"basis": string,"conflict": NonNullable<Json>,"created_at": string,"decided_at": string | null,"decided_by": string | null,"display_name": string | null,"id": number,"meeting_id": number,"municipality_id": number,"name_key": string,"source_segment_ids": (number)[],"start_time": number | null,"status": string,"transcribed_name": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "agenda_item_id": number,"basis": string,"conflict"?: NonNullable<Json>,"created_at"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"display_name"?: string | null,"id"?: number,"meeting_id": number,"municipality_id"?: number,"name_key": string,"source_segment_ids"?: (number)[],"start_time"?: number | null,"status": string,"transcribed_name": string,"updated_at"?: string
                  }
                  Update: {
                    "agenda_item_id"?: number,"basis"?: string,"conflict"?: NonNullable<Json>,"created_at"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"display_name"?: string | null,"id"?: number,"meeting_id"?: number,"municipality_id"?: number,"name_key"?: string,"source_segment_ids"?: (number)[],"start_time"?: number | null,"status"?: string,"transcribed_name"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "public_speaker_names_agenda_item_id_fkey"
      columns: ["agenda_item_id"]
isOneToOne: false
      referencedRelation: "agenda_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "public_speaker_names_meeting_id_fkey"
      columns: ["meeting_id"]
isOneToOne: false
      referencedRelation: "meetings"
      referencedColumns: ["id"]
    }
                  ]
                },"rag_feedback": {
                  Row: {
                    "client_ip": string | null,"comment": string | null,"created_at": string | null,"id": string,"rating": number,"trace_id": string,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "client_ip"?: string | null,"comment"?: string | null,"created_at"?: string | null,"id"?: string,"rating": number,"trace_id": string,"user_id"?: string | null
                  }
                  Update: {
                    "client_ip"?: string | null,"comment"?: string | null,"created_at"?: string | null,"id"?: string,"rating"?: number,"trace_id"?: string,"user_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "rag_feedback_trace_id_fkey"
      columns: ["trace_id"]
isOneToOne: false
      referencedRelation: "rag_traces"
      referencedColumns: ["id"]
    }
                  ]
                },"rag_traces": {
                  Row: {
                    "answer": string | null,"client_ip": string | null,"created_at": string | null,"id": string,"latency_ms": number | null,"model": string | null,"posthog_trace_id": string | null,"query": string,"source_count": number | null,"sources": Json | null,"tool_calls": Json | null,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "answer"?: string | null,"client_ip"?: string | null,"created_at"?: string | null,"id"?: string,"latency_ms"?: number | null,"model"?: string | null,"posthog_trace_id"?: string | null,"query": string,"source_count"?: number | null,"sources"?: Json | null,"tool_calls"?: Json | null,"user_id"?: string | null
                  }
                  Update: {
                    "answer"?: string | null,"client_ip"?: string | null,"created_at"?: string | null,"id"?: string,"latency_ms"?: number | null,"model"?: string | null,"posthog_trace_id"?: string | null,"query"?: string,"source_count"?: number | null,"sources"?: Json | null,"tool_calls"?: Json | null,"user_id"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"review_examples": {
                  Row: {
                    "created_at": string,"embedding": unknown,"entry_key": string | null,"entry_text": string,"guidance_version": number | null,"id": number,"model": string | null,"note": string | null,"page_kind": string,"path": string,"problem": string,"rated_by": string | null,"reason": string,"updated_at": string,"verdict": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"embedding"?: unknown,"entry_key"?: string | null,"entry_text": string,"guidance_version"?: number | null,"id"?: number,"model"?: string | null,"note"?: string | null,"page_kind": string,"path": string,"problem": string,"rated_by"?: string | null,"reason": string,"updated_at"?: string,"verdict": string
                  }
                  Update: {
                    "created_at"?: string,"embedding"?: unknown,"entry_key"?: string | null,"entry_text"?: string,"guidance_version"?: number | null,"id"?: number,"model"?: string | null,"note"?: string | null,"page_kind"?: string,"path"?: string,"problem"?: string,"rated_by"?: string | null,"reason"?: string,"updated_at"?: string,"verdict"?: string
                  }
                  Relationships: [
                    
                  ]
                },"review_guidance": {
                  Row: {
                    "based_on": number,"created_at": string,"decided_at": string | null,"decided_by": string | null,"id": number,"page_kind": string | null,"problem": string,"status": string,"text": string
                  }
                  ComputedFields: never
                  Insert: {
                    "based_on"?: number,"created_at"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"id"?: number,"page_kind"?: string | null,"problem": string,"status": string,"text": string
                  }
                  Update: {
                    "based_on"?: number,"created_at"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"id"?: number,"page_kind"?: string | null,"problem"?: string,"status"?: string,"text"?: string
                  }
                  Relationships: [
                    
                  ]
                },"search_daily_usage": {
                  Row: {
                    "day": string,"requests": number
                  }
                  ComputedFields: never
                  Insert: {
                    "day": string,"requests"?: number
                  }
                  Update: {
                    "day"?: string,"requests"?: number
                  }
                  Relationships: [
                    
                  ]
                },"search_results_cache": {
                  Row: {
                    "answer": string,"created_at": string | null,"expires_at": string | null,"id": string,"normalized_query": string | null,"query": string,"request_id": string | null,"source_count": number | null,"sources": NonNullable<Json>,"suggested_followups": (string)[] | null
                  }
                  ComputedFields: never
                  Insert: {
                    "answer": string,"created_at"?: string | null,"expires_at"?: string | null,"id"?: string,"normalized_query"?: string | null,"query": string,"request_id"?: string | null,"source_count"?: number | null,"sources"?: NonNullable<Json>,"suggested_followups"?: (string)[] | null
                  }
                  Update: {
                    "answer"?: string,"created_at"?: string | null,"expires_at"?: string | null,"id"?: string,"normalized_query"?: string | null,"query"?: string,"request_id"?: string | null,"source_count"?: number | null,"sources"?: NonNullable<Json>,"suggested_followups"?: (string)[] | null
                  }
                  Relationships: [
                    
                  ]
                },"server_metrics": {
                  Row: {
                    "connections": number | null,"cpu_busy_seconds": number | null,"cpu_total_seconds": number | null,"data_read_bytes": number | null,"data_written_bytes": number | null,"database_bytes": number | null,"io_stalled_seconds": number | null,"mem_available_bytes": number | null,"mem_total_bytes": number | null,"memory_stalled_seconds": number | null,"root_read_bytes": number | null,"sampled_at": string,"swap_free_bytes": number | null,"swap_in_pages": number | null,"swap_out_pages": number | null,"swap_total_bytes": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "connections"?: number | null,"cpu_busy_seconds"?: number | null,"cpu_total_seconds"?: number | null,"data_read_bytes"?: number | null,"data_written_bytes"?: number | null,"database_bytes"?: number | null,"io_stalled_seconds"?: number | null,"mem_available_bytes"?: number | null,"mem_total_bytes"?: number | null,"memory_stalled_seconds"?: number | null,"root_read_bytes"?: number | null,"sampled_at"?: string,"swap_free_bytes"?: number | null,"swap_in_pages"?: number | null,"swap_out_pages"?: number | null,"swap_total_bytes"?: number | null
                  }
                  Update: {
                    "connections"?: number | null,"cpu_busy_seconds"?: number | null,"cpu_total_seconds"?: number | null,"data_read_bytes"?: number | null,"data_written_bytes"?: number | null,"database_bytes"?: number | null,"io_stalled_seconds"?: number | null,"mem_available_bytes"?: number | null,"mem_total_bytes"?: number | null,"memory_stalled_seconds"?: number | null,"root_read_bytes"?: number | null,"sampled_at"?: string,"swap_free_bytes"?: number | null,"swap_in_pages"?: number | null,"swap_out_pages"?: number | null,"swap_total_bytes"?: number | null
                  }
                  Relationships: [
                    
                  ]
                },"source_links": {
                  Row: {
                    "created_at": string,"hidden": boolean,"id": number,"matter_id": number | null,"property_id": number | null,"source_id": number
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"hidden"?: boolean,"id"?: number,"matter_id"?: number | null,"property_id"?: number | null,"source_id": number
                  }
                  Update: {
                    "created_at"?: string,"hidden"?: boolean,"id"?: number,"matter_id"?: number | null,"property_id"?: number | null,"source_id"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "source_links_matter_id_fkey"
      columns: ["matter_id"]
isOneToOne: false
      referencedRelation: "matters"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "source_links_property_id_fkey"
      columns: ["property_id"]
isOneToOne: false
      referencedRelation: "properties"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "source_links_source_id_fkey"
      columns: ["source_id"]
isOneToOne: false
      referencedRelation: "sources"
      referencedColumns: ["id"]
    }
                  ]
                },"source_meetings": {
                  Row: {
                    "archive_path": string | null,"created_at": string,"discovered_at": string,"id": number,"ingested_meeting_id": number | null,"last_error": string | null,"last_seen_at": string,"meeting_date": string,"meeting_type": string | null,"municipality_id": number,"raw": NonNullable<Json>,"source_id": string,"source_type": string,"source_url": string | null,"status": string,"title": string,"updated_at": string,"video_url": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "archive_path"?: string | null,"created_at"?: string,"discovered_at"?: string,"id"?: number,"ingested_meeting_id"?: number | null,"last_error"?: string | null,"last_seen_at"?: string,"meeting_date": string,"meeting_type"?: string | null,"municipality_id": number,"raw"?: NonNullable<Json>,"source_id": string,"source_type": string,"source_url"?: string | null,"status"?: string,"title": string,"updated_at"?: string,"video_url"?: string | null
                  }
                  Update: {
                    "archive_path"?: string | null,"created_at"?: string,"discovered_at"?: string,"id"?: number,"ingested_meeting_id"?: number | null,"last_error"?: string | null,"last_seen_at"?: string,"meeting_date"?: string,"meeting_type"?: string | null,"municipality_id"?: number,"raw"?: NonNullable<Json>,"source_id"?: string,"source_type"?: string,"source_url"?: string | null,"status"?: string,"title"?: string,"updated_at"?: string,"video_url"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "source_meetings_ingested_meeting_id_fkey"
      columns: ["ingested_meeting_id"]
isOneToOne: false
      referencedRelation: "meetings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "source_meetings_municipality_id_fkey"
      columns: ["municipality_id"]
isOneToOne: false
      referencedRelation: "municipalities"
      referencedColumns: ["id"]
    }
                  ]
                },"sources": {
                  Row: {
                    "added_by": string | null,"archive_url": string | null,"archived_at": string | null,"content_fetched_at": string | null,"content_text": string | null,"created_at": string,"happened_on": string,"headline": string,"hidden": boolean,"id": number,"meta": NonNullable<Json>,"municipality_id": number,"note": string | null,"origin": string,"published_on": string | null,"publisher": string,"quote": string | null,"title": string,"updated_at": string,"url": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "added_by"?: string | null,"archive_url"?: string | null,"archived_at"?: string | null,"content_fetched_at"?: string | null,"content_text"?: string | null,"created_at"?: string,"happened_on": string,"headline": string,"hidden"?: boolean,"id"?: number,"meta"?: NonNullable<Json>,"municipality_id": number,"note"?: string | null,"origin": string,"published_on"?: string | null,"publisher": string,"quote"?: string | null,"title": string,"updated_at"?: string,"url"?: string | null
                  }
                  Update: {
                    "added_by"?: string | null,"archive_url"?: string | null,"archived_at"?: string | null,"content_fetched_at"?: string | null,"content_text"?: string | null,"created_at"?: string,"happened_on"?: string,"headline"?: string,"hidden"?: boolean,"id"?: number,"meta"?: NonNullable<Json>,"municipality_id"?: number,"note"?: string | null,"origin"?: string,"published_on"?: string | null,"publisher"?: string,"quote"?: string | null,"title"?: string,"updated_at"?: string,"url"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "sources_municipality_id_fkey"
      columns: ["municipality_id"]
isOneToOne: false
      referencedRelation: "municipalities"
      referencedColumns: ["id"]
    }
                  ]
                },"staff_actions": {
                  Row: {
                    "action": string | null,"created_at": string,"detail": NonNullable<Json>,"id": number,"path": string,"role": string,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "action"?: string | null,"created_at"?: string,"detail"?: NonNullable<Json>,"id"?: number,"path": string,"role": string,"user_id"?: string | null
                  }
                  Update: {
                    "action"?: string | null,"created_at"?: string,"detail"?: NonNullable<Json>,"id"?: number,"path"?: string,"role"?: string,"user_id"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"subscriptions": {
                  Row: {
                    "created_at": string,"id": number,"is_active": boolean,"keyword": string | null,"keyword_embedding": unknown,"matter_id": number | null,"meta": NonNullable<Json>,"neighborhood": string | null,"person_id": number | null,"proximity_radius_m": number,"topic_id": number | null,"type": Database["public"]['Enums']["subscription_type"],"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: number,"is_active"?: boolean,"keyword"?: string | null,"keyword_embedding"?: unknown,"matter_id"?: number | null,"meta"?: NonNullable<Json>,"neighborhood"?: string | null,"person_id"?: number | null,"proximity_radius_m"?: number,"topic_id"?: number | null,"type": Database["public"]['Enums']["subscription_type"],"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: number,"is_active"?: boolean,"keyword"?: string | null,"keyword_embedding"?: unknown,"matter_id"?: number | null,"meta"?: NonNullable<Json>,"neighborhood"?: string | null,"person_id"?: number | null,"proximity_radius_m"?: number,"topic_id"?: number | null,"type"?: Database["public"]['Enums']["subscription_type"],"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "subscriptions_matter_id_fkey"
      columns: ["matter_id"]
isOneToOne: false
      referencedRelation: "matters"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "subscriptions_person_id_fkey"
      columns: ["person_id"]
isOneToOne: false
      referencedRelation: "people"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "subscriptions_topic_id_fkey"
      columns: ["topic_id"]
isOneToOne: false
      referencedRelation: "topics"
      referencedColumns: ["id"]
    }
                  ]
                },"topics": {
                  Row: {
                    "created_at": string,"description": string | null,"id": number,"name": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"description"?: string | null,"id"?: number,"name": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"description"?: string | null,"id"?: number,"name"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"transcript_identity_evidence": {
                  Row: {
                    "after_row": NonNullable<Json>,"before_row": NonNullable<Json>,"created_at": string,"evidence": NonNullable<Json>,"id": string,"identity_evidence_sha256": string,"input_sha256": string,"meeting_id": number,"person_id": number,"reverted_at": string | null,"reverted_row": Json | null,"segment_id": number,"source_run": NonNullable<Json>,"status": string,"validator_sha256": string,"validator_version": string
                  }
                  ComputedFields: never
                  Insert: {
                    "after_row": NonNullable<Json>,"before_row": NonNullable<Json>,"created_at"?: string,"evidence": NonNullable<Json>,"id"?: string,"identity_evidence_sha256": string,"input_sha256": string,"meeting_id": number,"person_id": number,"reverted_at"?: string | null,"reverted_row"?: Json | null,"segment_id": number,"source_run": NonNullable<Json>,"status"?: string,"validator_sha256": string,"validator_version": string
                  }
                  Update: {
                    "after_row"?: NonNullable<Json>,"before_row"?: NonNullable<Json>,"created_at"?: string,"evidence"?: NonNullable<Json>,"id"?: string,"identity_evidence_sha256"?: string,"input_sha256"?: string,"meeting_id"?: number,"person_id"?: number,"reverted_at"?: string | null,"reverted_row"?: Json | null,"segment_id"?: number,"source_run"?: NonNullable<Json>,"status"?: string,"validator_sha256"?: string,"validator_version"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "transcript_identity_evidence_meeting_id_fkey"
      columns: ["meeting_id"]
isOneToOne: false
      referencedRelation: "meetings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transcript_identity_evidence_person_id_fkey"
      columns: ["person_id"]
isOneToOne: false
      referencedRelation: "people"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transcript_identity_evidence_segment_id_fkey"
      columns: ["segment_id"]
isOneToOne: false
      referencedRelation: "transcript_segments"
      referencedColumns: ["id"]
    }
                  ]
                },"transcript_segments": {
                  Row: {
                    "agenda_item_id": number | null,"attribution_source": string | null,"created_at": string,"end_time": number,"id": number,"is_procedural": boolean | null,"is_verified": boolean | null,"meeting_id": number,"motion_id": number | null,"person_id": number | null,"sentiment_score": number | null,"speaker_name": string | null,"speaker_role": string | null,"start_time": number,"text_content": string,"text_search": unknown,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "agenda_item_id"?: number | null,"attribution_source"?: string | null,"created_at"?: string,"end_time": number,"id"?: number,"is_procedural"?: boolean | null,"is_verified"?: boolean | null,"meeting_id": number,"motion_id"?: number | null,"person_id"?: number | null,"sentiment_score"?: number | null,"speaker_name"?: string | null,"speaker_role"?: string | null,"start_time": number,"text_content": string,"text_search"?: never,"updated_at"?: string
                  }
                  Update: {
                    "agenda_item_id"?: number | null,"attribution_source"?: string | null,"created_at"?: string,"end_time"?: number,"id"?: number,"is_procedural"?: boolean | null,"is_verified"?: boolean | null,"meeting_id"?: number,"motion_id"?: number | null,"person_id"?: number | null,"sentiment_score"?: number | null,"speaker_name"?: string | null,"speaker_role"?: string | null,"start_time"?: number,"text_content"?: string,"text_search"?: never,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "transcript_segments_agenda_item_id_fkey"
      columns: ["agenda_item_id"]
isOneToOne: false
      referencedRelation: "agenda_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transcript_segments_meeting_id_fkey"
      columns: ["meeting_id"]
isOneToOne: false
      referencedRelation: "meetings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transcript_segments_motion_id_fkey"
      columns: ["motion_id"]
isOneToOne: false
      referencedRelation: "motions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transcript_segments_person_id_fkey"
      columns: ["person_id"]
isOneToOne: false
      referencedRelation: "people"
      referencedColumns: ["id"]
    }
                  ]
                },"user_profiles": {
                  Row: {
                    "agenda_alerts_enabled": boolean,"created_at": string,"digest_enabled": boolean,"digest_frequency": Database["public"]['Enums']["digest_frequency"],"display_name": string | null,"email_alerts_consent_at": string | null,"email_alerts_consent_version": string | null,"email_alerts_enabled": boolean,"email_verified": boolean,"id": string,"location_label": string | null,"location_lat": number | null,"location_lng": number | null,"meta": NonNullable<Json>,"neighborhood": string | null,"notification_email": string | null,"onboarding_completed": boolean,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "agenda_alerts_enabled"?: boolean,"created_at"?: string,"digest_enabled"?: boolean,"digest_frequency"?: Database["public"]['Enums']["digest_frequency"],"display_name"?: string | null,"email_alerts_consent_at"?: string | null,"email_alerts_consent_version"?: string | null,"email_alerts_enabled"?: boolean,"email_verified"?: boolean,"id": string,"location_label"?: string | null,"location_lat"?: number | null,"location_lng"?: number | null,"meta"?: NonNullable<Json>,"neighborhood"?: string | null,"notification_email"?: string | null,"onboarding_completed"?: boolean,"updated_at"?: string
                  }
                  Update: {
                    "agenda_alerts_enabled"?: boolean,"created_at"?: string,"digest_enabled"?: boolean,"digest_frequency"?: Database["public"]['Enums']["digest_frequency"],"display_name"?: string | null,"email_alerts_consent_at"?: string | null,"email_alerts_consent_version"?: string | null,"email_alerts_enabled"?: boolean,"email_verified"?: boolean,"id"?: string,"location_label"?: string | null,"location_lat"?: number | null,"location_lng"?: number | null,"meta"?: NonNullable<Json>,"neighborhood"?: string | null,"notification_email"?: string | null,"onboarding_completed"?: boolean,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"user_roles": {
                  Row: {
                    "granted_at": string,"granted_by": string | null,"role": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "granted_at"?: string,"granted_by"?: string | null,"role": string,"user_id": string
                  }
                  Update: {
                    "granted_at"?: string,"granted_by"?: string | null,"role"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"voice_exemplars": {
                  Row: {
                    "confidence": number,"created_at": string,"embedding": NonNullable<Json>,"evidence": NonNullable<Json>,"id": number,"meeting_id": number,"person_id": number,"source": string,"speaker_label": string,"speech_seconds": number | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "confidence"?: number,"created_at"?: string,"embedding": NonNullable<Json>,"evidence"?: NonNullable<Json>,"id"?: number,"meeting_id": number,"person_id": number,"source": string,"speaker_label": string,"speech_seconds"?: number | null,"updated_at"?: string
                  }
                  Update: {
                    "confidence"?: number,"created_at"?: string,"embedding"?: NonNullable<Json>,"evidence"?: NonNullable<Json>,"id"?: number,"meeting_id"?: number,"person_id"?: number,"source"?: string,"speaker_label"?: string,"speech_seconds"?: number | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "voice_exemplars_meeting_id_fkey"
      columns: ["meeting_id"]
isOneToOne: false
      referencedRelation: "meetings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "voice_exemplars_person_id_fkey"
      columns: ["person_id"]
isOneToOne: false
      referencedRelation: "people"
      referencedColumns: ["id"]
    }
                  ]
                },"voice_fingerprints": {
                  Row: {
                    "confidence": number | null,"created_at": string,"embedding": NonNullable<Json>,"exemplar_count": number | null,"id": string,"meeting_count": number | null,"person_id": number,"source": string,"source_meeting_id": number | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "confidence"?: number | null,"created_at"?: string,"embedding": NonNullable<Json>,"exemplar_count"?: number | null,"id"?: string,"meeting_count"?: number | null,"person_id": number,"source"?: string,"source_meeting_id"?: number | null,"updated_at"?: string
                  }
                  Update: {
                    "confidence"?: number | null,"created_at"?: string,"embedding"?: NonNullable<Json>,"exemplar_count"?: number | null,"id"?: string,"meeting_count"?: number | null,"person_id"?: number,"source"?: string,"source_meeting_id"?: number | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "voice_fingerprints_person_id_fkey"
      columns: ["person_id"]
isOneToOne: true
      referencedRelation: "people"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "voice_fingerprints_source_meeting_id_fkey"
      columns: ["source_meeting_id"]
isOneToOne: false
      referencedRelation: "meetings"
      referencedColumns: ["id"]
    }
                  ]
                },"votes": {
                  Row: {
                    "created_at": string,"id": number,"motion_id": number,"person_id": number,"recusal_reason": string | null,"updated_at": string,"vote": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: number,"motion_id": number,"person_id": number,"recusal_reason"?: string | null,"updated_at"?: string,"vote": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: number,"motion_id"?: number,"person_id"?: number,"recusal_reason"?: string | null,"updated_at"?: string,"vote"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "votes_motion_id_fkey"
      columns: ["motion_id"]
isOneToOne: false
      referencedRelation: "motions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "votes_person_id_fkey"
      columns: ["person_id"]
isOneToOne: false
      referencedRelation: "people"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            "ai_usage_by_job": {
                  Row: {
                    "calls": number | null,"failed": number | null,"input_tokens": number | null,"model": string,"operation": string | null,"output_tokens": number | null,"pipeline_job_id": number | null,"stage": string
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "ai_usage_pipeline_job_id_fkey"
      columns: ["pipeline_job_id"]
isOneToOne: false
      referencedRelation: "pipeline_jobs"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Functions: {
            "_council_attendance_js_text":
{ Args: { "value": Json }; Returns: string
                           },
"_council_attendance_state":
{ Args: { "p_date": string,"p_meeting_id": number,"p_mode": string,"p_notes": string,"p_person_id": number }; Returns: {
              "state": string,"verified": boolean
            }[]
                           },
"_council_attendance_trim":
{ Args: { "value": string }; Returns: string
                           },
"ai_usage_summary":
{ Args: { "since": string }; Returns: {
              "by_model": Json,"calls": number,"failures": number,"input_tokens": number,"output_tokens": number,"p50_latency_ms": number,"p95_latency_ms": number,"source": string,"stage": string
            }[]
                           },
"alert_subscription_matches":
{ Args: { "p_meeting": number }; Returns: {
              "agenda_item_id": number,"match_label": string,"match_type": string,"subscription_id": number,"user_id": string
            }[]
                           },
"anonymize_email_messages":
{ Args: { "p_ids": (string)[] }; Returns: number
                           },
"apply_calendar_sync":
{ Args: { "p_events": Json,"p_token": string,"p_warnings"?: Json }; Returns: Json
                           },
"apply_log_retention":
{ Args: { "p_batch"?: number,"p_dry_run"?: boolean,"p_keep_days"?: number }; Returns: Json
                           },
"apply_privacy_retention":
{ Args: { "p_dry_run"?: boolean }; Returns: Json
                           },
"apply_public_participation_summary":
{ Args: { "p_after_meta": Json,"p_expected_item": Json,"p_expected_segments": Json,"p_item_id": number }; Returns: boolean
                           },
"apply_transcript_identity_evidence":
{ Args: { "p_evidence": Json,"p_expected": Json,"p_input_canonical_json": string,"p_input_sha256": string,"p_person_id": number,"p_segment_id": number,"p_source_run": Json,"p_speaker_name": string,"p_validator_sha256": string,"p_validator_version": string }; Returns: Json
                           },
"build_agenda_preview":
{ Args: { "p_meeting": number,"p_user": string }; Returns: Json
                           },
"build_meeting_digest":
{ Args: { "target_meeting_id": number }; Returns: Json
                           },
"bulk_classify_topics_by_category":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"bump_matter_content_for_items":
{ Args: { "item_ids": (number)[] }; Returns: undefined
                           },
"bylaw_slug_base":
{ Args: { "bylaw_number": string,"title": string }; Returns: string
                           },
"claim_calendar_sync":
{ Args: { "p_trigger"?: string }; Returns: string
                           },
"claim_email_alert":
{ Args: { "p_test_recipient"?: string }; Returns: {
              "accepted_at": string | null,
"attempt_count": number,
"consent_at": string | null,
"created_at": string,
"deduplication_key": string,
"delivered_at": string | null,
"expires_at": string,
"failed_at": string | null,
"id": string,
"is_test": boolean,
"last_error": string | null,
"lease_token": string | null,
"lease_until": string | null,
"meeting_id": number | null,
"message_type": string,
"next_attempt_at": string,
"payload": NonNullable<Json>,
"preview_text": string | null,
"provider_message_id": string | null,
"provider_payload": Json | null,
"recipient": string,
"status": string,
"subject": string,
"unsubscribe_token": string,
"updated_at": string,
"user_id": string | null
            }[]
                          SetofOptions: {
        from: "*"
        to: "email_messages"
        isOneToOne: false
        isSetofReturn: true
      } },
"claim_next_pipeline_job":
{ Args: { "job_types"?: (string)[],"worker_id": string }; Returns: {
              "args": NonNullable<Json>,
"attempt_count": number,
"created_at": string,
"finished_at": string | null,
"id": number,
"job_type": string,
"last_error": string | null,
"locked_at": string | null,
"locked_by": string | null,
"max_attempts": number,
"municipality_id": number,
"priority": number,
"requested_at": string,
"requested_by": string | null,
"result": NonNullable<Json>,
"started_at": string | null,
"status": string,
"updated_at": string
            }[]
                          SetofOptions: {
        from: "*"
        to: "pipeline_jobs"
        isOneToOne: false
        isSetofReturn: true
      } },
"council_attendance_summaries":
{ Args: { "p_as_of"?: string,"p_municipality_id": number }; Returns: {
              "absent": number,"attended": number,"person_id": number,"rate": number,"recorded": number,"term_key": string,"total": number,"unknown": number,"verified": number
            }[]
                           },
"council_term_stats":
{ Args: { "p_as_of": string,"p_municipality_id": number }; Returns: {
              "bylaw_adoption_dates": Json,"bylaws_adopted": number,"committee_of_the_whole": number,"committees": number,"letters": number,"meetings": number,"meetings_by_month": Json,"motions_by_month": Json,"motions_carried": number,"motions_defeated": number,"public_opposes": number,"public_supports": number,"public_topics": Json,"regular_council": number,"special_council": number,"spoken_comments": number,"term_id": number,"topics": Json
            }[]
                           },
"delete_account_data":
{ Args: { "p_user_id": string }; Returns: Json
                           },
"election_slug_base":
{ Args: { "election_date": string,"name": string }; Returns: string
                           },
"email_alert_eligible":
{ Args: { "p_message": string,"p_start_date": string }; Returns: boolean
                           },
"email_distance_m":
{ Args: { "lat1": number,"lng1": number,"location": Json }; Returns: number
                           },
"enqueue_agenda_alert_emails":
{ Args: { "p_meeting": number,"p_start_date": string,"p_test_recipient"?: string }; Returns: number
                           },
"enqueue_meeting_emails":
{ Args: { "p_meeting": number,"p_start_date": string,"p_test_recipient"?: string }; Returns: number
                           },
"fail_calendar_sync":
{ Args: { "p_error": string,"p_token": string }; Returns: undefined
                           },
"find_meeting_subscribers":
{ Args: { "target_meeting_id": number }; Returns: {
              "consent_at": string,"notification_email": string,"user_id": string
            }[]
                           },
"finish_email_alert":
{ Args: { "p_error"?: string,"p_lease": string,"p_message": string,"p_provider_id"?: string,"p_retry_seconds"?: number,"p_state": string }; Returns: boolean
                           },
"freeze_email_alert":
{ Args: { "p_body": Json,"p_lease": string,"p_message": string }; Returns: Json
                           },
"generate_slug":
{ Args: { "input": string,"max_len"?: number }; Returns: string
                           },
"generate_slug_capped":
{ Args: { "input": string,"max_len"?: number }; Returns: string
                           },
"get_meetings_with_stats":
{ Args: { "filter_municipality_id"?: number }; Returns: {
              "meeting_id": number,"motion_carried_count": number,"motion_defeated_count": number,"motion_other_count": number,"topics": (string)[]
            }[]
                           },
"get_speaking_time_by_meeting":
{ Args: { "p_end_date"?: string,"p_person_id": number,"p_start_date"?: string }; Returns: {
              "meeting_date": string,"meeting_id": number,"seconds_spoken": number,"segment_count": number
            }[]
                           } |
{ Args: { "filter_municipality_id"?: number,"p_end_date"?: string,"p_person_id": number,"p_start_date"?: string }; Returns: {
              "meeting_date": string,"meeting_id": number,"seconds_spoken": number,"segment_count": number
            }[]
                           },
"get_speaking_time_by_topic":
{ Args: { "p_end_date"?: string,"p_person_id": number,"p_start_date"?: string }; Returns: {
              "segment_count": number,"topic": string,"total_seconds": number
            }[]
                           } |
{ Args: { "filter_municipality_id"?: number,"p_end_date"?: string,"p_person_id": number,"p_start_date"?: string }; Returns: {
              "segment_count": number,"topic": string,"total_seconds": number
            }[]
                           },
"get_speaking_time_stats":
{ Args: { "p_end_date"?: string,"p_start_date"?: string }; Returns: {
              "image_url": string,"meeting_count": number,"person_id": number,"person_name": string,"segment_count": number,"total_seconds": number
            }[]
                           } |
{ Args: { "filter_municipality_id"?: number,"p_end_date"?: string,"p_start_date"?: string }; Returns: {
              "image_url": string,"meeting_count": number,"person_id": number,"person_name": string,"segment_count": number,"total_seconds": number
            }[]
                           },
"get_unclassified_agenda_items":
{ Args: Record<PropertyKey, never>; Returns: {
              "category": string,"id": number
            }[]
                           },
"hybrid_search_bylaw_chunks":
{ Args: { "filter_municipality_id"?: number,"full_text_weight"?: number,"match_count": number,"query_embedding": unknown,"query_text": string,"rrf_k"?: number,"semantic_weight"?: number }; Returns: {
              "bylaw_id": number,"bylaw_number": string,"bylaw_title": string,"chunk_index": number,"id": number,"rank_score": number,"text_content": string
            }[]
                           },
"hybrid_search_document_sections":
{ Args: { "date_from"?: string,"date_to"?: string,"filter_municipality_id"?: number,"full_text_weight"?: number,"match_count": number,"query_embedding": unknown,"query_text": string,"rrf_k"?: number,"semantic_weight"?: number }; Returns: {
              "agenda_item_id": number,"content": string,"document_id": number,"id": number,"meeting_id": number,"rank_score": number,"section_title": string
            }[]
                           },
"hybrid_search_key_statements":
{ Args: { "full_text_weight"?: number,"match_count": number,"query_embedding": unknown,"query_text": string,"rrf_k"?: number,"semantic_weight"?: number }; Returns: {
              "agenda_item_id": number,"context": string,"id": number,"meeting_id": number,"rank_score": number,"speaker_name": string,"statement_text": string,"statement_type": string
            }[]
                           } |
{ Args: { "date_from"?: string,"date_to"?: string,"filter_municipality_id"?: number,"full_text_weight"?: number,"match_count": number,"query_embedding": unknown,"query_text": string,"rrf_k"?: number,"semantic_weight"?: number }; Returns: {
              "agenda_item_id": number,"context": string,"id": number,"meeting_id": number,"rank_score": number,"speaker_name": string,"statement_text": string,"statement_type": string
            }[]
                           },
"hybrid_search_motions":
{ Args: { "full_text_weight"?: number,"match_count": number,"query_embedding": unknown,"query_text": string,"rrf_k"?: number,"semantic_weight"?: number }; Returns: {
              "id": number,"meeting_id": number,"mover": string,"plain_english_summary": string,"rank_score": number,"result": string,"seconder": string,"text_content": string
            }[]
                           } |
{ Args: { "date_from"?: string,"date_to"?: string,"filter_municipality_id"?: number,"full_text_weight"?: number,"match_count": number,"query_embedding": unknown,"query_text": string,"rrf_k"?: number,"semantic_weight"?: number }; Returns: {
              "agenda_item_id": number,"id": number,"meeting_id": number,"mover": string,"plain_english_summary": string,"rank_score": number,"result": string,"seconder": string,"text_content": string
            }[]
                           },
"invalidate_meeting_vimeo_cache":
{ Args: { "p_meeting_id": number }; Returns: {
              "video_url": string
            }[]
                           },
"is_public_input_item":
{ Args: { "p_category": string,"p_title": string }; Returns: boolean
                           },
"match_agenda_items":
{ Args: { "match_count": number,"match_threshold": number,"query_embedding": unknown }; Returns: {
              "debate_summary": string,"id": number,"meeting_id": number,"plain_english_summary": string,"similarity": number,"title": string
            }[]
                           } |
{ Args: { "filter_municipality_id"?: number,"match_count": number,"match_threshold": number,"query_embedding": unknown }; Returns: {
              "debate_summary": string,"id": number,"meeting_id": number,"plain_english_summary": string,"similarity": number,"title": string
            }[]
                           },
"match_bylaw_chunks":
{ Args: { "filter_bylaw_id"?: number,"match_count": number,"match_threshold": number,"query_embedding": unknown }; Returns: {
              "bylaw_id": number,"chunk_index": number,"id": number,"similarity": number,"text_content": string
            }[]
                           },
"match_bylaws":
{ Args: { "match_count": number,"match_threshold": number,"query_embedding": unknown }; Returns: {
              "bylaw_number": string,"id": number,"plain_english_summary": string,"similarity": number,"title": string
            }[]
                           } |
{ Args: { "filter_municipality_id"?: number,"match_count": number,"match_threshold": number,"query_embedding": unknown }; Returns: {
              "bylaw_number": string,"id": number,"plain_english_summary": string,"similarity": number,"title": string
            }[]
                           },
"match_document_sections":
{ Args: { "filter_municipality_id"?: number,"match_count": number,"match_threshold": number,"query_embedding": unknown }; Returns: {
              "agenda_item_id": number,"document_id": number,"id": number,"section_order": number,"section_text": string,"section_title": string,"similarity": number
            }[]
                           },
"match_key_statements":
{ Args: { "match_count": number,"match_threshold": number,"query_embedding": unknown }; Returns: {
              "agenda_item_id": number,"context": string,"id": number,"meeting_id": number,"similarity": number,"speaker_name": string,"statement_text": string,"statement_type": string
            }[]
                           } |
{ Args: { "filter_municipality_id"?: number,"match_count": number,"match_threshold": number,"query_embedding": unknown }; Returns: {
              "agenda_item_id": number,"context": string,"id": number,"meeting_id": number,"similarity": number,"speaker_name": string,"statement_text": string,"statement_type": string
            }[]
                           },
"match_key_statements_by_person":
{ Args: { "filter_person_id": number,"match_count": number,"match_threshold": number,"query_embedding": unknown }; Returns: {
              "agenda_item_id": number,"context": string,"id": number,"meeting_id": number,"similarity": number,"speaker_name": string,"statement_text": string,"statement_type": string
            }[]
                           },
"match_matters":
{ Args: { "match_count": number,"match_threshold": number,"query_embedding": unknown }; Returns: {
              "id": number,"plain_english_summary": string,"similarity": number,"title": string
            }[]
                           } |
{ Args: { "filter_municipality_id"?: number,"match_count": number,"match_threshold": number,"query_embedding": unknown }; Returns: {
              "id": number,"plain_english_summary": string,"similarity": number,"title": string
            }[]
                           },
"match_motions":
{ Args: { "match_count": number,"match_threshold": number,"query_embedding": unknown }; Returns: {
              "agenda_item_id": number,"id": number,"meeting_id": number,"mover": string,"result": string,"seconder": string,"similarity": number,"text_content": string
            }[]
                           } |
{ Args: { "filter_municipality_id"?: number,"match_count": number,"match_threshold": number,"query_embedding": unknown }; Returns: {
              "agenda_item_id": number,"id": number,"meeting_id": number,"mover": string,"result": string,"seconder": string,"similarity": number,"text_content": string
            }[]
                           },
"match_motions_by_person":
{ Args: { "filter_person_id": number,"match_count": number,"match_threshold": number,"query_embedding": unknown }; Returns: {
              "id": number,"meeting_id": number,"result": string,"similarity": number,"text_content": string,"vote": string
            }[]
                           },
"match_review_examples":
{ Args: { "k": number,"kind": string,"problem_type": string,"query_embedding": unknown,"verdict_type": string }; Returns: {
              "entry_text": string,"id": number,"note": string,"reason": string,"similarity": number,"verdict": string
            }[]
                           },
"matter_root":
{ Args: { "p_id": number }; Returns: number
                           },
"matter_slug_base":
{ Args: { "meta": Json,"title": string }; Returns: string
                           },
"merge_matters":
{ Args: { "p_aliases": (number)[],"p_by"?: string,"p_canonical": number,"p_reason": string }; Returns: Json
                           },
"normalize_category_to_topic":
{ Args: { "cat": string }; Returns: string
                           },
"page_hidden":
{ Args: { "p_id": number,"p_table": string }; Returns: boolean
                           },
"property_privacy_flags":
{ Args: Record<PropertyKey, never>; Returns: {
              "hide": boolean,"id": number
            }[]
                           },
"public_participant_appearances":
{ Args: { "p_municipality_id"?: number,"p_person_id"?: number,"p_today": string }; Returns: Json
                           },
"publish_source_bound_key_statement":
{ Args: { "p_input_canonical_json": string,"p_input_sha256": string }; Returns: Json
                           },
"reconcile_calendar_source":
{ Args: { "p_source_meeting_id": number }; Returns: number
                           },
"record_email_provider_event":
{ Args: { "p_at": string,"p_event_id": string,"p_message": string,"p_provider_id": string,"p_recipient": string,"p_type": string }; Returns: boolean
                           },
"refresh_property_privacy":
{ Args: { "p_dry_run"?: boolean }; Returns: Json
                           },
"rekey_about_matters":
{ Args: { "p_about": Json }; Returns: Json
                           },
"rollback_transcript_identity_evidence":
{ Args: { "p_evidence_id": string }; Returns: Json
                           },
"search_daily_budget":
{ Args: { "p_limit": number,"p_reserve"?: boolean }; Returns: {
              "allowed": boolean,"remaining": number,"resets_at": string
            }[]
                           },
"set_email_alert_consent":
{ Args: { "p_complete_onboarding"?: boolean,"p_enabled": boolean }; Returns: undefined
                           },
"unsubscribe_email_alerts":
{ Args: { "p_token": string }; Returns: boolean
                           },
"update_user_location":
{ Args: { "lat": number,"lng": number,"target_user_id": string }; Returns: undefined
                           }
          }
          Enums: {
            "digest_frequency": "each_meeting"|"weekly","meeting_type": "Regular Council"|"Special Council"|"Committee of the Whole"|"Public Hearing"|"Board of Variance"|"Standing Committee"|"Advisory Committee"|"Inauguration","org_classification": "Council"|"Committee"|"Board"|"Advisory Committee"|"Staff"|"Other","subscription_type": "matter"|"topic"|"person"|"neighborhood"|"digest"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            "digest_frequency": ["each_meeting", "weekly"],"meeting_type": ["Regular Council", "Special Council", "Committee of the Whole", "Public Hearing", "Board of Variance", "Standing Committee", "Advisory Committee", "Inauguration"],"org_classification": ["Council", "Committee", "Board", "Advisory Committee", "Staff", "Other"],"subscription_type": ["matter", "topic", "person", "neighborhood", "digest"]
          }
        }
} as const
