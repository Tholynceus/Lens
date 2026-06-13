-- LENS Intelligence Database Schema
-- Run this in Supabase SQL Editor

-- Table: bankr_launches
-- Stores all Bankrbot token launches with X username mapping
CREATE TABLE IF NOT EXISTS bankr_launches (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  token_address text UNIQUE NOT NULL,
  token_name text,
  token_symbol text,
  chain text DEFAULT 'base',
  status text DEFAULT 'deployed',
  deployer_wallet text,
  fee_recipient_wallet text,
  x_username text,
  x_user_id text,
  image_url text,
  launched_at timestamptz,
  indexed_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Index for fast lookup by X username
CREATE INDEX IF NOT EXISTS idx_bankr_launches_x_username 
  ON bankr_launches(lower(x_username));

-- Index for wallet lookups
CREATE INDEX IF NOT EXISTS idx_bankr_launches_deployer 
  ON bankr_launches(lower(deployer_wallet));

CREATE INDEX IF NOT EXISTS idx_bankr_launches_fee_recipient 
  ON bankr_launches(lower(fee_recipient_wallet));

-- Table: bankr_fees_cache
-- Cache fees data per token (refreshed every 5 min)
CREATE TABLE IF NOT EXISTS bankr_fees_cache (
  token_address text PRIMARY KEY,
  claimed_usd numeric DEFAULT 0,
  claimable_usd numeric DEFAULT 0,
  claim_count integer DEFAULT 0,
  last_fetched timestamptz DEFAULT now()
);

-- Table: bankr_dev_sells
-- Cache dev sell events per token
CREATE TABLE IF NOT EXISTS bankr_dev_sells (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  token_address text NOT NULL,
  deployer_wallet text NOT NULL,
  sell_count integer DEFAULT 0,
  total_sold text,
  pct_sold text,
  first_sell_date text,
  last_sell_date text,
  last_fetched timestamptz DEFAULT now(),
  UNIQUE(token_address, deployer_wallet)
);

-- Enable RLS
ALTER TABLE bankr_launches ENABLE ROW LEVEL SECURITY;
ALTER TABLE bankr_fees_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE bankr_dev_sells ENABLE ROW LEVEL SECURITY;

-- Allow public read (anon key can read)
CREATE POLICY "Public read bankr_launches" ON bankr_launches
  FOR SELECT USING (true);

CREATE POLICY "Public read bankr_fees_cache" ON bankr_fees_cache
  FOR SELECT USING (true);

CREATE POLICY "Public read bankr_dev_sells" ON bankr_dev_sells
  FOR SELECT USING (true);

-- Allow service role to write
CREATE POLICY "Service write bankr_launches" ON bankr_launches
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service write bankr_fees_cache" ON bankr_fees_cache
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service write bankr_dev_sells" ON bankr_dev_sells
  FOR ALL USING (auth.role() = 'service_role');
