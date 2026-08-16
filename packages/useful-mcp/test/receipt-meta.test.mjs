import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { test } from "node:test";
import { buildServer, MCP_RECEIPT_META_KEY } from "../src/server.mjs";

test("official MCP 2.0.0 protocol preserves receipt _meta without changing action outputSchema", async () => {
  const server = buildServer();
  const client = new Client({ name: "useful-receipt-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    assert.equal(client.getProtocolEra(), "legacy");
    const listed = await client.listTools();
    const hash = listed.tools.find((tool) => tool.name === "builtin.utilities.hash");
    assert.ok(hash);
    assert.equal("receipt" in hash.outputSchema.properties, false);
    assert.deepEqual(Object.keys(hash.outputSchema.properties).sort(), ["algorithm", "digest", "encoding"]);

    const result = await client.callTool({
      name: "builtin.utilities.hash",
      arguments: { algorithm: "SHA-256", text: "TOP_SECRET_MCP_INPUT" },
    });
    assert.deepEqual(result.structuredContent, {
      algorithm: "SHA-256",
      digest: "f030fd7bc46795b4bf366bf4ae86d9e7600de83430bdf4b8781f5d71afd3863b",
      encoding: "hex",
    });
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.equal("receipt" in result.structuredContent, false);
    assert.equal(result._meta[MCP_RECEIPT_META_KEY].receiptVersion, "2.0");
    assert.equal(result._meta[MCP_RECEIPT_META_KEY].status, "success");
    assert.equal(JSON.stringify(result._meta).includes("TOP_SECRET"), false);
  } finally {
    await client.close();
    await server.close();
  }
});
