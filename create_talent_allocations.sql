-- Run this in Supabase SQL Editor to create the talent_allocations table
CREATE TABLE IF NOT EXISTS talent_allocations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  max_guests INTEGER NOT NULL DEFAULT 5,
  deadline TIMESTAMPTZ,
  token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index for fast token lookups (public invite page)
CREATE INDEX IF NOT EXISTS idx_talent_allocations_token ON talent_allocations(token);

-- Index for listing allocations by event
CREATE INDEX IF NOT EXISTS idx_talent_allocations_event ON talent_allocations(event_id);
