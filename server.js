const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { Pool } = require("pg");
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

  try {
    const result = await pool.query(
      `INSERT INTO events (tenant_id, event_type, properties, user_id, session_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, timestamp`,
      [req.tenantId, event, JSON.stringify(properties), userId, sessionId]
    );

    res.status(201).json({
      success: true,
      eventId: result.rows[0].id,
      timestamp: result.rows[0].timestamp,
    });
  } catch (error) {
    console.error("Track error:", error);
    res.status(500).json({ error: "Failed to track event" });
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

    for (const evt of events) {
      const result = await client.query(
        `INSERT INTO events (tenant_id, event_type, properties, user_id, session_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [
          req.tenantId,
          evt.event,
          JSON.stringify(evt.properties || {}),
          evt.userId,
          evt.sessionId,
        ]
      );
      insertedIds.push(result.rows[0].id);
    }

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

// Basic query endpoint
app.get("/events", authenticateTenant, async (req, res) => {
  const {
    event_type,
    start_date,
    end_date,
    limit = 100,
    offset = 0,
  } = req.query;

  try {
    let query = `
      SELECT id, event_type, properties, user_id, session_id, timestamp
      FROM events 
      WHERE tenant_id = $1
    `;
    const params = [req.tenantId];
    let paramIndex = 2;

    if (event_type) {
      query += ` AND event_type = $${paramIndex}`;
      params.push(event_type);
      paramIndex++;
    }

    if (start_date) {
      query += ` AND timestamp >= $${paramIndex}`;
      params.push(start_date);
      paramIndex++;
    }

    if (end_date) {
      query += ` AND timestamp <= $${paramIndex}`;
      params.push(end_date);
      paramIndex++;
    }

    query += ` ORDER BY timestamp DESC LIMIT $${paramIndex} OFFSET $${
      paramIndex + 1
    }`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    res.json({
      events: result.rows,
      count: result.rows.length,
      offset: parseInt(offset),
      limit: parseInt(limit),
    });
  } catch (error) {
    console.error("Query error:", error);
    res.status(500).json({ error: "Failed to query events" });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Analytics API running on port ${port}`);
});

module.exports = app;
