import { describe, expect, it } from "vitest";
import { isPrivateAddress, judgeAddresses, judgeUrl } from "./extraction/destination.ts";

/**
 * The destination rules, tested as pure functions. Every case here is a URL
 * the installation must never request, or one it must; the fetch tests then
 * prove the same rules are applied per hop.
 */
describe("network destination bounds", () => {
  it("refuses every scheme that is not http or https", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/catalogue.xml",
      "gopher://example.com/",
      "data:text/html,<h1>x</h1>",
      "javascript:alert(1)",
      "ws://example.com/socket",
    ]) {
      expect(judgeUrl(new URL(url))?.reason, url).toBe("scheme");
    }
  });

  it("refuses a URL that carries credentials, so nothing is sent as a login", () => {
    expect(judgeUrl(new URL("https://shopper:secret@shop.example/product"))?.reason).toBe(
      "credentials",
    );
  });

  it("refuses a port that is not a web port", () => {
    for (const url of [
      "http://shop.example:6379/",
      "http://shop.example:22/",
      "http://shop.example:5432/",
      "https://shop.example:8443/",
    ]) {
      expect(judgeUrl(new URL(url))?.reason, url).toBe("port");
    }
    // The scheme's own ports, written out or left out, are permitted.
    expect(judgeUrl(new URL("http://shop.example:80/"))).toBeUndefined();
    expect(judgeUrl(new URL("https://shop.example:443/"))).toBeUndefined();
    expect(judgeUrl(new URL("https://shop.example/product"))).toBeUndefined();
  });

  it("refuses the loopback, private, link-local, and carrier-grade NAT ranges", () => {
    for (const address of [
      "127.0.0.1",
      "127.255.255.254",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "255.255.255.255",
      "224.0.0.1",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    // The public neighbours of those ranges are still public.
    for (const address of ["8.8.8.8", "172.32.0.1", "192.169.0.1", "100.128.0.1", "1.1.1.1"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("refuses IPv6 loopback, link-local, unique-local, and every IPv6 spelling of IPv4", () => {
    for (const address of [
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "::127.0.0.1",
      "64:ff9b::10.0.0.1",
      "2002:7f00:1::1",
      "2001:db8::1",
      "fe80::1%eth0",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("refuses localhost, container names, and the internal suffixes", () => {
    for (const url of [
      "http://localhost/",
      "http://LOCALHOST:8080/",
      "http://db/",
      "http://searxng/",
      "http://shop.internal/",
      "http://printer.local/",
      "http://anything.localhost/",
      "http://metadata.google.internal/",
    ]) {
      const refusal = judgeUrl(new URL(url));
      expect(refusal, url).toBeDefined();
      expect(["host", "port"], url).toContain(refusal?.reason);
    }
  });

  it("refuses an address written as a name, in every numeric spelling", () => {
    for (const url of [
      "http://2130706433/",
      "http://0x7f000001/",
      "http://0177.0.0.1/",
      "http://127.1/",
    ]) {
      const refusal = judgeUrl(new URL(url));
      expect(refusal, url).toBeDefined();
    }
  });

  it("refuses a host that resolves into a private range, even when the name is public", () => {
    // The classic SSRF: a name that looks public and answers with a private
    // address. The name passes, the answer does not.
    expect(judgeUrl(new URL("https://shop.example/product"))).toBeUndefined();
    expect(judgeAddresses(["169.254.169.254"])).toEqual({
      target: "169.254.169.254",
      reason: "address",
    });
    expect(judgeAddresses(["93.184.216.34"])).toBeUndefined();
    // One public answer among private ones is still a refusal: the socket
    // could take either.
    expect(judgeAddresses(["93.184.216.34", "127.0.0.1"])).toEqual({
      target: "127.0.0.1",
      reason: "address",
    });
  });

  it("permits an ordinary public product URL", () => {
    expect(judgeUrl(new URL("https://www.shop.example/en/product/bike-helmet-123"))).toBeUndefined();
  });
});
