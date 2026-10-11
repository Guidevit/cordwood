import { describe, expect, it } from "vitest";
import { cookieFrom, isCrossSiteWrite } from "./access.js";

const request = (method: string, headers: Record<string, string> = {}) =>
  new Request("http://container.internal:8080/api/things", { method, headers });

describe("a write from another site", () => {
  it.each(["GET", "HEAD", "OPTIONS"])("never refuses a %s, which changes nothing", (method) => {
    expect(isCrossSiteWrite(request(method, { "sec-fetch-site": "cross-site" }))).toBe(false);
  });

  it("takes a write the browser marks same-origin", () => {
    expect(isCrossSiteWrite(request("POST", { "sec-fetch-site": "same-origin" }))).toBe(false);
  });

  it.each(["cross-site", "same-site", "none"])("refuses a write the browser marks %s", (site) => {
    expect(isCrossSiteWrite(request("POST", { "sec-fetch-site": site }))).toBe(true);
  });

  it("takes a write whose Origin is the host the user reached", () => {
    const headers = { origin: "https://app.example.com", host: "app.example.com" };
    expect(isCrossSiteWrite(request("DELETE", headers))).toBe(false);
  });

  it("reads the forwarded host before the container's own", () => {
    const headers = {
      origin: "https://app.example.com",
      host: "container.internal:8080",
      "x-forwarded-host": "app.example.com, proxy.internal",
    };
    expect(isCrossSiteWrite(request("PUT", headers))).toBe(false);
  });

  it.each([
    ["another site's Origin", { origin: "https://evil.example.net", host: "app.example.com" }],
    ["an Origin that is no URL", { origin: "null", host: "app.example.com" }],
    ["no Origin and no Sec-Fetch-Site", { host: "app.example.com" }],
  ])("refuses a write with %s", (_case, headers) => {
    expect(isCrossSiteWrite(request("POST", headers))).toBe(true);
  });
});

describe("a cookie in the request", () => {
  const withCookies = (cookie: string) => request("GET", { cookie });

  it("is read by its name among the others", () => {
    expect(cookieFrom(withCookies("theme=dark; __session=abc.def.ghi; lang=pt"), "__session")).toBe(
      "abc.def.ghi",
    );
  });

  it("keeps an equals sign inside the value", () => {
    expect(cookieFrom(withCookies("__session=a=b=="), "__session")).toBe("a=b==");
  });

  it.each([
    ["no Cookie header", request("GET")],
    ["another cookie only", withCookies("theme=dark")],
    ["a name that only ends the same", withCookies("x__session=abc")],
    ["an empty value", withCookies("__session=")],
  ])("is undefined with %s", (_case, req) => {
    expect(cookieFrom(req, "__session")).toBeUndefined();
  });
});
