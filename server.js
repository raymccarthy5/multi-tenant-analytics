const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { Pool } = require("pg");
const OpenSearchService = require("./opensearch-service");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

// Database connection
const pool = new Pool({
  user: process.env.DB_USER || "postgres",
  host: process.env.DB_HOST || "localhost",
  database: process.env.DB_NAME || "analytics",
  password: process.env.DB_PASSWORD || "password",
  port: process.env.DB_PORT || 5432,
});

// OpenSearch connection
const opensearch = new OpenSearchService({
  host: process.env.OPENSEARCH_HOST || "localhost",
  port: process.env.OPENSEARCH_PORT || 9200,
  indexPrefix: "analytics",
});

// Initialize OpenSearch on startup
opensearch.initialize().catch(console.error);

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Auth middleware - extracts tenant from API key
const authenticateTenant = async (req, res, next) => {
  const apiKey = req.headers["x-api-key"];

  if (!apiKey) {
    return res.status(401).json({ error: "API key required" });
  }

  try {
    const result = await pool.query(
      "SELECT id FROM tenants WHERE api_key = $1",
      [apiKey]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid API key" });
    }

    req.tenantId = result.rows[0].id;
    next();
  } catch (error) {
    console.error("Auth error:", error);
    res.status(500).json({ error: "Authentication failed" });
  }
};

// Routes
app.get("/health", (req, res) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

// Track event endpoint
app.post("/track", authenticateTenant, async (req, res) => {
  const { event, properties = {}, userId, sessionId } = req.body;

  if (!event) {
    return res.status(400).json({ error: "Event name required" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Store in PostgreSQL
    const pgResult = await client.query(
      `INSERT INTO events (tenant_id, event_type, properties, user_id, session_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, timestamp`,
      [req.tenantId, event, JSON.stringify(properties), userId, sessionId]
    );

    // Index in OpenSearch for real-time analytics
    await opensearch.indexEvent(req.tenantId, {
      event_type: event,
      properties,
      user_id: userId,
      session_id: sessionId,
      timestamp: pgResult.rows[0].timestamp,
    });

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      eventId: pgResult.rows[0].id,
      timestamp: pgResult.rows[0].timestamp,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Track error:", error);
    res.status(500).json({ error: "Failed to track event" });
  } finally {
    client.release();
  }
});

// Batch track endpoint
app.post("/track/batch", authenticateTenant, async (req, res) => {
  const { events } = req.body;

  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: "Events array required" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const insertedIds = [];
    const opensearchEvents = [];

    for (const evt of events) {
      const result = await client.query(
        `INSERT INTO events (tenant_id, event_type, properties, user_id, session_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, timestamp`,
        [
          req.tenantId,
          evt.event,
          JSON.stringify(evt.properties || {}),
          evt.userId,
          evt.sessionId,
        ]
      );

      insertedIds.push(result.rows[0].id);
      opensearchEvents.push({
        event_type: evt.event,
        properties: evt.properties || {},
        user_id: evt.userId,
        session_id: evt.sessionId,
        timestamp: result.rows[0].timestamp,
      });
    }

    // Bulk index to OpenSearch
    await opensearch.bulkIndexEvents(req.tenantId, opensearchEvents);

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      eventIds: insertedIds,
      count: insertedIds.length,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Batch track error:", error);
    res.status(500).json({ error: "Failed to track events" });
  } finally {
    client.release();
  }
});

// Basic query endpoint (now using OpenSearch for better performance)
app.get("/events", authenticateTenant, async (req, res) => {
  try {
    const result = await opensearch.searchEvents(req.tenantId, {
      eventType: req.query.event_type,
      userId: req.query.user_id,
      startDate: req.query.start_date,
      endDate: req.query.end_date,
      limit: parseInt(req.query.limit) || 100,
      offset: parseInt(req.query.offset) || 0,
      properties: req.query.properties
        ? JSON.parse(req.query.properties)
        : undefined,
    });

    res.json({
      events: result.events,
      total: result.total,
      count: result.events.length,
      took: result.took,
    });
  } catch (error) {
    console.error("Query error:", error);
    res.status(500).json({ error: "Failed to query events" });
  }
});

// Analytics dashboard endpoint
app.get("/analytics", authenticateTenant, async (req, res) => {
  try {
    const analytics = await opensearch.getAnalytics(req.tenantId, {
      startDate: req.query.start_date,
      endDate: req.query.end_date,
      interval: req.query.interval || "day",
    });

    res.json(analytics);
  } catch (error) {
    console.error("Analytics error:", error);
    res.status(500).json({ error: "Failed to get analytics" });
  }
});

// Funnel analysis endpoint
app.post("/analytics/funnel", authenticateTenant, async (req, res) => {
  const { events, timeWindow = "7d" } = req.body;

  if (!Array.isArray(events) || events.length === 0) {
    return res
      .status(400)
      .json({ error: "Events array required for funnel analysis" });
  }

  try {
    const funnel = await opensearch.getFunnelAnalysis(
      req.tenantId,
      events,
      timeWindow
    );
    res.json(funnel);
  } catch (error) {
    console.error("Funnel error:", error);
    res.status(500).json({ error: "Failed to analyze funnel" });
  }
});

// OpenSearch health check
app.get("/opensearch/health", async (req, res) => {
  try {
    const health = await opensearch.health();
    res.json(health);
  } catch (error) {
    res.status(500).json({ error: "OpenSearch unhealthy" });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Analytics API running on port ${port}`);
});

module.exports = app;
