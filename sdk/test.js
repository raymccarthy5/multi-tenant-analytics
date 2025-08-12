const Analytics = require("./index.js");

async function testSDK() {
  const analytics = new Analytics({
    apiKey: "test-api-key-123",
    batchSize: 3,
    flushInterval: 5000,
  });

  console.log("🚀 Testing Analytics SDK...\n");

  try {
    // Test health check
    console.log("1. Health Check:");
    const health = await analytics.ping();
    console.log("✅", health);

    // Test individual tracking
    console.log("\n2. Individual Event:");
    const trackResult = await analytics.track(
      "sdk_test",
      {
        version: "1.0.0",
        environment: "test",
      },
      {
        userId: "sdk-user-123",
        enableBatching: false,
      }
    );
    console.log("✅", trackResult);

    // Test convenience methods
    console.log("\n3. Page View:");
    const pageResult = await analytics.page(
      "/test-page",
      {
        referrer: "google.com",
      },
      { userId: "sdk-user-123" }
    );
    console.log("✅ Queued:", pageResult);

    console.log("\n4. User Identify:");
    const identifyResult = await analytics.identify("sdk-user-123", {
      email: "test@sdk.com",
      plan: "premium",
    });
    console.log("✅ Queued:", identifyResult);

    // Test batching
    console.log("\n5. Batch Events:");
    await analytics.track("button_click", { button: "signup" });
    await analytics.track("form_submit", { form: "contact" });
    console.log("✅ Events queued, waiting for auto-flush...");

    // Wait for auto-flush
    setTimeout(async () => {
      console.log("\n6. Manual Flush:");
      const flushResult = await analytics.flush();
      console.log("✅", flushResult);

      // Test querying
      console.log("\n7. Query Events:");
      const queryResult = await analytics.query({
        eventType: "sdk_test",
        limit: 5,
      });
      console.log("✅ Found events:", queryResult.count);

      // Cleanup
      await analytics.shutdown();
      console.log("\n🎉 SDK Test Complete!");
    }, 2000);
  } catch (error) {
    console.error("❌ Test failed:", error.message);
  }
}

testSDK();
