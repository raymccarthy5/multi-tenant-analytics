const { Client } = require("@opensearch-project/opensearch");

class OpenSearchService {
  constructor(options = {}) {
    this.client = new Client({
      node: `http://${options.host || "localhost"}:${options.port || 9200}`,
      ssl: {
        rejectUnauthorized: false,
      },
    });
    this.indexPrefix = options.indexPrefix || "analytics";
  }

  /**
   * Initialize indices and mappings
   */
  async initialize() {
    // Create index template for events
    const eventTemplate = {
      index_patterns: [`${this.indexPrefix}-events-*`],
      template: {
        settings: {
          number_of_shards: 1,
          number_of_replicas: 0,
          "index.refresh_interval": "5s",
        },
        mappings: {
          properties: {
            tenant_id: { type: "keyword" },
            event_type: { type: "keyword" },
            user_id: { type: "keyword" },
            session_id: { type: "keyword" },
            timestamp: { type: "date" },
            properties: {
              type: "object",
              dynamic: true,
            },
            // Common property fields for better performance
            "properties.page": { type: "keyword" },
            "properties.button": { type: "keyword" },
            "properties.email": { type: "keyword" },
            "properties.plan": { type: "keyword" },
            "properties.revenue": { type: "double" },
            "properties.duration": { type: "long" },
          },
        },
      },
    };

    // Create aggregation template for daily stats
    const statsTemplate = {
      index_patterns: [`${this.indexPrefix}-stats-*`],
      template: {
        settings: {
          number_of_shards: 1,
          number_of_replicas: 0,
        },
        mappings: {
          properties: {
            tenant_id: { type: "keyword" },
            date: { type: "date", format: "yyyy-MM-dd" },
            event_type: { type: "keyword" },
            count: { type: "long" },
            unique_users: { type: "long" },
            total_revenue: { type: "double" },
            avg_duration: { type: "double" },
          },
        },
      },
    };

    try {
      await this.client.indices.putIndexTemplate({
        name: "analytics-events",
        body: eventTemplate,
      });

      await this.client.indices.putIndexTemplate({
        name: "analytics-stats",
        body: statsTemplate,
      });

      console.log("✅ OpenSearch templates created");
    } catch (error) {
      console.error("OpenSearch initialization error:", error);
      throw error;
    }
  }

  /**
   * Index an event
   */
  async indexEvent(tenantId, eventData) {
    const indexName = this.getEventIndex(tenantId);

    const document = {
      tenant_id: tenantId,
      event_type: eventData.event_type || eventData.event,
      user_id: eventData.user_id,
      session_id: eventData.session_id,
      timestamp: eventData.timestamp || new Date().toISOString(),
      properties: eventData.properties || {},
    };

    try {
      const response = await this.client.index({
        index: indexName,
        body: document,
      });
      return response.body;
    } catch (error) {
      console.error("OpenSearch indexing error:", error);
      throw error;
    }
  }

  /**
   * Bulk index events
   */
  async bulkIndexEvents(tenantId, events) {
    const indexName = this.getEventIndex(tenantId);
    const body = [];

    events.forEach((eventData) => {
      body.push({ index: { _index: indexName } });
      body.push({
        tenant_id: tenantId,
        event_type: eventData.event_type || eventData.event,
        user_id: eventData.user_id,
        session_id: eventData.session_id,
        timestamp: eventData.timestamp || new Date().toISOString(),
        properties: eventData.properties || {},
      });
    });

    try {
      const response = await this.client.bulk({ body });
      return response.body;
    } catch (error) {
      console.error("OpenSearch bulk indexing error:", error);
      throw error;
    }
  }

