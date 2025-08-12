-- Multi-Tenant Analytics Database Schema

-- Tenants table
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  api_key VARCHAR(64) UNIQUE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Events table with tenant partitioning
CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  event_type VARCHAR(100) NOT NULL,
  properties JSONB DEFAULT '{}',
  user_id VARCHAR(255),
  session_id VARCHAR(255),
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Partition by tenant_id for isolation
CREATE INDEX idx_events_tenant_id ON events(tenant_id);
CREATE INDEX idx_events_timestamp ON events(timestamp);
CREATE INDEX idx_events_type ON events(event_type);
CREATE INDEX idx_events_user ON events(user_id);

-- Daily aggregations table
CREATE TABLE daily_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  date DATE NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  count INTEGER DEFAULT 0,
  unique_users INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(tenant_id, date, event_type)
);

CREATE INDEX idx_daily_stats_tenant_date ON daily_stats(tenant_id, date);

-- API keys for authentication
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  key_hash VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(100),
  permissions JSONB DEFAULT '["track", "query"]',
  last_used TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Seed data for testing
INSERT INTO tenants (name, api_key) VALUES 
('Test Company', 'test-api-key-123'),
('Demo Corp', 'demo-api-key-456');