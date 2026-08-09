import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { publisherInit, publisherMain, publisherPublish, publisherRegister, publisherSign, publisherVerify, publisherWithdraw } from "./publisher.mjs";
import { failureEnvelope } from "../cli-contract.mjs";

let root;
let useful;
let publisher;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "useful-publisher-"));
  publisher = publisherInit(path.join(root, "publisher"), {
    id: "com.example.preview",
    name: "Preview Publisher",
  });
  const zip = new AdmZip();
  zip.addFile(
    "manifest.json",
    Buffer.from(JSON.stringify({
      schemaVersion: 1,
      id: "com.example.preview-tool",
      name: "Preview Tool",
      version: "1.0.0",
      description: "test",
      entry: { type: "web", path: "index.html" },
      permissions: [],
      platforms: ["windows-x64"],
      minHostVersion: "0.1.0",
    })),
  );
  zip.addFile("index.html", Buffer.from("<!doctype html><title>Preview</title>"));
  useful = path.join(root, "preview.useful");
  zip.writeZip(useful);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("publisher signing", () => {
  it("uses the Useful default publisher display name", () => {
    const defaultPublisher = publisherInit(path.join(root, "default-publisher"));
    expect(defaultPublisher.displayName).toBe("Useful Preview Publisher");
    expect(JSON.parse(fs.readFileSync(path.join(defaultPublisher.dir, "publisher.json"), "utf8")).displayName).toBe("Useful Preview Publisher");
  });

  it("init -> sign -> verify binds publisher, tool, version, digest, and size", () => {
    const signed = publisherSign(useful, publisher.privatePath);
    const verified = publisherVerify(useful, signed.path);
    expect(verified.valid).toBe(true);
    expect(verified.publisherKeyId).toBe(publisher.keyId);
    expect(verified.toolId).toBe("com.example.preview-tool");
    expect(verified.version).toBe("1.0.0");
  });

  it("tampered package is rejected", () => {
    const signed = publisherSign(useful, publisher.privatePath);
    fs.appendFileSync(useful, "tamper");
    expect(() => publisherVerify(useful, signed.path)).toThrow(/摘要或大小不一致/);
  });

  it("crafted oversized ZIP entry is rejected before allocation", () => {
    const bytes = fs.readFileSync(useful);
    const centralHeader = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(centralHeader).toBeGreaterThanOrEqual(0);
    bytes.writeUInt32LE(0xffff_ffff, centralHeader + 24);
    fs.writeFileSync(useful, bytes);
    expect(() => publisherSign(useful, publisher.privatePath)).toThrow();
  });

  it("rejects removed native web-plugin permissions before signing", () => {
    const archive = new AdmZip(useful);
    const manifest = JSON.parse(archive.readAsText("manifest.json"));
    manifest.permissions = ["dialog.open"];
    archive.updateFile("manifest.json", Buffer.from(JSON.stringify(manifest)));
    archive.writeZip(useful);
    expect(() => publisherSign(useful, publisher.privatePath)).toThrow();
  });

  it("sidecar identity substitution is rejected", () => {
    const signed = publisherSign(useful, publisher.privatePath);
    const receipt = JSON.parse(fs.readFileSync(signed.path, "utf8"));
    receipt.toolId = "com.attacker.other";
    fs.writeFileSync(signed.path, JSON.stringify(receipt));
    expect(() => publisherVerify(useful, signed.path)).toThrow(/身份与包不一致/);
  });

  it("withdraw sends a JSON reason body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ status: "withdrawn" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    await expect(publisherWithdraw("release-1", {
      server: "http://127.0.0.1:8080",
      "admin-token": "test-token",
      reason: "superseded",
    })).resolves.toEqual({ status: "withdrawn" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/v1/publisher/releases/release-1/withdraw",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ reason: "superseded" }),
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
  });

  it("never includes a server-echoed token in the visible failure envelope", async () => {
    const secret = "literal-secret-token-value";
    const publisherFile = path.join(root, "publisher.json");
    fs.writeFileSync(publisherFile, JSON.stringify({ id: "com.example.preview", displayName: "Preview", keyId: publisher.keyId }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      `upstream rejected token ${secret}`,
      { status: 401, headers: { "Content-Type": "text/plain" } },
    )));
    let caught;
    try {
      await publisherRegister(publisherFile, {
        server: "http://127.0.0.1:8080",
        token: secret,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const visible = JSON.stringify(failureEnvelope("publisher register", caught));
    expect(visible).not.toContain(secret);
    expect(visible).not.toContain("upstream rejected token");
    expect(visible).toContain("HTTP 401");
  });

  it("redacts an exact credential echoed in a successful JSON response", async () => {
    const secret = "successful-echo-secret";
    const publisherFile = path.join(root, "publisher.json");
    fs.writeFileSync(publisherFile, JSON.stringify({ id: "com.example.preview", displayName: "Preview", keyId: publisher.keyId }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ keyId: publisher.keyId, note: `accepted ${secret}` }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    await publisherMain([
      "register",
      publisherFile,
      "--server",
      "http://127.0.0.1:8080",
      "--token",
      secret,
      "--json",
    ]);
    expect(output).not.toContain(secret);
    expect(JSON.parse(output).data.note).toBe("accepted [REDACTED]");
  });

  it("publish sends entitlement offer fields without putting them in the package", async () => {
    const archive = new AdmZip(useful);
    const manifest = JSON.parse(archive.readAsText("manifest.json"));
    delete manifest.description;
    archive.updateFile("manifest.json", Buffer.from(JSON.stringify(manifest)));
    archive.writeZip(useful);
    const signed = publisherSign(useful, publisher.privatePath);
    const responses = [
      { uploadSessionId: "up-1", uploadUrl: "/v1/publisher/upload-sessions/up-1/content" },
      { status: "completed" },
      { id: "release-1", status: "published", publisherSignatureVerified: true },
    ];
    const fetchMock = vi.fn().mockImplementation(async () => new Response(
      JSON.stringify(responses.shift()),
      { status: responses.length === 2 ? 201 : 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await publisherPublish(useful, signed.path, {
      server: "http://127.0.0.1:8080",
      "admin-token": "test-token",
      "access-mode": "entitlement",
      "product-id": "developer-pro",
      "wait-seconds": 0,
    });

    const releaseRequest = fetchMock.mock.calls[2][1];
    expect(JSON.parse(releaseRequest.body)).toEqual(expect.objectContaining({
      accessMode: "entitlement",
      productId: "developer-pro",
      summary: "Useful Developer Preview tool",
    }));
    expect(JSON.parse(new AdmZip(useful).readAsText("manifest.json"))).not.toHaveProperty("accessMode");
  });
});
