const axios = require("axios");

class Analytics {
  constructor(options = {}) {
    this.apiKey = options.apiKey;
    this.baseURL = options.baseURL || "http://localhost:3000";
    this.timeout = options.timeout || 5000;
    this.batchSize = options.batchSize || 100;
    this.flushInterval = options.flushInterval || 10000; // 10 seconds

    // Event queue for batching
    this.eventQueue = [];
    this.batchTimer = null;

    // HTTP client
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: this.timeout,
      headers: {
        "x-api-key": this.apiKey,
        "Content-Type": "application/json",
      },
    });

    if (!this.apiKey) {
      throw new Error("API key is required");
    }

    // Start auto-flush timer if batching is enabled
    if (options.enableBatching !== false) {
      this.startBatchTimer();
    }
  }

  /**
   * Track a single event
   * @param {string} event - Event name
   * @param {object} properties - Event properties
   * @param {object} options - Additional options (userId, sessionId)
   */
  async track(event, properties = {}, options = {}) {
    const eventData = {
      event,
      properties,
      userId: options.userId,
      sessionId: options.sessionId,
      timestamp: new Date().toISOString(),
    };

    if (options.enableBatching === false) {
      // Send immediately
      return this.sendEvent(eventData);
    } else {
      // Add to batch queue
      this.eventQueue.push(eventData);

      // Flush if batch is full
      if (this.eventQueue.length >= this.batchSize) {
        await this.flush();
      }

      return { queued: true, queueSize: this.eventQueue.length };
    }
  }

  /**
   * Send single event immediately
   */
  async sendEvent(eventData) {
    try {
      const response = await this.client.post("/track", eventData);
      return response.data;
    } catch (error) {
      this.handleError("track", error);
      throw error;
    }
  }

  /**
   * Flush all queued events
   */
  async flush() {
    if (this.eventQueue.length === 0) {
      return { success: true, count: 0 };
    }

    const events = [...this.eventQueue];
    this.eventQueue = [];

    try {
      const response = await this.client.post("/track/batch", { events });
      return response.data;
    } catch (error) {
      // Re-queue events on failure
      this.eventQueue.unshift(...events);
      this.handleError("flush", error);
      throw error;
    }
  }

  /**
   * Query events
   * @param {object} options - Query parameters
   */
  async query(options = {}) {
    try {
      const params = new URLSearchParams();

      if (options.eventType) params.append("event_type", options.eventType);
      if (options.startDate) params.append("start_date", options.startDate);
      if (options.endDate) params.append("end_date", options.endDate);
      if (options.limit) params.append("limit", options.limit);
      if (options.offset) params.append("offset", options.offset);

      const response = await this.client.get(`/events?${params}`);
      return response.data;
    } catch (error) {
      this.handleError("query", error);
      throw error;
    }
  }

  /**
   * Identify a user (track user properties)
   */
  async identify(userId, traits = {}) {
    return this.track(
      "user_identify",
      {
        userId,
        traits,
        ...traits, // Flatten traits for easier querying
      },
      { userId }
    );
  }

  /**
   * Track page view
   */
  async page(name, properties = {}, options = {}) {
    return this.track(
      "page_view",
      {
        page: name,
        ...properties,
      },
      options
    );
  }

  /**
   * Start batch timer
   */
  startBatchTimer() {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
    }

    this.batchTimer = setInterval(async () => {
      if (this.eventQueue.length > 0) {
        try {
          await this.flush();
        } catch (error) {
          // Silent fail for auto-flush
          console.warn("Analytics auto-flush failed:", error.message);
        }
      }
    }, this.flushInterval);
  }

  /**
   * Stop batch timer and flush remaining events
   */
  async shutdown() {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }

    if (this.eventQueue.length > 0) {
      await this.flush();
    }
  }

  /**
   * Error handler
   */
  handleError(operation, error) {
    const errorMessage = error.response?.data?.error || error.message;
    console.error(`Analytics ${operation} error:`, errorMessage);

    // Emit error event if running in browser
    if (typeof window !== "undefined" && window.dispatchEvent) {
      window.dispatchEvent(
        new CustomEvent("analytics-error", {
          detail: { operation, error: errorMessage },
        })
      );
    }
  }

  /**
   * Health check
   */
  async ping() {
    try {
      const response = await this.client.get("/health");
      return response.data;
    } catch (error) {
      this.handleError("ping", error);
      throw error;
    }
  }
}

module.exports = Analytics;