  /**
   * Search events with advanced filtering
   */
  async searchEvents(tenantId, query = {}) {
    const indexName = this.getEventIndex(tenantId);

    const searchBody = {
      query: {
        bool: {
          must: [{ term: { tenant_id: tenantId } }],
        },
      },
      sort: [{ timestamp: { order: "desc" } }],
      size: query.limit || 100,
      from: query.offset || 0,
    };

    // Add filters
    if (query.eventType) {
      searchBody.query.bool.must.push({
        term: { event_type: query.eventType },
      });
    }

    if (query.userId) {
      searchBody.query.bool.must.push({
        term: { user_id: query.userId },
      });
    }

    if (query.startDate || query.endDate) {
      const dateRange = {};
      if (query.startDate) dateRange.gte = query.startDate;
      if (query.endDate) dateRange.lte = query.endDate;

      searchBody.query.bool.must.push({
        range: { timestamp: dateRange },
      });
    }

    // Property filters
    if (query.properties) {
      Object.entries(query.properties).forEach(([key, value]) => {
        searchBody.query.bool.must.push({
          term: { [`properties.${key}`]: value },
        });
      });
    }

    try {
      const response = await this.client.search({
        index: indexName,
        body: searchBody,
      });

      return {
        events: response.body.hits.hits.map((hit) => hit._source),
        total: response.body.hits.total.value,
        took: response.body.took,
      };
    } catch (error) {
      console.error("OpenSearch search error:", error);
      throw error;
    }
  }

  /**
   * Get event analytics/aggregations
   */
  async getAnalytics(tenantId, query = {}) {
    const indexName = this.getEventIndex(tenantId);

    const searchBody = {
      query: {
        bool: {
          must: [{ term: { tenant_id: tenantId } }],
        },
      },
      size: 0, // Only aggregations
      aggs: {
        events_over_time: {
          date_histogram: {
            field: "timestamp",
            calendar_interval: query.interval || "day",
            min_doc_count: 0,
          },
        },
        top_events: {
          terms: {
            field: "event_type",
            size: 20,
          },
        },
        unique_users: {
          cardinality: {
            field: "user_id",
          },
        },
      },
    };

    // Add date range
    if (query.startDate || query.endDate) {
      const dateRange = {};
      if (query.startDate) dateRange.gte = query.startDate;
      if (query.endDate) dateRange.lte = query.endDate;

      searchBody.query.bool.must.push({
        range: { timestamp: dateRange },
      });
    }

    try {
      const response = await this.client.search({
        index: indexName,
        body: searchBody,
      });

      const aggs = response.body.aggregations;

      return {
        total_events: response.body.hits.total.value,
        unique_users: aggs.unique_users.value,
        events_over_time: aggs.events_over_time.buckets.map((bucket) => ({
          date: bucket.key_as_string,
          count: bucket.doc_count,
        })),
        top_events: aggs.top_events.buckets.map((bucket) => ({
          event: bucket.key,
          count: bucket.doc_count,
        })),
      };
    } catch (error) {
      console.error("OpenSearch analytics error:", error);
      throw error;
    }
  }

  /**
   * Get funnel analysis
   */
  async getFunnelAnalysis(tenantId, events, timeWindow = "1d") {
    const indexName = this.getEventIndex(tenantId);

    // Get counts for each event type separately
    const results = [];

    try {
      for (let i = 0; i < events.length; i++) {
        const event = events[i];

        const searchBody = {
          query: {
            bool: {
              must: [
                { term: { tenant_id: tenantId } },
                { term: { event_type: event } },
                { range: { timestamp: { gte: `now-${timeWindow}` } } },
              ],
            },
          },
          size: 0,
          aggs: {
            unique_users: {
              cardinality: {
                field: "user_id",
              },
            },
          },
        };

        const response = await this.client.search({
          index: indexName,
          body: searchBody,
        });

        const count = response.body.hits.total.value;
        const uniqueUsers = response.body.aggregations.unique_users.value;

        results.push({
          step: i + 1,
          event,
          count,
          unique_users: uniqueUsers,
        });
      }

      // Calculate conversion rates based on first step
      results.forEach((step, index) => {
        if (index === 0) {
          step.conversion_rate = 100;
        } else {
          step.conversion_rate =
            results[0].count > 0
              ? ((step.count / results[0].count) * 100).toFixed(2)
              : 0;
        }
      });

      return { funnel: results };
    } catch (error) {
      console.error("OpenSearch funnel error:", error);
      throw error;
    }
  }

  /**
   * Health check
   */
  async health() {
    try {
      const response = await this.client.cluster.health();
      return response.body;
    } catch (error) {
      console.error("OpenSearch health error:", error);
      throw error;
    }
  }

  /**
   * Get index name for tenant events
   */
  getEventIndex(tenantId) {
    const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    return `${this.indexPrefix}-events-${tenantId}-${date}`;
  }

  /**
   * Get stats index name
   */
  getStatsIndex(date) {
    return `${this.indexPrefix}-stats-${date}`;
  }
}

module.exports = OpenSearchService;
