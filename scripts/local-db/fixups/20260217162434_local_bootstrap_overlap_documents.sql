-- LOCAL ONLY. bootstrap.sql already contains document_sections, extracted_documents and document_images
-- (it was updated after these tables were added), but the next two migrations create them with plain
-- CREATE TABLE, as production got them. Drop the bootstrap copies so the migrations build them exactly as
-- they ran on production. (Drops matter_evidence's FK to document_sections; post/parity.sql restores it.)
DROP TABLE IF EXISTS public.document_images, public.document_sections, public.extracted_documents CASCADE;
