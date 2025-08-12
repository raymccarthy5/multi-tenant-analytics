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

// Auth middleware - extracts tenant from API key (header or query param)
const authenticateTenant = async (req, res, next) => {
  const apiKey = req.headers["x-api-key"] || req.query.api_key;

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

    // Broadcast to real-time dashboard
    const eventForBroadcast = {
      id: pgResult.rows[0].id,
      event_type: event,
      properties,
      user_id: userId,
      session_id: sessionId,
      timestamp: pgResult.rows[0].timestamp,
    };

    broadcastEvent(req.tenantId, eventForBroadcast);

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

    // Broadcast each event to real-time dashboard
    opensearchEvents.forEach((evt, index) => {
      broadcastEvent(req.tenantId, {
        id: insertedIds[index],
        event_type: evt.event_type,
        properties: evt.properties,
        user_id: evt.user_id,
        session_id: evt.session_id,
        timestamp: evt.timestamp,
      });
    });

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

// Real-time events stream (SSE)
app.get("/events/stream", authenticateTenant, (req, res) => {
  // Set SSE headers with proper CORS
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "http://localhost:3001",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "x-api-key, Content-Type",
  });

  // Send immediate connection confirmation
  res.write('data: {"type":"connected","message":"Stream established"}\n\n');

  // Send heartbeat every 30 seconds
  const heartbeat = setInterval(() => {
    try {
      res.write(
        'data: {"type":"heartbeat","timestamp":"' +
          new Date().toISOString() +
          '"}\n\n'
      );
    } catch (error) {
      clearInterval(heartbeat);
    }
  }, 30000);

  // Store connection for broadcasting
  const connectionId = Date.now() + Math.random();
  if (!global.sseConnections) global.sseConnections = new Map();
  global.sseConnections.set(connectionId, { res, tenantId: req.tenantId });

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(heartbeat);
    global.sseConnections.delete(connectionId);
    console.log("SSE client disconnected:", connectionId);
  });

  req.on("error", () => {
    clearInterval(heartbeat);
    global.sseConnections.delete(connectionId);
  });

  console.log(
    "SSE client connected:",
    connectionId,
    "for tenant:",
    req.tenantId
  );
});

// Broadcast new events to SSE connections
function broadcastEvent(tenantId, eventData) {
  if (!global.sseConnections) return;

  let broadcastCount = 0;
  global.sseConnections.forEach((conn, id) => {
    if (conn.tenantId === tenantId) {
      try {
        const message = `data: ${JSON.stringify({
          type: "event",
          data: eventData,
        })}\n\n`;
        conn.res.write(message);
        broadcastCount++;
      } catch (error) {
        console.error("Broadcast error to connection", id, error.message);
        global.sseConnections.delete(id);
      }
    }
  });
}

// Usage metrics endpoint
app.get("/analytics/usage", authenticateTenant, async (req, res) => {
  const days = parseInt(req.query.days) || 30;

  try {
    const analytics = await opensearch.getAnalytics(req.tenantId, {
      startDate: `now-${days}d`,
      endDate: "now",
      interval: days > 7 ? "day" : "hour",
    });

    // Calculate growth rate
    const events = analytics.events_over_time;
    const midPoint = Math.floor(events.length / 2);
    const firstHalf = events
      .slice(0, midPoint)
      .reduce((sum, item) => sum + item.count, 0);
    const secondHalf = events
      .slice(midPoint)
      .reduce((sum, item) => sum + item.count, 0);
    const growthRate =
      firstHalf > 0
        ? (((secondHalf - firstHalf) / firstHalf) * 100).toFixed(1)
        : 0;

    res.json({
      ...analytics,
      growth_rate: parseFloat(growthRate),
      period_days: days,
    });
  } catch (error) {
    console.error("Usage analytics error:", error);
    res.status(500).json({ error: "Failed to get usage analytics" });
  }
});

// Dashboard config endpoint
app.get("/dashboard/config", authenticateTenant, async (req, res) => {
  try {
    // Get tenant info
    const tenantResult = await pool.query(
      "SELECT name FROM tenants WHERE id = $1",
      [req.tenantId]
    );

    // Get recent activity summary
    const analytics = await opensearch.getAnalytics(req.tenantId, {
      startDate: "now-24h",
      endDate: "now",
    });

    res.json({
      tenant: {
        id: req.tenantId,
        name: tenantResult.rows[0]?.name || "Unknown",
      },
      last_24h: {
        total_events: analytics.total_events,
        unique_users: analytics.unique_users,
        top_event: analytics.top_events[0]?.event || null,
      },
    });
  } catch (error) {
    console.error("Dashboard config error:", error);
    res.status(500).json({ error: "Failed to get dashboard config" });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Analytics API running on port ${port}`);
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

module.exports = app;
