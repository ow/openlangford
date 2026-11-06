-- Commit this schema change before applying the reviewed event correction.
ALTER TYPE meeting_type ADD VALUE IF NOT EXISTS 'Inauguration';
